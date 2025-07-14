const vision = require('@google-cloud/vision');
const { GoogleAuth } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');

/**
 * Enhanced OCR Inpainting Service with Private GCS Support and Detail Restoration
 * Complete workflow: Download -> Process -> Upload all in processImageWithAutoFieldDetection
 */
class StreamlinedOCRInpaintingService {
    constructor() {
        this.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
        this.keyFilePath = process.env.GOOGLE_CLOUD_KEY_FILE_PATH;
        this.geminiApiKey = process.env.GEMINI_API_KEY;
        
        if (!this.projectId || !this.keyFilePath) {
            console.warn('Google Cloud credentials not properly configured.');
        }

        if (!this.geminiApiKey) {
            console.warn('Gemini API key not configured. Set GEMINI_API_KEY environment variable.');
        }

        // Initialize Google Cloud Storage with private bucket support
        this.storage = new Storage({
            projectId: this.projectId,
            keyFilename: this.keyFilePath,
            // Enable private bucket access
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        this.inputBucket = process.env.GCS_INPUT_BUCKET || 'default-input-bucket';
        this.outputBucket = process.env.GCS_OUTPUT_BUCKET || 'default-output-bucket';

        this.visionClient = new vision.ImageAnnotatorClient({
            keyFilename: this.keyFilePath
        });
        
        this.auth = new GoogleAuth({
            keyFile: this.keyFilePath,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        // Initialize Gemini
        this.genAI = new GoogleGenerativeAI(this.geminiApiKey);
        this.geminiModel = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Define standard fields to auto-detect with Hindi translations
        this.STANDARD_FIELDS = [
            {
                fieldType: 'manufacturing_date',
                commonVariations: ['MFG DATE', 'MFG DT', 'MFG.DATE', 'MFG.DT', 'MFGDATE', 'MANUFACTURING DATE', 'MANUFACTURE DATE', 'MANUFACTURED ON', 'MFD', 'MFG', 'PROD DATE', 'PRODUCTION DATE'],
                hindiVariations: ['उत्पादन तिथि', 'निर्माण तिथि', 'बनाने की तिथि', 'उत्पादन दिनांक', 'निर्माण दिनांक']
            },
            {
                fieldType: 'expiry_date',
                commonVariations: ['EXP DATE', 'EXP DT', 'EXP.DATE', 'EXP.DT', 'EXPDATE', 'EXPIRY DATE', 'EXPIRE DATE', 'EXPIRES ON', 'EXP', 'BEST BEFORE', 'USE BY', 'VALID UNTIL'],
                hindiVariations: ['समाप्ति तिथि', 'एक्सपायरी डेट', 'समाप्ति दिनांक', 'उपयोग करने की अंतिम तिथि', 'अवधि समाप्ति']
            },
            {
                fieldType: 'batch_number',
                commonVariations: ['BATCH NO', 'BATCH NO.', 'BATCH NUMBER', 'B.NO', 'B.NO.', 'BNO', 'BATCH', 'LOT NO', 'LOT NO.', 'LOT NUMBER', 'LOT', 'BATCH CODE', 'LOT CODE'],
                hindiVariations: ['बैच नंबर', 'बैच संख्या', 'लॉट संख्या', 'बैच कोड', 'लॉट नंबर']
            },
            {
                fieldType: 'mrp',
                commonVariations: ['MRP', 'M.R.P', 'M.R.P.', 'MAX RETAIL PRICE', 'MAXIMUM RETAIL PRICE', 'RETAIL PRICE', 'PRICE', 'COST', 'RATE'],
                hindiVariations: ['अधिकतम खुदरा मूल्य', 'एमआरपी', 'खुदरा मूल्य', 'मूल्य', 'कीमत', 'दर']
            },
            {
                fieldType: 'pack_size',
                commonVariations: ['PACK SIZE', 'PACK', 'SIZE', 'CONTENT', 'CONTENTS', 'NET CONTENT', 'NET CONTENTS', 'NET QTY', 'QUANTITY'],
                hindiVariations: ['पैक साइज़', 'पैकेट का आकार', 'मात्रा', 'नेट मात्रा', 'कंटेंट'],
                valuePatterns: ['PER \\d+ TABLETS?', 'PER \\d+ CAPSULES?', 'PER \\d+ PILLS?', '\\d+ TABLETS?', '\\d+ CAPSULES?', '\\d+ PILLS?', '\\d+\\s*ML', '\\d+\\s*MG', '\\d+\\s*GM?', '\\d+\\s*KG', '\\d+\\s*X\\s*\\d+', 'STRIP OF \\d+', 'BOTTLE OF \\d+', 'PACK OF \\d+', 'BOX OF \\d+']
            },
            {
                fieldType: 'inclusive_of_taxes',
                commonVariations: ['INCLUSIVE OF ALL TAXES', 'INCL OF ALL TAXES', 'INCL. OF ALL TAXES', 'INCLUSIVE OF TAXES', 'INCL OF TAXES', 'INCL. OF TAXES', 'IOAT', 'I.O.A.T', 'I.O.A.T.', 'ALL TAXES INCLUDED', 'TAX INCLUSIVE', 'TAXES INCLUDED'],
                hindiVariations: ['सभी करों सहित', 'सभी कर शामिल', 'कर सहित', 'टैक्स सहित', 'सभी टैक्स शामिल']
            }
        ];

        // Add rate limiting
        this.lastGeminiCall = 0;
        this.minTimeBetweenCalls = 2000; // 2 seconds between calls
    }

    /**
     * Helper method for delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Download file from private GCS bucket
     */
    async downloadFromPrivateGCS(bucketName, fileName) {
        try {
            const bucket = this.storage.bucket(bucketName);
            const tempDir = './temp/gcs-downloads';
            
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const localPath = path.join(tempDir, `gcs_${Date.now()}_${fileName}`);
            
            console.log(`Downloading ${fileName} from private GCS bucket ${bucketName}...`);
            
            // Check if file exists before downloading
            const file = bucket.file(fileName);
            const [exists] = await file.exists();
            
            if (!exists) {
                throw new Error(`File ${fileName} does not exist in bucket ${bucketName}`);
            }
            
            // Download file with proper authentication for private buckets
            await file.download({
                destination: localPath,
                validation: 'crc32c' // Enable integrity checking
            });

            console.log(`✅ Downloaded ${fileName} from private bucket to ${localPath}`);
            return localPath;
        } catch (error) {
            console.error(`Error downloading ${fileName} from private GCS bucket:`, error);
            if (error.code === 404) {
                throw new Error(`File ${fileName} not found in bucket ${bucketName}`);
            } else if (error.code === 403) {
                throw new Error(`Access denied to bucket ${bucketName}. Check service account permissions for private buckets.`);
            }
            throw error;
        }
    }

    /**
     * Upload file to private GCS bucket with proper naming
     */
    async uploadToPrivateGCS(localPath, fileName, bucketName) {
        try {
            const bucket = this.storage.bucket(bucketName);
            
            console.log(`Uploading ${fileName} to private GCS bucket ${bucketName}...`);
            
            // Upload with proper metadata for private buckets
            const [file] = await bucket.upload(localPath, {
                destination: fileName,
                metadata: {
                    cacheControl: 'no-cache', // Disable cache for private buckets
                    metadata: {
                        uploadedAt: new Date().toISOString(),
                        processedBy: 'ocr-inpainting-service',
                        bucketType: 'private'
                    }
                },
                // Enable resumable uploads for larger files
                resumable: true,
                validation: 'crc32c' // Enable integrity checking
            });

            const gcsUrl = `gs://${bucketName}/${fileName}`;
            console.log(`✅ Uploaded ${fileName} to private bucket: ${gcsUrl}`);
            return gcsUrl;
        } catch (error) {
            console.error(`Error uploading ${fileName} to private GCS bucket:`, error);
            if (error.code === 403) {
                throw new Error(`Access denied to bucket ${bucketName}. Check service account permissions for private buckets.`);
            }
            throw error;
        }
    }

    /**
     * Generate signed URL for private bucket access (optional)
     */
    async generateSignedUrl(bucketName, fileName, expiresInMinutes = 60) {
        try {
            const bucket = this.storage.bucket(bucketName);
            const file = bucket.file(fileName);
            
            const [url] = await file.getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + expiresInMinutes * 60 * 1000
            });
            
            return url;
        } catch (error) {
            console.error(`Error generating signed URL for ${fileName}:`, error);
            return null;
        }
    }

    /**
     * MAIN CONSOLIDATED WORKFLOW: Complete GCS OCR Inpainting Pipeline with Detail Restoration
     * This function handles everything: Download -> Process -> Upload
     */
    async processImageWithAutoFieldDetection(inputFileName, options = {}) {
        const {
            inpaintPrompt = "clean background, seamless removal",
            padding = 5,
            returnOriginal = false,
            returnMask = false,
            returnHighlighted = false,
            maskChannel = 'red',
            detailFeatherRadius = 1,
            skipDetailRestoration = false,
            returnRawInpainted = false
        } = options;

        let tempFiles = [];
        
        try {
            console.log('=== Starting Complete GCS OCR Inpainting Workflow with Detail Restoration ===');
            const startTime = Date.now();
            
            // STEP 1: Download image from private input GCS bucket
            console.log(`Step 1: Downloading from private bucket ${this.inputBucket}/${inputFileName}`);
            const localImagePath = await this.downloadFromPrivateGCS(this.inputBucket, inputFileName);
            tempFiles.push(localImagePath);
            
            // STEP 2: Validate downloaded image
            console.log('Step 2: Validating downloaded image');
            const validation = await this.validateImage(localImagePath);
            if (!validation.valid) {
                throw new Error(`Invalid image: ${validation.error}`);
            }
            
            // STEP 3: Use Gemini to detect fields with distance analysis
            console.log('Step 3: Gemini field detection with distance analysis');
            const geminiFieldDetection = await this.autoDetectStandardFields(localImagePath);
            console.log('Gemini field detection result:', geminiFieldDetection);
            
            if (!geminiFieldDetection.found || !geminiFieldDetection.autoDetectedFields || geminiFieldDetection.autoDetectedFields.length === 0) {
                throw new Error('No standard fields found in the image');
            }

            // STEP 4: Perform OCR to get all text with coordinates
            console.log('Step 4: Google Vision OCR');
            const ocrResults = await this.getFullOCRResults(localImagePath);
            console.log(`OCR detected ${ocrResults.individualTexts.length} text elements`);
            
            // STEP 5: Use Gemini to select which OCR texts belong to each field based on distance
            console.log('Step 5: Gemini OCR text selection based on distance analysis');
            const geminiOCRSelection = await this.selectOCRTextsWithGemini(
                localImagePath, 
                ocrResults.individualTexts, 
                geminiFieldDetection.autoDetectedFields
            );
            console.log('Gemini OCR selection result:', geminiOCRSelection);

            if (!geminiOCRSelection.success || geminiOCRSelection.selectedFields.length === 0) {
                throw new Error('Gemini could not select appropriate OCR texts for the detected fields');
            }

            // STEP 6: Create mask based on distance analysis
            console.log('Step 6: Creating mask based on distance analysis');
            const maskPath = await this.createMaskFromGeminiSelection(localImagePath, geminiOCRSelection.selectedFields, padding);
            tempFiles.push(maskPath);
            
            // STEP 7: Create highlighted image (optional)
            let highlightedPath = null;
            console.log('Step 7: Creating highlighted image');
            highlightedPath = await this.createHighlightFromGeminiSelection(localImagePath, geminiOCRSelection.selectedFields, padding);
            tempFiles.push(highlightedPath);
            
            // STEP 8: Inpaint with 4 samples
            console.log('Step 8: Imagen 3 inpainting (4 samples)');
            const inpaintedPaths = await this.inpaintImage(localImagePath, maskPath, inpaintPrompt);
            tempFiles.push(...inpaintedPaths);
            
            // STEP 8.5: Restore original details outside mask (prevent text distortion)
            let finalImagePaths = inpaintedPaths;
            if (!skipDetailRestoration) {
                console.log('Step 8.5: Restoring original details to prevent text distortion');
                const detailRestoredPaths = await this.restoreDetailsWithPixelBlend(
                    localImagePath,
                    inpaintedPaths,
                    maskPath,
                    {
                        maskChannel: maskChannel,
                        featherRadius: detailFeatherRadius
                    }
                );
                tempFiles.push(...detailRestoredPaths);
                finalImagePaths = detailRestoredPaths;
            }
            
            // STEP 9: Upload all results to private output GCS bucket
            console.log('Step 9: Uploading results to private output bucket');
            const gcsResults = await this.uploadAllResultsToGCS(
                inputFileName,
                {
                    originalImage: localImagePath,
                    maskImage: maskPath,
                    highlightedImage: highlightedPath,
                    inpaintedImages: finalImagePaths,
                    rawInpaintedImages: returnRawInpainted ? inpaintedPaths : null
                },
                this.outputBucket,
                {
                    returnOriginal,
                    returnMask,
                    returnHighlighted,
                    returnRawInpainted
                }
            );
            
            // STEP 10: Prepare final response
            const foundTextResults = {
                autoDetectedFields: geminiFieldDetection.autoDetectedFields.map(field => ({
                    fieldType: field.fieldType,
                    fieldName: field.fieldName,
                    completeText: field.completeText,
                    fieldPart: field.fieldPart,
                    valuePart: field.valuePart,
                    hindiText: field.hindiText,
                    distance: field.distance,
                    distanceReason: field.distanceReason,
                    maskingStrategy: field.maskingStrategy,
                    textToMask: field.textToMask,
                    context: field.context,
                    confidence: field.confidence
                })),
                foundFields: geminiFieldDetection.autoDetectedFields,
                geminiOCRSelection: geminiOCRSelection,
                totalFound: geminiFieldDetection.autoDetectedFields.length,
                removalType: "distance_based_masking",
                maskingType: "unified_distance_strategy"
            };
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            
            const results = {
                originalImage: localImagePath,
                foundText: foundTextResults,
                autoDetectedFields: geminiFieldDetection.autoDetectedFields,
                geminiAnalysis: geminiFieldDetection,
                geminiOCRSelection: geminiOCRSelection,
                maskImage: maskPath,
                highlightedImage: highlightedPath,
                inpaintedImages: finalImagePaths,
                rawInpaintedImages: inpaintedPaths,
                gcsResults: gcsResults,
                method: skipDetailRestoration ? "complete_gcs_workflow_4_samples_distance_based" : "complete_gcs_workflow_4_samples_with_detail_restoration",
                processingTime: processingTime,
                detailRestoration: {
                    enabled: !skipDetailRestoration,
                    maskChannel: maskChannel,
                    featherRadius: detailFeatherRadius,
                    method: 'pixel_level_blending'
                },
                workflowSteps: [
                    'gcs_download',
                    'image_validation',
                    'gemini_field_detection_with_distance',
                    'google_vision_ocr',
                    'gemini_ocr_selection_distance_based',
                    'distance_based_mask_creation',
                    'highlight_creation',
                    'imagen_inpainting',
                    ...(skipDetailRestoration ? [] : ['detail_restoration']),
                    'gcs_upload'
                ],
                buckets: {
                    input: this.inputBucket,
                    output: this.outputBucket,
                    bucketType: 'private'
                }
            };
            
            console.log(`=== Complete GCS OCR Inpainting Workflow Completed Successfully ===`);
            console.log(`Input: ${this.inputBucket}/${inputFileName}`);
            console.log(`Auto-detected ${geminiFieldDetection.autoDetectedFields.length} fields with distance analysis`);
            console.log(`Distance analysis results:`);
            geminiFieldDetection.autoDetectedFields.forEach(field => {
                console.log(`  - ${field.fieldName}: ${field.distance} distance, ${field.maskingStrategy} strategy`);
            });
            console.log(`Selected ${geminiOCRSelection.totalSelectedTexts} OCR texts for masking`);
            console.log(`Generated and uploaded ${gcsResults.outputFiles.filter(f => f.type === 'inpainted').length} inpainted variations`);
            console.log(`Detail restoration: ${skipDetailRestoration ? 'Skipped' : 'Applied'}`);
            console.log(`Total files uploaded to ${this.outputBucket}: ${gcsResults.outputFiles.length}`);
            console.log(`Complete workflow time: ${processingTime}`);
            
            return results;
            
        } catch (error) {
            console.error('Error in complete GCS OCR workflow:', error);
            throw error;
        } finally {
            // Clean up temporary files after a delay
            // setTimeout(() => {
            //     this.cleanupFiles(tempFiles);
            // }, 10000); // 10 second delay to ensure all operations complete
        }
    }

    /**
     * Upload all processed results to GCS with proper naming convention
     */
    async uploadAllResultsToGCS(inputFileName, processedFiles, outputBucket, options = {}) {
        const { returnOriginal = false, returnMask = false, returnHighlighted = true, returnRawInpainted = false } = options;
        
        const outputFiles = [];
        const gcsUrls = [];
        
        // Get base filename without extension
        const baseName = path.parse(inputFileName).name;
        const baseExt = path.parse(inputFileName).ext;
        
        try {
            // Upload original image if requested
            if (returnOriginal && processedFiles.originalImage) {
                const originalFileName = `${baseName}_original${baseExt}`;
                const originalUrl = await this.uploadToPrivateGCS(processedFiles.originalImage, originalFileName, outputBucket);
                outputFiles.push({
                    type: 'original',
                    fileName: originalFileName,
                    gcsUrl: originalUrl
                });
                gcsUrls.push(originalUrl);
            }

            // Upload mask image if requested
            if (returnMask && processedFiles.maskImage) {
                const maskFileName = `${baseName}_mask.png`;
                const maskUrl = await this.uploadToPrivateGCS(processedFiles.maskImage, maskFileName, outputBucket);
                outputFiles.push({
                    type: 'mask',
                    fileName: maskFileName,
                    gcsUrl: maskUrl
                });
                gcsUrls.push(maskUrl);
            }

            // Upload highlighted image if requested
            if (returnHighlighted && processedFiles.highlightedImage) {
                const highlightFileName = `${baseName}_highlighted.png`;
                const highlightUrl = await this.uploadToPrivateGCS(processedFiles.highlightedImage, highlightFileName, outputBucket);
                outputFiles.push({
                    type: 'highlighted',
                    fileName: highlightFileName,
                    gcsUrl: highlightUrl
                });
                gcsUrls.push(highlightUrl);
            }

            // Upload main inpainted images (detail restored if applicable)
            if (processedFiles.inpaintedImages && Array.isArray(processedFiles.inpaintedImages)) {
                for (let i = 0; i < processedFiles.inpaintedImages.length; i++) {
                    const inpaintedImagePath = processedFiles.inpaintedImages[i];
                    const inpaintedFileName = `${baseName}_${i + 1}.png`;
                    const inpaintedUrl = await this.uploadToPrivateGCS(inpaintedImagePath, inpaintedFileName, outputBucket);
                    
                    outputFiles.push({
                        type: 'inpainted',
                        fileName: inpaintedFileName,
                        gcsUrl: inpaintedUrl,
                        sampleNumber: i + 1
                    });
                    gcsUrls.push(inpaintedUrl);
                }
            }

            // Upload raw inpainted images if requested
            if (returnRawInpainted && processedFiles.rawInpaintedImages && Array.isArray(processedFiles.rawInpaintedImages)) {
                for (let i = 0; i < processedFiles.rawInpaintedImages.length; i++) {
                    const rawInpaintedImagePath = processedFiles.rawInpaintedImages[i];
                    const rawInpaintedFileName = `${baseName}_raw_${i + 1}.png`;
                    const rawInpaintedUrl = await this.uploadToPrivateGCS(rawInpaintedImagePath, rawInpaintedFileName, outputBucket);
                    
                    outputFiles.push({
                        type: 'raw_inpainted',
                        fileName: rawInpaintedFileName,
                        gcsUrl: rawInpaintedUrl,
                        sampleNumber: i + 1
                    });
                    gcsUrls.push(rawInpaintedUrl);
                }
            }

            console.log(`✅ Uploaded ${outputFiles.length} processed files to private GCS bucket ${outputBucket}`);
            
            return {
                outputFiles,
                gcsUrls,
                uploadCount: outputFiles.length,
                bucketType: 'private'
            };
            
        } catch (error) {
            console.error('Error uploading processed images to private GCS:', error);
            throw error;
        }
    }

    /**
     * Step 1: Use Gemini to automatically detect standard fields with distance analysis
     */
    async autoDetectStandardFields(imagePath, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Analyzing image with Gemini distance analysis (attempt ${attempt}/${maxRetries})...`);
                
                // Rate limiting
                const timeSinceLastCall = Date.now() - this.lastGeminiCall;
                if (timeSinceLastCall < this.minTimeBetweenCalls) {
                    await this.delay(this.minTimeBetweenCalls - timeSinceLastCall);
                }
                
                // Read and encode the image
                const imageBuffer = fs.readFileSync(imagePath);
                const imageBase64 = imageBuffer.toString('base64');
                
                // Create comprehensive prompt for auto-detection with distance analysis
                const prompt = `Analyze this product packaging image and automatically detect these 6 standard fields if they exist. Look for both English and Hindi versions of each field:

**IMPORTANT**: When you find a field, also look for its Hindi translation that might appear next to it, below it, or nearby. Include Hindi text as part of the field detection.

1. **MANUFACTURING DATE**
   - English: MFG DATE, MFG DT, MFG.DATE, MFGDATE, MANUFACTURING DATE, MANUFACTURED ON, MFD, MFG, PROD DATE, PRODUCTION DATE
   - Hindi: उत्पादन तिथि, निर्माण तिथि, बनाने की तिथि, उत्पादन दिनांक, निर्माण दिनांक

2. **EXPIRY DATE**
   - English: EXP DATE, EXP DT, EXP.DATE, EXPDATE, EXPIRY DATE, EXPIRE DATE, EXPIRES ON, EXP, BEST BEFORE, USE BY, VALID UNTIL
   - Hindi: समाप्ति तिथि, एक्सपायरी डेट, समाप्ति दिनांक, उपयोग करने की अंतिम तिथि, अवधि समाप्ति

3. **BATCH NUMBER**
   - English: BATCH NO, BATCH NO., BATCH NUMBER, B.NO, B.NO., BNO, BATCH, LOT NO, LOT NO., LOT NUMBER, LOT, BATCH CODE, LOT CODE
   - Hindi: बैच नंबर, बैच संख्या, लॉट संख्या, बैच कोड, लॉट नंबर

4. **MRP (Maximum Retail Price)**
   - English: MRP, M.R.P, M.R.P., MAX RETAIL PRICE, MAXIMUM RETAIL PRICE, RETAIL PRICE, PRICE, COST, RATE
   - Hindi: अधिकतम खुदरा मूल्य, एमआरपी, खुदरा मूल्य, मूल्य, कीमत, दर

5. **PACK SIZE** (can exist with or without field label)
   - English Field Labels: PACK SIZE, PACK, SIZE, CONTENT, CONTENTS, NET CONTENT, NET CONTENTS, NET QTY, QUANTITY
   - Hindi Field Labels: पैक साइज़, पैकेट का आकार, मात्रा, नेट मात्रा, कंटेंट
   - Value Patterns (can exist standalone): "per 10 tablets", "per 20 capsules", "10 tablets", "20 capsules", "100ml", "250mg", "5gm", "1kg", "10x1", "strip of 10", "bottle of 50", "pack of 100", "box of 30"

6. **INCLUSIVE OF TAXES**
   - English: INCLUSIVE OF ALL TAXES, INCL OF ALL TAXES, INCL. OF ALL TAXES, INCLUSIVE OF TAXES, INCL OF TAXES, INCL. OF TAXES, IOAT, I.O.A.T, I.O.A.T., ALL TAXES INCLUDED, TAX INCLUSIVE, TAXES INCLUDED
   - Hindi: सभी करों सहित, सभी कर शामिल, कर सहित, टैक्स सहित, सभी टैक्स शामिल

**CRITICAL DISTANCE ANALYSIS**: For each field found, analyze the visual distance between the field name and its value:

- **LOW DISTANCE** (field and value are directly connected/adjacent with no gap OR field is above its corresponding value with no gap): 
  * **MASKING STRATEGY**: ALL fields and their values should be masked for inpainting
  * **UNIFIED APPROACH**: If ANY field has low distance, mask ALL detected fields (MFG DATE, EXP DATE, BATCH NO, MRP, PACK SIZE, IOAT) and their values
  * **PACK SIZE INCLUSION**: Always include pack size values (like "per 10 tablets") in masking
  * **IOAT INCLUSION**: Include IOAT in masking (only for low distance scenarios)

- **HIGH DISTANCE** (field and value are separated by significant spacing or in different columns): 
  * **MASKING STRATEGY**: Only VALUES should be masked for inpainting, keep field names
  * **UNIFIED APPROACH**: If ALL fields have high distance, mask only the VALUES of all detected fields
  * **PACK SIZE INCLUSION**: Always include pack size values (like "per 10 tablets") in masking
  * **IOAT EXCLUSION**: Do NOT include IOAT in masking (only included for low distance scenarios)

**EXAMPLES OF LOW DISTANCE** (unified masking - ALL fields and values):
- "B.No.SXG0306A" (field and value directly connected)
- "MFG.Dt.02/2025" (field and value connected with dots)
- "EXP.Dt.07/2026" (field and value connected directly)
- "M.R.P.₹95.00" (field and value connected with symbol)
- "MFG DATE: 02/2024" (field and value with minimal spacing)
- "EXP Date
   07/2025" (field is above value with no gap)

**EXAMPLES OF HIGH DISTANCE** (values only masking):
- "Mfg. Lic. No." in left column and "G/25/2150" in right column (separated by significant space)
- "Batch No." in left column and "S24K016" in right column (tabular layout)
- "Mfg. Date" in left column and "11/2024" in right column (separated layout)
- "Max. Retail Price ₹" in left column and "69.00" in right column (split across columns)

**UNIFIED MASKING LOGIC**:
- If ANY field has LOW distance → mask ALL fields and values + pack size values + IOAT
- If ALL fields have HIGH distance → mask only VALUES of all fields + pack size values (NO IOAT)
- Pack size values (like "per 10 tablets") are ALWAYS included in masking regardless of distance
- IOAT is ONLY included when LOW distance is detected

Instructions:
1. Look for any variation of these 6 fields in the image
2. For each field found, analyze the distance between field name and value
3. Determine the unified masking strategy based on distance analysis
4. Always include pack size values in masking

Respond in JSON format:
{
  "found": true/false,
  "autoDetectedFields": [
    {
      "fieldType": "manufacturing_date",
      "fieldName": "MFG DATE",
      "completeText": "MFG DATE: 12/2024",
      "fieldPart": "MFG DATE:",
      "valuePart": "12/2024",
      "hindiText": "उत्पादन तिथि",
      "distance": "low",
      "distanceReason": "The field MFG DATE and value 12/2024 are directly connected with no gap",
      "maskingStrategy": "unified_all_fields_and_values",
      "textToMask": "ALL fields and values + pack size values + IOAT",
      "context": "found at bottom of package with Hindi translation",
      "confidence": "high"
    },
    {
      "fieldType": "pack_size",
      "fieldName": "",
      "completeText": "per 10 tablets",
      "fieldPart": "",
      "valuePart": "per 10 tablets",
      "hindiText": "",
      "distance": "standalone",
      "distanceReason": "Pack size value without field label",
      "maskingStrategy": "always_include_pack_size",
      "textToMask": "per 10 tablets",
      "context": "standalone pack size value",
      "confidence": "high"
    }
  ],
  "unifiedMaskingStrategy": "all_fields_and_values", // or "values_only"
  "detectionConfidence": "high",
  "totalFound": 2,
  "context": "Auto-detected standard fields with unified distance-based masking strategy"
}`;

                const imagePart = {
                    inlineData: {
                        data: imageBase64,
                        mimeType: this.getMimeType(imagePath)
                    }
                };

                const result = await this.geminiModel.generateContent([prompt, imagePart]);
                const response = await result.response;
                const text = response.text();
                
                this.lastGeminiCall = Date.now();
                
                console.log('Gemini raw response for auto field detection with distance:', text);
                
                // Parse JSON response
                try {
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsedResult = JSON.parse(jsonMatch[0]);
                        
                        if (parsedResult.found && parsedResult.autoDetectedFields && parsedResult.autoDetectedFields.length > 0) {
                            console.log(`✅ Auto-detected ${parsedResult.autoDetectedFields.length} fields with unified distance strategy:`, 
                                parsedResult.autoDetectedFields.map(f => f.fieldType));
                            console.log(`Unified masking strategy: ${parsedResult.unifiedMaskingStrategy}`);
                            return parsedResult;
                        }
                    }
                } catch (parseError) {
                    console.warn('Could not parse Gemini JSON response, using fallback');
                }
                
                // Fallback: try to extract fields from text response
                const fallbackResult = this.extractStandardFieldsFromText(text);
                if (fallbackResult.found) {
                    return fallbackResult;
                }
                
                throw new Error('No fields detected in response');
                
            } catch (error) {
                lastError = error;
                console.error(`Gemini API attempt ${attempt} failed:`, error.message);
                
                if (error.status === 503 || error.message.includes('overloaded')) {
                    if (attempt < maxRetries) {
                        const baseDelay = Math.pow(2, attempt) * 1000;
                        const jitter = Math.random() * 1000;
                        const waitTime = baseDelay + jitter;
                        
                        console.log(`⏳ Waiting ${Math.round(waitTime)}ms before retry...`);
                        await this.delay(waitTime);
                        continue;
                    }
                } else if (error.status === 429) {
                    console.log('Rate limit exceeded, waiting longer...');
                    await this.delay(10000);
                    continue;
                } else {
                    break;
                }
            }
        }
        
        // If all retries failed, use OCR-only fallback
        console.log('All Gemini attempts failed, using OCR-only fallback...');
        return await this.fallbackFieldDetection(imagePath);
    }

    /**
     * Step 2: Perform OCR to get all text with coordinates
     */
    async getFullOCRResults(imagePath) {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            
            const [result] = await this.visionClient.textDetection({
                image: { content: imageBuffer }
            });

            const detections = result.textAnnotations;
            
            if (!detections || detections.length === 0) {
                return {
                    fullText: '',
                    individualTexts: []
                };
            }

            return {
                fullText: detections[0].description || '',
                fullTextCoordinates: detections[0].boundingPoly.vertices,
                individualTexts: detections.slice(1).map((detection, index) => ({
                    id: index + 1,
                    text: detection.description,
                    coordinates: detection.boundingPoly.vertices,
                    confidence: detection.confidence || null
                }))
            };
        } catch (error) {
            console.error('Error getting full OCR results:', error);
            throw error;
        }
    }

    /**
     * Step 3: Use Gemini to select which OCR texts belong to each field based on distance analysis
     */
    async selectOCRTextsWithGemini(imagePath, ocrTexts, detectedFields) {
        try {
            console.log('Using Gemini to select OCR texts with unified distance-based masking...');
            
            // Rate limiting
            const timeSinceLastCall = Date.now() - this.lastGeminiCall;
            if (timeSinceLastCall < this.minTimeBetweenCalls) {
                await this.delay(this.minTimeBetweenCalls - timeSinceLastCall);
            }
            
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            // Determine the unified masking strategy
            const unifiedStrategy = detectedFields[0]?.maskingStrategy || 'unified_all_fields_and_values';
            
            const prompt = `You are an expert at analyzing OCR results from product packaging. I need you to select OCR texts based on UNIFIED DISTANCE-BASED MASKING strategy.

**UNIFIED MASKING STRATEGY**: ${unifiedStrategy}

**STRATEGY EXPLANATION**:
- If "unified_all_fields_and_values": Select OCR texts for ALL field names AND their values + pack size values
- If "values_only": Select OCR texts for VALUES only + pack size values
- Pack size values (like "per 10 tablets") are ALWAYS included regardless of strategy

1. DETECTED FIELDS with distance analysis:
${detectedFields.map(field => `   - Field: ${field.fieldName} | Complete: "${field.completeText}" | Distance: ${field.distance} | Strategy: ${field.maskingStrategy} | Hindi: "${field.hindiText || 'None'}"`).join('\n')}

2. ALL OCR TEXTS from the image with their IDs:
${ocrTexts.map(text => `   ID: ${text.id} | Text: "${text.text}"`).join('\n')}

**UNIFIED SELECTION RULES**:

**If Strategy = "unified_all_fields_and_values"**:
- Select OCR texts for ALL field names (including Hindi if present)
- Select OCR texts for ALL field values
- Select OCR texts for pack size values (like "per 10 tablets")
- Select OCR texts for IOAT (only in low distance scenarios)
- Include everything related to detected fields

**If Strategy = "values_only"**:
- Skip field names, select only VALUES
- Select OCR texts for manufacturing date VALUE
- Select OCR texts for expiry date VALUE  
- Select OCR texts for batch number VALUE
- Select OCR texts for MRP VALUE
- Select OCR texts for pack size VALUE (like "per 10 tablets")
- DO NOT select IOAT (only included in low distance scenarios)

**CRITICAL: OCR ERROR HANDLING AND PROXIMITY-BASED RECONSTRUCTION**

OCR systems often make errors or fail to detect complete text. When this happens, use intelligent analysis:

**RECONSTRUCTION RULES:**
1. **Missing Separators**: If expecting "03/2024" but find "03" and "2024" separately, select both IDs
2. **Split Dates**: Common patterns like "MM/YYYY", "DD-MM-YY", "MM.YYYY" may be split across multiple OCR texts
3. **Fragmented Text**: "MFG.DATE:03/2024" might be detected as ["MFG.DATE", ":", "03", "/", "2024"] - select all relevant parts
4. **Proximity Logic**: If "03" is detected, look for nearby numbers that could form a date (like "2024", "24", "04", etc.)
5. **Pattern Matching**: Use visual positioning to identify logical groupings (dates, batch numbers, prices)

**EXAMPLES**:

**LOW DISTANCE EXAMPLE (unified_all_fields_and_values)**:
- Select: "MFG.DATE", ":", "03", "/", "2024" (field + value)
- Select: "EXP.DATE", ":", "07", "/", "2026" (field + value)
- Select: "B.NO", ".", "ABC123" (field + value)
- Select: "MRP", "₹", "95", ".", "00" (field + value)
- Select: "per", "10", "tablets" (pack size value)
- Select: "IOAT" (tax inclusion - only in low distance)

**HIGH DISTANCE EXAMPLE (values_only)**:
- Skip: "MFG.DATE", Select: "03", "/", "2024" (value only)
- Skip: "EXP.DATE", Select: "07", "/", "2026" (value only)
- Skip: "B.NO", Select: "ABC123" (value only)
- Skip: "MRP", Select: "₹", "95", ".", "00" (value only)
- Select: "per", "10", "tablets" (pack size value - always included)
- Skip: "IOAT" (not included in high distance scenarios)

Respond in JSON format:
{
  "success": true,
  "unifiedStrategy": "${unifiedStrategy}",
  "selectedFields": [
    {
      "fieldType": "manufacturing_date",
      "fieldName": "MFG.DATE",
      "completeText": "MFG.DATE: 03/2024",
      "selectedOCRIds": [5, 6, 7, 8, 9],
      "reasoning": "Selected field name and value fragments based on unified strategy",
      "textParts": ["MFG.DATE", ":", "03", "/", "2024"],
      "hindiIncluded": true,
      "hindiText": "उत्पादन तिथि"
    },
    {
      "fieldType": "pack_size",
      "fieldName": "",
      "completeText": "per 10 tablets",
      "selectedOCRIds": [15, 16, 17],
      "reasoning": "Pack size value always included regardless of strategy",
      "textParts": ["per", "10", "tablets"],
      "hindiIncluded": false,
      "hindiText": ""
    }
  ],
  "totalSelectedTexts": 8,
  "confidence": "high",
  "visualContextUsed": true,
  "ocrErrorHandling": true,
  "unifiedMaskingApplied": true
}`;

            const imagePart = {
                inlineData: {
                    data: imageBase64,
                    mimeType: this.getMimeType(imagePath)
                }
            };

            const result = await this.geminiModel.generateContent([prompt, imagePart]);
            const response = await result.response;
            const text = response.text();
            
            this.lastGeminiCall = Date.now();
            
            console.log('Gemini OCR selection with unified distance strategy - raw response:', text);
            
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    if (parsedResult.success && parsedResult.selectedFields && parsedResult.selectedFields.length > 0) {
                        const enrichedSelection = this.enrichGeminiSelection(parsedResult, ocrTexts);
                        console.log('✅ Gemini successfully selected OCR texts with unified distance strategy');
                        console.log(`Unified strategy applied: ${parsedResult.unifiedStrategy}`);
                        console.log(`Selected fields: ${parsedResult.selectedFields.length}`);
                        console.log(`Total OCR texts selected: ${parsedResult.totalSelectedTexts}`);
                        
                        return enrichedSelection;
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response for OCR selection, using fallback');
            }
            
            const fallbackSelection = this.createFallbackOCRSelection(detectedFields, ocrTexts);
            return fallbackSelection;
            
        } catch (error) {
            console.error('Error in Gemini OCR text selection with unified distance strategy:', error);
            return this.createFallbackOCRSelection(detectedFields, ocrTexts);
        }
    }

    /**
     * Step 4: Create mask based on Gemini's OCR text selection with unified distance strategy
     */
    async createMaskFromGeminiSelection(imagePath, selectedFields, padding = 5) {
        try {
            console.log('Creating mask from Gemini OCR selection with unified distance strategy...');
            
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            let maskBuffer = await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 0, g: 0, b: 0 }
                }
            }).png().toBuffer();
            
            const compositeOps = [];
            
            for (const field of selectedFields) {
                const coordinates = field.combinedCoordinates;
                
                const xs = coordinates.map(coord => coord.x || 0);
                const ys = coordinates.map(coord => coord.y || 0);
                
                const minX = Math.max(0, Math.min(...xs) - padding);
                const minY = Math.max(0, Math.min(...ys) - padding);
                const maxX = Math.min(width, Math.max(...xs) + padding);
                const maxY = Math.min(height, Math.max(...ys) + padding);
                
                const maskWidth = maxX - minX;
                const maskHeight = maxY - minY;
                
                console.log(`Creating mask for ${field.fieldName} (${field.fieldType}): ${maskWidth}x${maskHeight} at (${minX}, ${minY})`);
                
                const whiteRect = await sharp({
                    create: {
                        width: maskWidth,
                        height: maskHeight,
                        channels: 3,
                        background: { r: 255, g: 255, b: 255 }
                    }
                }).png().toBuffer();
                
                compositeOps.push({
                    input: whiteRect,
                    top: minY,
                    left: minX,
                    blend: 'over'
                });
            }
            
            const finalMaskBuffer = await sharp(maskBuffer)
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_unified_distance_mask.png');
            fs.writeFileSync(maskPath, finalMaskBuffer);
            
            console.log(`Unified distance-based mask saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating unified distance mask from Gemini selection:', error);
            throw error;
        }
    }

    /**
     * Step 5: Create highlighted image based on Gemini's OCR text selection
     */
    async createHighlightFromGeminiSelection(imagePath, selectedFields, padding = 5) {
        try {
            console.log('Creating highlight from Gemini OCR selection...');
            
            const colors = [
                { r: 255, g: 0, b: 0, alpha: 0.4 },
                { r: 0, g: 255, b: 0, alpha: 0.4 },
                { r: 0, g: 0, b: 255, alpha: 0.4 },
                { r: 255, g: 255, b: 0, alpha: 0.4 }
            ];
            
            let imageProcessor = sharp(imagePath);
            const compositeOps = [];
            
            for (let i = 0; i < selectedFields.length; i++) {
                const field = selectedFields[i];
                const color = colors[i % colors.length];
                const coordinates = field.combinedCoordinates;
                
                const xs = coordinates.map(coord => coord.x || 0);
                const ys = coordinates.map(coord => coord.y || 0);
                
                const minX = Math.max(0, Math.min(...xs) - padding);
                const minY = Math.max(0, Math.min(...ys) - padding);
                const maxX = Math.max(...xs) + padding;
                const maxY = Math.max(...ys) + padding;
                
                const overlayWidth = maxX - minX;
                const overlayHeight = maxY - minY;
                
                const overlay = await sharp({
                    create: {
                        width: overlayWidth,
                        height: overlayHeight,
                        channels: 4,
                        background: color
                    }
                }).png().toBuffer();
                
                compositeOps.push({
                    input: overlay,
                    top: minY,
                    left: minX,
                    blend: 'over'
                });
                
                console.log(`Created highlight for ${field.fieldName} (${field.fieldType}) with ${field.selectedTexts.length} OCR texts`);
            }
            
            const highlightedBuffer = await imageProcessor
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            const highlightedPath = imagePath.replace(path.extname(imagePath), '_unified_distance_highlighted.png');
            fs.writeFileSync(highlightedPath, highlightedBuffer);
            
            console.log(`Unified distance highlight saved to: ${highlightedPath}`);
            return highlightedPath;
            
        } catch (error) {
            console.error('Error creating highlight from Gemini selection:', error);
            throw error;
        }
    }

    /**
     * Step 6: Inpaint with Imagen 3 (4 samples)
     */
    async inpaintImage(imagePath, maskPath, prompt = "remove complete text fields, clean background matching surrounding area") {
        try {
            console.log('Starting inpainting process with Imagen 3 (4 samples) - FINAL STEP...');
            
            const authClient = await this.auth.getClient();
            const tokenResponse = await authClient.getAccessToken();
            const accessToken = tokenResponse.token;
            
            const imageBuffer = fs.readFileSync(imagePath);
            const maskBuffer = fs.readFileSync(maskPath);
            
            const imageBase64 = imageBuffer.toString('base64');
            const maskBase64 = maskBuffer.toString('base64');
            
            const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict`;
            
            const enhancedPrompt = `${prompt}. Remove text completely and fill with clean background that matches the surrounding packaging material. Do not generate new text, numbers, or characters. Fill the masked area with the same background texture and color as the surrounding area.`;
            
            const requestBody = {
                instances: [{
                    prompt: enhancedPrompt,
                    referenceImages: [
                        {
                            referenceType: "REFERENCE_TYPE_RAW",
                            referenceId: 1,
                            referenceImage: {
                                bytesBase64Encoded: imageBase64
                            }
                        },
                        {
                            referenceType: "REFERENCE_TYPE_MASK",
                            referenceId: 2,
                            referenceImage: {
                                bytesBase64Encoded: maskBase64
                            },
                            maskImageConfig: {
                                maskMode: "MASK_MODE_USER_PROVIDED",
                                dilation: 0.01
                            }
                        }
                    ]
                }],
                parameters: {
                    sampleCount: 4,
                    guidanceScale: 12,
                    language: "en",
                    editMode: "EDIT_MODE_INPAINT_REMOVAL"
                }
            };
            
            console.log('Sending request to Imagen 3 API for 4 samples...');
            
            const response = await axios.post(apiUrl, requestBody, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120000
            });
            
            if (response.data.predictions && response.data.predictions.length > 0) {
                const predictions = response.data.predictions;
                const outputPaths = [];
                
                console.log(`Processing ${predictions.length} predictions...`);
                
                for (let i = 0; i < predictions.length; i++) {
                    const prediction = predictions[i];
                    
                    let generatedImageBase64;
                    if (prediction.bytesBase64Encoded) {
                        generatedImageBase64 = prediction.bytesBase64Encoded;
                    } else if (prediction.generatedImage && prediction.generatedImage.bytesBase64Encoded) {
                        generatedImageBase64 = prediction.generatedImage.bytesBase64Encoded;
                    } else if (prediction.images && prediction.images.length > 0) {
                        generatedImageBase64 = prediction.images[0].bytesBase64Encoded;
                    } else {
                        console.warn(`No image data found in prediction ${i + 1}, skipping...`);
                        continue;
                    }
                    
                    const generatedImageBuffer = Buffer.from(generatedImageBase64, 'base64');
                    
                    const outputPath = imagePath.replace(
                        path.extname(imagePath), 
                        `_inpainted_sample_${i + 1}.png`
                    );
                    
                    fs.writeFileSync(outputPath, generatedImageBuffer);
                    outputPaths.push(outputPath);
                    
                    console.log(`✅ Inpainted sample ${i + 1} saved to: ${outputPath}`);
                }
                
                if (outputPaths.length === 0) {
                    throw new Error('No valid images were generated from the predictions');
                }
                
                console.log(`🎉 Successfully generated ${outputPaths.length} inpainted variations - WORKFLOW COMPLETE!`);
                return outputPaths;
                
            } else {
                throw new Error('No predictions returned from Imagen API');
            }
            
        } catch (error) {
            console.error('Error in inpainting:', error.response?.data || error.message);
            
            if (error.response?.data) {
                console.error('API Error Details:', JSON.stringify(error.response.data, null, 2));
            }
            
            throw error;
        }
    }

    /**
     * DETAIL RESTORATION METHODS
     */

    /**
     * Process mask with specific channel extraction (like ComfyUI's channel selection)
     */
    async processMaskWithChannel(inputMaskPath, outputPath, targetWidth, targetHeight, channel = 'red') {
        try {
            console.log(`Processing mask using ${channel.toUpperCase()} channel...`);
            
            const maskMeta = await sharp(inputMaskPath).metadata();
            console.log(`Original mask channels: ${maskMeta.channels}, hasAlpha: ${maskMeta.hasAlpha}`);
            
            let maskProcessor = sharp(inputMaskPath);
            
            // Resize first if needed
            if (maskMeta.width !== targetWidth || maskMeta.height !== targetHeight) {
                console.log(`Resizing mask: ${maskMeta.width}x${maskMeta.height} → ${targetWidth}x${targetHeight}`);
                maskProcessor = maskProcessor.resize(targetWidth, targetHeight, {
                    kernel: sharp.kernel.nearest, // Preserve binary nature
                    fit: 'fill'
                });
            }
            
            // Extract the specified channel
            switch (channel.toLowerCase()) {
                case 'red':
                    console.log('Extracting RED channel as mask...');
                    await maskProcessor
                        .extractChannel(0) // Red channel
                        .png()
                        .toFile(outputPath);
                    break;
                    
                case 'green':
                    console.log('Extracting GREEN channel as mask...');
                    await maskProcessor
                        .extractChannel(1) // Green channel
                        .png()
                        .toFile(outputPath);
                    break;
                    
                case 'blue':
                    console.log('Extracting BLUE channel as mask...');
                    await maskProcessor
                        .extractChannel(2) // Blue channel
                        .png()
                        .toFile(outputPath);
                    break;
                    
                case 'alpha':
                    console.log('Extracting ALPHA channel as mask...');
                    if (maskMeta.hasAlpha) {
                        await maskProcessor
                            .extractChannel(maskMeta.channels - 1) // Alpha is typically the last channel
                            .png()
                            .toFile(outputPath);
                    } else {
                        console.warn('No alpha channel found, falling back to grayscale conversion...');
                        await maskProcessor
                            .greyscale()
                            .png()
                            .toFile(outputPath);
                    }
                    break;
                    
                case 'auto':
                default:
                    console.log('Auto-detecting best channel for mask...');
                    
                    // Try different channels and pick the one with most contrast
                    const channelStats = [];
                    
                    for (let i = 0; i < Math.min(3, maskMeta.channels); i++) {
                        const tempPath = outputPath.replace('.png', `_temp_channel_${i}.png`);
                        await sharp(inputMaskPath)
                            .resize(targetWidth, targetHeight, { kernel: sharp.kernel.nearest, fit: 'fill' })
                            .extractChannel(i)
                            .png()
                            .toFile(tempPath);
                        
                        const stats = await sharp(tempPath).stats();
                        channelStats.push({
                            channel: i,
                            contrast: stats.channels[0].max - stats.channels[0].min,
                            mean: stats.channels[0].mean,
                            path: tempPath
                        });
                    }
                    
                    // Pick channel with highest contrast (most likely to be a good mask)
                    const bestChannel = channelStats.reduce((prev, current) => 
                        current.contrast > prev.contrast ? current : prev
                    );
                    
                    console.log(`Auto-selected channel ${bestChannel.channel} with contrast ${bestChannel.contrast}`);
                    
                    // Copy the best channel result
                    await sharp(bestChannel.path).png().toFile(outputPath);
                    
                    // Clean up temp files
                    channelStats.forEach(stat => {
                        if (fs.existsSync(stat.path)) {
                            fs.unlinkSync(stat.path);
                        }
                    });
                    break;
            }
            
            // Apply threshold to ensure binary mask
            const finalMaskPath = outputPath.replace('.png', '_binary.png');
            await sharp(outputPath)
                .threshold(128) // Convert to pure binary
                .png()
                .toFile(finalMaskPath);
            
            // Replace original with binary version
            fs.renameSync(finalMaskPath, outputPath);
            
            console.log(`✅ Mask processed using ${channel.toUpperCase()} channel`);
            
        } catch (error) {
            console.error('Error processing mask with channel:', error);
            throw error;
        }
    }

    /**
     * Pixel-level blending for detail restoration
     */
    async pixelLevelBlend(originalImagePath, inpaintedImagePath, maskPath, outputPath) {
        try {
            console.log('Using pixel-level blending for detail restoration...');
            
            // Get raw pixel data
            const originalBuffer = await sharp(originalImagePath).raw().toBuffer();
            const inpaintedBuffer = await sharp(inpaintedImagePath).raw().toBuffer();
            const maskBuffer = await sharp(maskPath).greyscale().raw().toBuffer();
            
            const { width, height, channels } = await sharp(originalImagePath).metadata();
            
            // Create output buffer
            const outputBuffer = Buffer.alloc(originalBuffer.length);
            
            // Blend pixels based on mask
            for (let i = 0; i < originalBuffer.length; i += channels) {
                const maskValue = maskBuffer[Math.floor(i / channels)]; // Grayscale mask value
                const alpha = maskValue / 255; // Normalize to 0-1
                
                // For each channel (R, G, B, A)
                for (let c = 0; c < channels; c++) {
                    const originalPixel = originalBuffer[i + c];
                    const inpaintedPixel = inpaintedBuffer[i + c];
                    
                    // Blend: if mask is white (255), use inpainted; if black (0), use original
                    outputBuffer[i + c] = Math.round(
                        originalPixel * (1 - alpha) + inpaintedPixel * alpha
                    );
                }
            }
            
            // Save blended result
            await sharp(outputBuffer, {
                raw: {
                    width: width,
                    height: height,
                    channels: channels
                }
            })
            .png()
            .toFile(outputPath);
            
            console.log('✅ Pixel-level detail restoration completed');
            
        } catch (error) {
            console.error('Error in pixel-level blending:', error);
            throw error;
        }
    }

    /**
     * Restore original details outside mask using pixel-level blending
     */
    async restoreDetailsWithPixelBlend(originalImagePath, inpaintedPaths, maskPath, options = {}) {
        const { maskChannel = 'red', featherRadius = 1 } = options;
        
        try {
            console.log('=== Starting Detail Restoration with Pixel-Level Blending ===');
            
            const restoredPaths = [];
            
            // Get original image dimensions
            const originalMeta = await sharp(originalImagePath).metadata();
            const targetWidth = originalMeta.width;
            const targetHeight = originalMeta.height;
            
            // Process mask with channel extraction
            const processedMaskPath = maskPath.replace('.png', '_channel_processed.png');
            await this.processMaskWithChannel(maskPath, processedMaskPath, targetWidth, targetHeight, maskChannel);
            
            // Apply feathering if requested
            let finalMaskPath = processedMaskPath;
            if (featherRadius > 0) {
                console.log(`Applying feathering with radius ${featherRadius}...`);
                finalMaskPath = processedMaskPath.replace('.png', '_feathered.png');
                await sharp(processedMaskPath)
                    .blur(featherRadius)
                    .png()
                    .toFile(finalMaskPath);
            }
            
            // Process each inpainted image
            for (let i = 0; i < inpaintedPaths.length; i++) {
                const inpaintedPath = inpaintedPaths[i];
                console.log(`Restoring details for inpainted sample ${i + 1}...`);
                
                // Ensure inpainted image matches original dimensions
                const inpaintedMeta = await sharp(inpaintedPath).metadata();
                let resizedInpaintedPath = inpaintedPath;
                
                if (inpaintedMeta.width !== targetWidth || inpaintedMeta.height !== targetHeight) {
                    console.log(`Resizing inpainted image to match original: ${targetWidth}x${targetHeight}`);
                    resizedInpaintedPath = inpaintedPath.replace('.png', '_resized.png');
                    await sharp(inpaintedPath)
                        .resize(targetWidth, targetHeight, {
                            kernel: sharp.kernel.lanczos3,
                            fit: 'fill'
                        })
                        .png()
                        .toFile(resizedInpaintedPath);
                }
                
                // Perform pixel-level blending
                const restoredPath = inpaintedPath.replace('_inpainted_sample_', '_detail_restored_sample_');
                await this.pixelLevelBlend(
                    originalImagePath,
                    resizedInpaintedPath,
                    finalMaskPath,
                    restoredPath
                );
                
                restoredPaths.push(restoredPath);
                
                // Clean up resized temp file if created
                if (resizedInpaintedPath !== inpaintedPath && fs.existsSync(resizedInpaintedPath)) {
                    fs.unlinkSync(resizedInpaintedPath);
                }
                
                console.log(`✅ Detail restoration completed for sample ${i + 1}`);
            }
            
            // Clean up mask processing temp files
            if (fs.existsSync(processedMaskPath)) {
                fs.unlinkSync(processedMaskPath);
            }
            if (finalMaskPath !== processedMaskPath && fs.existsSync(finalMaskPath)) {
                fs.unlinkSync(finalMaskPath);
            }
            
            console.log(`✅ All ${restoredPaths.length} samples processed with detail restoration`);
            return restoredPaths;
            
        } catch (error) {
            console.error('Error in detail restoration with pixel blend:', error);
            throw error;
        }
    }

    /**
     * HELPER METHODS
     */

    /**
     * OCR-only fallback when Gemini is unavailable
     */
    async fallbackFieldDetection(imagePath) {
        try {
            console.log('Using OCR-only fallback for field detection...');
            
            const ocrResults = await this.getFullOCRResults(imagePath);
            
            if (!ocrResults.individualTexts || ocrResults.individualTexts.length === 0) {
                throw new Error('No OCR text found in image');
            }
            
            const detectedFields = [];
            
            for (const standardField of this.STANDARD_FIELDS) {
                const fieldType = standardField.fieldType;
                const variations = [...standardField.commonVariations, ...(standardField.hindiVariations || [])];
                
                for (const ocrText of ocrResults.individualTexts) {
                    const textUpper = ocrText.text.toUpperCase();
                    
                    for (const variation of variations) {
                        if (textUpper.includes(variation.toUpperCase())) {
                            const fieldValue = this.findNearbyValue(ocrText, ocrResults.individualTexts);
                            const completeText = `${ocrText.text}${fieldValue ? ' ' + fieldValue : ''}`;
                            
                            // Default fallback distance analysis
                            const isConnected = !completeText.includes('  ') && !completeText.includes(' : ');
                            const distance = isConnected ? 'low' : 'high';
                            const maskingStrategy = distance === 'low' ? 'unified_all_fields_and_values' : 'values_only';
                            
                            detectedFields.push({
                                fieldType: fieldType,
                                fieldName: variation,
                                completeText: completeText,
                                fieldPart: ocrText.text,
                                valuePart: fieldValue || '',
                                hindiText: '',
                                distance: distance,
                                distanceReason: `OCR fallback analysis - ${distance} distance detected`,
                                maskingStrategy: maskingStrategy,
                                textToMask: maskingStrategy === 'unified_all_fields_and_values' ? 'ALL fields and values + pack size + IOAT' : 'VALUES only + pack size (NO IOAT)',
                                context: "OCR fallback detection",
                                confidence: "medium",
                                coordinates: ocrText.coordinates
                            });
                            break;
                        }
                    }
                    
                    if (detectedFields.find(f => f.fieldType === fieldType)) {
                        break;
                    }
                }
            }
            
            // Special handling for pack size patterns
            if (!detectedFields.find(f => f.fieldType === 'pack_size')) {
                const packSizePattern = /per \d+ (tablets?|capsules?|pills?)|^\d+ (tablets?|capsules?|pills?)|^\d+\s*(ml|mg|gm?|kg)/i;
                
                for (const ocrText of ocrResults.individualTexts) {
                    if (packSizePattern.test(ocrText.text)) {
                        detectedFields.push({
                            fieldType: 'pack_size',
                            fieldName: '',
                            completeText: ocrText.text,
                            fieldPart: '',
                            valuePart: ocrText.text,
                            hindiText: '',
                            distance: 'standalone',
                            distanceReason: 'Pack size value without field label',
                            maskingStrategy: 'always_include_pack_size',
                            textToMask: ocrText.text,
                            context: "OCR fallback pack size pattern detection",
                            confidence: "medium",
                            coordinates: ocrText.coordinates
                        });
                        break;
                    }
                }
            }
            
            return {
                found: detectedFields.length > 0,
                autoDetectedFields: detectedFields,
                unifiedMaskingStrategy: detectedFields.length > 0 && detectedFields[0].maskingStrategy,
                detectionConfidence: detectedFields.length > 2 ? "high" : detectedFields.length > 0 ? "medium" : "low",
                totalFound: detectedFields.length,
                context: "OCR fallback detection completed"
            };
            
        } catch (error) {
            console.error('Error in OCR fallback detection:', error);
            return {
                found: false,
                autoDetectedFields: [],
                unifiedMaskingStrategy: 'values_only',
                detectionConfidence: "low",
                totalFound: 0,
                context: "OCR fallback detection failed"
            };
        }
    }

    /**
     * Helper method to find nearby value text for a field
     */
    findNearbyValue(fieldText, allTexts) {
        const fieldCoords = fieldText.coordinates;
        const fieldCenterX = fieldCoords.reduce((sum, coord) => sum + coord.x, 0) / fieldCoords.length;
        const fieldCenterY = fieldCoords.reduce((sum, coord) => sum + coord.y, 0) / fieldCoords.length;
        
        const nearbyTexts = allTexts.filter(text => {
            if (text.id === fieldText.id) return false;
            
            const textCoords = text.coordinates;
            const textCenterX = textCoords.reduce((sum, coord) => sum + coord.x, 0) / textCoords.length;
            const textCenterY = textCoords.reduce((sum, coord) => sum + coord.y, 0) / textCoords.length;
            
            const distance = Math.sqrt(
                Math.pow(textCenterX - fieldCenterX, 2) + 
                Math.pow(textCenterY - fieldCenterY, 2)
            );
            
            return distance < 100;
        });
        
        const valueText = nearbyTexts.find(text => {
            const textStr = text.text.trim();
            return /\d/.test(textStr) || textStr.length > 2;
        });
        
        return valueText ? valueText.text : null;
    }

    /**
     * Fallback method to extract standard fields from Gemini text response
     */
    extractStandardFieldsFromText(text) {
        console.log('Using fallback method to extract standard fields from text...');
        
        const lines = text.split('\n');
        const autoDetectedFields = [];
        
        for (const standardField of this.STANDARD_FIELDS) {
            const fieldType = standardField.fieldType;
            const variations = [...standardField.commonVariations, ...(standardField.hindiVariations || [])];
            
            for (const line of lines) {
                const upperLine = line.toUpperCase();
                
                for (const variation of variations) {
                    if (upperLine.includes(variation.toUpperCase())) {
                        const fieldPatterns = [
                            new RegExp(`${variation.replace(/\./g, '\\.')}\\s*:?\\s*[^\\n]*`, 'i'),
                            new RegExp(`${variation.replace(/\./g, '\\.')}[:\\s]+[^\\s][^\\n]*`, 'i')
                        ];
                        
                        for (const pattern of fieldPatterns) {
                            const matches = line.match(pattern);
                            if (matches) {
                                const completeText = matches[0].trim();
                                const valuePart = completeText.replace(variation, '').replace(/^[:\s]+/, '');
                                
                                if (valuePart) {
                                    // Default fallback distance analysis
                                    const isConnected = !completeText.includes('  ') && !completeText.includes(' : ');
                                    const distance = isConnected ? 'low' : 'high';
                                    const maskingStrategy = distance === 'low' ? 'unified_all_fields_and_values' : 'values_only';
                                    
                                    autoDetectedFields.push({
                                        fieldType: fieldType,
                                        fieldName: variation,
                                        completeText: completeText,
                                        fieldPart: variation,
                                        valuePart: valuePart,
                                        hindiText: '',
                                        distance: distance,
                                        distanceReason: `Fallback analysis - ${distance} distance detected`,
                                        maskingStrategy: maskingStrategy,
                                        textToMask: maskingStrategy === 'unified_all_fields_and_values' ? 'ALL fields and values + pack size + IOAT' : 'VALUES only + pack size (NO IOAT)',
                                        context: "Extracted from text response",
                                        confidence: "medium"
                                    });
                                    break;
                                }
                            }
                        }
                        
                        if (autoDetectedFields.find(f => f.fieldType === fieldType)) {
                            break;
                        }
                    }
                }
                
                if (autoDetectedFields.find(f => f.fieldType === fieldType)) {
                    break;
                }
            }
        }
        
        return {
            found: autoDetectedFields.length > 0,
            autoDetectedFields: autoDetectedFields,
            unifiedMaskingStrategy: autoDetectedFields.length > 0 ? autoDetectedFields[0].maskingStrategy : 'values_only',
            detectionConfidence: autoDetectedFields.length > 2 ? "high" : autoDetectedFields.length > 0 ? "medium" : "low",
            totalFound: autoDetectedFields.length,
            context: "Fallback extraction from text response"
        };
    }

    /**
     * Enrich Gemini's selection with actual OCR text data and coordinates
     */
    enrichGeminiSelection(geminiSelection, ocrTexts) {
        const enrichedFields = [];
        
        for (const field of geminiSelection.selectedFields) {
            const selectedTexts = [];
            const coordinates = [];
            
            for (const ocrId of field.selectedOCRIds) {
                const ocrText = ocrTexts.find(text => text.id === ocrId);
                if (ocrText) {
                    selectedTexts.push(ocrText);
                    coordinates.push(...ocrText.coordinates);
                }
            }
            
            if (selectedTexts.length > 0) {
                enrichedFields.push({
                    fieldType: field.fieldType,
                    fieldName: field.fieldName,
                    completeText: field.completeText,
                    selectedOCRIds: field.selectedOCRIds,
                    selectedTexts: selectedTexts,
                    combinedCoordinates: this.combineCoordinates(selectedTexts.map(t => t.coordinates)),
                    reasoning: field.reasoning,
                    textParts: field.textParts || [],
                    hindiIncluded: field.hindiIncluded || false,
                    hindiText: field.hindiText || '',
                    confidence: "high"
                });
            }
        }
        
        return {
            success: true,
            unifiedStrategy: geminiSelection.unifiedStrategy,
            selectedFields: enrichedFields,
            totalSelectedTexts: enrichedFields.reduce((sum, field) => sum + field.selectedTexts.length, 0),
            confidence: geminiSelection.confidence,
            method: "gemini_unified_distance_selection",
            visualContextUsed: geminiSelection.visualContextUsed,
            ocrErrorHandling: geminiSelection.ocrErrorHandling,
            unifiedMaskingApplied: geminiSelection.unifiedMaskingApplied
        };
    }

    /**
     * Create fallback selection if Gemini selection fails
     */
    createFallbackOCRSelection(detectedFields, ocrTexts) {
        console.log('Creating fallback OCR selection...');
        
        const fallbackFields = [];
        
        for (const field of detectedFields) {
            const matchingTexts = ocrTexts.filter(ocrText => {
                const fieldWords = field.completeText.toLowerCase().split(/\s+/);
                const ocrWords = ocrText.text.toLowerCase().split(/\s+/);
                
                return fieldWords.some(word => ocrWords.some(ocrWord => 
                    ocrWord.includes(word) || word.includes(ocrWord)
                ));
            });
            
            if (matchingTexts.length > 0) {
                fallbackFields.push({
                    fieldType: field.fieldType,
                    fieldName: field.fieldName,
                    completeText: field.completeText,
                    selectedOCRIds: matchingTexts.map(t => t.id),
                    selectedTexts: matchingTexts,
                    combinedCoordinates: this.combineCoordinates(matchingTexts.map(t => t.coordinates)),
                    reasoning: "Fallback text matching",
                    textParts: matchingTexts.map(t => t.text),
                    hindiIncluded: false,
                    hindiText: '',
                    confidence: "medium"
                });
            }
        }
        
        return {
            success: fallbackFields.length > 0,
            unifiedStrategy: detectedFields.length > 0 ? detectedFields[0].maskingStrategy : 'values_only',
            selectedFields: fallbackFields,
            totalSelectedTexts: fallbackFields.reduce((sum, field) => sum + field.selectedTexts.length, 0),
            confidence: "medium",
            method: "fallback_selection",
            visualContextUsed: false,
            ocrErrorHandling: false,
            unifiedMaskingApplied: false
        };
    }

    /**
     * Combine multiple coordinate arrays into a single bounding box
     */
    combineCoordinates(coordinateArrays) {
        const allCoords = coordinateArrays.flat();
        
        if (allCoords.length === 0) return [];
        
        const xs = allCoords.map(coord => coord.x);
        const ys = allCoords.map(coord => coord.y);
        
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        
        return [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY }
        ];
    }

    /**
     * Validate image file
     */
    async validateImage(imagePath) {
        try {
            if (!fs.existsSync(imagePath)) {
                throw new Error('Image file does not exist');
            }

            const metadata = await sharp(imagePath).metadata();
            
            const supportedFormats = ['jpeg', 'png', 'webp'];
            if (!supportedFormats.includes(metadata.format)) {
                throw new Error(`Unsupported image format: ${metadata.format}`);
            }

            // Check image size constraints
            if (metadata.width > 10000 || metadata.height > 10000) {
                throw new Error('Image dimensions too large. Maximum 10000x10000 pixels.');
            }

            if (metadata.width < 50 || metadata.height < 50) {
                throw new Error('Image dimensions too small. Minimum 50x50 pixels.');
            }

            return {
                valid: true,
                format: metadata.format,
                width: metadata.width,
                height: metadata.height,
                size: fs.statSync(imagePath).size
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    /**
     * Get MIME type from file path
     */
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp'
        };
        return mimeTypes[ext] || 'image/jpeg';
    }

    /**
     * Clean up temporary files
     */
    cleanupFiles(filePaths) {
        filePaths.forEach(filePath => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up temp file: ${filePath}`);
                }
            } catch (error) {
                console.error(`Error cleaning up temp file ${filePath}:`, error.message);
            }
        });
    }
}

module.exports = new StreamlinedOCRInpaintingService();