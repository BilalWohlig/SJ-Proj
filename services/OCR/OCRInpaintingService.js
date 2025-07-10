const vision = require('@google-cloud/vision');
const { GoogleAuth } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');

/**
 * Streamlined OCR Inpainting Service with Gemini OCR Selection
 * New Workflow: Gemini Field Detection → OCR → Gemini OCR Selection → Mask → Inpaint
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

        this.visionClient = new vision.ImageAnnotatorClient({
            keyFilename: this.keyFilePath
        });
        
        this.auth = new GoogleAuth({
            keyFile: this.keyFilePath,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        // Initialize Gemini
        this.genAI = new GoogleGenerativeAI(this.geminiApiKey);
        this.geminiModel = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Define standard fields to auto-detect
        this.STANDARD_FIELDS = [
            {
                fieldType: 'manufacturing_date',
                commonVariations: ['MFG DATE', 'MFG DT', 'MFG.DATE', 'MFG.DT', 'MFGDATE', 'MANUFACTURING DATE', 'MANUFACTURE DATE', 'MANUFACTURED ON', 'MFD', 'MFG', 'PROD DATE', 'PRODUCTION DATE']
            },
            {
                fieldType: 'expiry_date',
                commonVariations: ['EXP DATE', 'EXP DT', 'EXP.DATE', 'EXP.DT', 'EXPDATE', 'EXPIRY DATE', 'EXPIRE DATE', 'EXPIRES ON', 'EXP', 'BEST BEFORE', 'USE BY', 'VALID UNTIL']
            },
            {
                fieldType: 'batch_number',
                commonVariations: ['BATCH NO', 'BATCH NO.', 'BATCH NUMBER', 'B.NO', 'B.NO.', 'BNO', 'BATCH', 'LOT NO', 'LOT NO.', 'LOT NUMBER', 'LOT', 'BATCH CODE', 'LOT CODE']
            },
            {
                fieldType: 'mrp',
                commonVariations: ['MRP', 'M.R.P', 'M.R.P.', 'MAX RETAIL PRICE', 'MAXIMUM RETAIL PRICE', 'RETAIL PRICE', 'PRICE', 'COST', 'RATE']
            }
        ];
    }

    /**
     * Step 7: NEW - Create inverted mask overlay and apply to all inpainted images
     */
    async applyInvertedMaskOverlay(originalImagePath, maskPath, inpaintedPaths) {
        try {
            console.log('=== Step 7: Creating inverted mask overlay ===');
            
            // Step 7a: Create inverted mask (black fields, white background)
            const invertedMaskPath = await this.createInvertedMask(maskPath);
            
            // Step 7b: Combine inverted mask with original image
            const maskedOriginalPath = await this.combineInvertedMaskWithOriginal(
                originalImagePath, 
                invertedMaskPath
            );
            
            // Step 7c: Apply overlay to all inpainted images
            const finalProcessedPaths = await this.overlayMaskedOriginalOnInpainted(
                maskedOriginalPath, 
                inpaintedPaths
            );
            
            console.log('✅ Successfully applied inverted mask overlay to all inpainted images');
            return finalProcessedPaths;
            
        } catch (error) {
            console.error('Error applying inverted mask overlay:', error);
            // Return original inpainted paths if overlay fails
            return inpaintedPaths;
        }
    }

    /**
     * Step 7a: Create inverted mask (black = removed fields, white = keep area)
     */
    async createInvertedMask(maskPath) {
        try {
            console.log('Creating inverted mask...');
            
            // Load the original mask
            const originalMaskBuffer = fs.readFileSync(maskPath);
            
            // Invert the mask: white becomes black, black becomes white
            const invertedMaskBuffer = await sharp(originalMaskBuffer)
                .negate() // This inverts colors: white->black, black->white
                .png()
                .toBuffer();
            
            // Save inverted mask
            const invertedMaskPath = maskPath.replace('.png', '_inverted.png');
            fs.writeFileSync(invertedMaskPath, invertedMaskBuffer);
            
            console.log(`Inverted mask saved to: ${invertedMaskPath}`);
            return invertedMaskPath;
            
        } catch (error) {
            console.error('Error creating inverted mask:', error);
            throw error;
        }
    }

    /**
     * Step 7b: Combine inverted mask with original image
     */
    async combineInvertedMaskWithOriginal(originalImagePath, invertedMaskPath) {
        try {
            console.log('Combining inverted mask with original image...');
            
            // Load original image and inverted mask
            const originalImage = sharp(originalImagePath);
            const invertedMask = sharp(invertedMaskPath);
            
            // Get original image metadata
            const originalMetadata = await originalImage.metadata();
            
            // Ensure mask is same size as original image
            const resizedMask = await invertedMask
                .resize(originalMetadata.width, originalMetadata.height)
                .png()
                .toBuffer();
            
            // Combine: original image where mask is white, black where mask is black
            const maskedOriginalBuffer = await originalImage
                .composite([{
                    input: resizedMask,
                    blend: 'multiply' // This will make masked areas (black) appear black
                }])
                .png()
                .toBuffer();
            
            // Save combined image
            const maskedOriginalPath = originalImagePath.replace(
                path.extname(originalImagePath), 
                '_masked_original.png'
            );
            fs.writeFileSync(maskedOriginalPath, maskedOriginalBuffer);
            
            console.log(`Masked original image saved to: ${maskedOriginalPath}`);
            return maskedOriginalPath;
            
        } catch (error) {
            console.error('Error combining inverted mask with original:', error);
            throw error;
        }
    }

    /**
     * Step 7c: Overlay masked original on all inpainted images
     */
    async overlayMaskedOriginalOnInpainted(maskedOriginalPath, inpaintedPaths) {
        try {
            console.log('Overlaying masked original on all inpainted images...');
            
            const finalProcessedPaths = [];
            
            for (let i = 0; i < inpaintedPaths.length; i++) {
                const inpaintedPath = inpaintedPaths[i];
                
                console.log(`Processing inpainted image ${i + 1}/${inpaintedPaths.length}...`);
                
                // Load inpainted image and masked original
                const inpaintedImage = sharp(inpaintedPath);
                const maskedOriginal = sharp(maskedOriginalPath);
                
                // Get inpainted image metadata
                const inpaintedMetadata = await inpaintedImage.metadata();
                
                // Ensure masked original is same size as inpainted image
                const resizedMaskedOriginal = await maskedOriginal
                    .resize(inpaintedMetadata.width, inpaintedMetadata.height)
                    .png()
                    .toBuffer();
                
                // Overlay: inpainted image as base, masked original on top
                // The masked original will show original image where fields were (black areas)
                // and be transparent/white where inpainting should show through
                const finalImageBuffer = await inpaintedImage
                    .composite([{
                        input: resizedMaskedOriginal,
                        blend: 'screen' // This will overlay white areas transparently, black areas opaquely
                    }])
                    .png()
                    .toBuffer();
                
                // Save final processed image
                const finalPath = inpaintedPath.replace(
                    '_inpainted_sample_', 
                    '_final_processed_sample_'
                );
                fs.writeFileSync(finalPath, finalImageBuffer);
                finalProcessedPaths.push(finalPath);
                
                console.log(`Final processed image ${i + 1} saved to: ${finalPath}`);
            }
            
            console.log(`All ${finalProcessedPaths.length} final processed images created`);
            return finalProcessedPaths;
            
        } catch (error) {
            console.error('Error overlaying masked original on inpainted images:', error);
            throw error;
        }
    }

    /**
     * MAIN WORKFLOW: Process image with Gemini OCR text selection
     */
    async processImageWithAutoFieldDetection(imagePath, inpaintPrompt = "clean background, seamless removal", padding = 5, createHighlight = true) {
        try {
            console.log('=== Starting Gemini OCR Selection workflow ===');
            const startTime = Date.now();
            
            // Step 1: Use Gemini to detect fields
            const geminiFieldDetection = await this.autoDetectStandardFields(imagePath);
            console.log('Step 1 - Gemini field detection result:', geminiFieldDetection);
            
            if (!geminiFieldDetection.found || !geminiFieldDetection.autoDetectedFields || geminiFieldDetection.autoDetectedFields.length === 0) {
                throw new Error('No standard fields found in the image');
            }

            // Step 2: Perform OCR to get all text with coordinates
            const ocrResults = await this.getFullOCRResults(imagePath);
            console.log('Step 2 - OCR detected texts:', ocrResults.individualTexts.length);
            
            // Step 3: Use Gemini to select which OCR texts belong to each field
            const geminiOCRSelection = await this.selectOCRTextsWithGemini(
                imagePath, 
                ocrResults.individualTexts, 
                geminiFieldDetection.autoDetectedFields
            );
            console.log('Step 3 - Gemini OCR selection result:', geminiOCRSelection);

            if (!geminiOCRSelection.success || geminiOCRSelection.selectedFields.length === 0) {
                throw new Error('Gemini could not select appropriate OCR texts for the detected fields');
            }

            // Step 4: Create mask based on Gemini's OCR text selection
            const maskPath = await this.createMaskFromGeminiSelection(imagePath, geminiOCRSelection.selectedFields, padding);
            
            // Step 5: Create highlighted image
            let highlightedPath = null;
            if (createHighlight) {
                highlightedPath = await this.createHighlightFromGeminiSelection(imagePath, geminiOCRSelection.selectedFields, padding);
            }
            
            // Step 6: Inpaint with 4 samples
            const inpaintedPaths = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
            
            // Step 7: NEW - Create inverted mask overlay and apply to all inpainted images
            const finalProcessedPaths = await this.applyInvertedMaskOverlay(
                imagePath, 
                maskPath, 
                inpaintedPaths
            );
            
            // Prepare response
            const foundTextResults = {
                autoDetectedFields: geminiFieldDetection.autoDetectedFields.map(field => ({
                    fieldType: field.fieldType,
                    fieldName: field.fieldName,
                    completeText: field.completeText,
                    fieldPart: field.fieldPart,
                    valuePart: field.valuePart,
                    context: field.context,
                    confidence: field.confidence
                })),
                foundFields: geminiFieldDetection.autoDetectedFields,
                geminiOCRSelection: geminiOCRSelection,
                totalFound: geminiFieldDetection.autoDetectedFields.length,
                removalType: "gemini_ocr_selection",
                maskingType: "gemini_selected_areas"
            };
            
            const results = {
                originalImage: imagePath,
                foundText: foundTextResults,
                autoDetectedFields: geminiFieldDetection.autoDetectedFields,
                geminiAnalysis: geminiFieldDetection,
                geminiOCRSelection: geminiOCRSelection,
                maskImage: maskPath,
                highlightedImage: highlightedPath,
                inpaintedImages: inpaintedPaths,
                method: "gemini_ocr_selection_4_samples"
            };
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            results.processingTime = processingTime;
            
            console.log(`=== Gemini OCR Selection workflow completed successfully ===`);
            console.log(`Auto-detected ${geminiFieldDetection.autoDetectedFields.length} fields`);
            console.log(`Selected ${geminiOCRSelection.totalSelectedTexts} OCR texts`);
            console.log(`Generated ${inpaintedPaths.length} inpainted variations`);
            console.log(`Applied inverted mask overlay to all ${finalProcessedPaths.length} final images`);
            
            return results;
            
        } catch (error) {
            console.error('Error in Gemini OCR Selection workflow:', error);
            throw error;
        }
    }

    /**
     * Step 1: Use Gemini to automatically detect standard fields in the image
     */
    async autoDetectStandardFields(imagePath) {
        try {
            console.log('Analyzing image with Gemini for automatic field detection...');
            
            // Read and encode the image
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            // Create comprehensive prompt for auto-detection
            const prompt = `Analyze this product packaging image and automatically detect these 4 standard fields if they exist:

1. MANUFACTURING DATE (variations: MFG DATE, MFG DT, MFG.DATE, MFGDATE, MANUFACTURING DATE, MANUFACTURED ON, MFD, MFG, PROD DATE, PRODUCTION DATE)
2. EXPIRY DATE (variations: EXP DATE, EXP DT, EXP.DATE, EXPDATE, EXPIRY DATE, EXPIRE DATE, EXPIRES ON, EXP, BEST BEFORE, USE BY, VALID UNTIL)
3. BATCH NUMBER (variations: BATCH NO, BATCH NO., BATCH NUMBER, B.NO, B.NO., BNO, BATCH, LOT NO, LOT NO., LOT NUMBER, LOT, BATCH CODE, LOT CODE)
4. MRP (variations: MRP, M.R.P, M.R.P., MAX RETAIL PRICE, MAXIMUM RETAIL PRICE, RETAIL PRICE, PRICE, COST, RATE)

IMPORTANT: For each field found, I need the COMPLETE field-value pair (field name + separator + value) that needs to be removed entirely.

Instructions:
1. Look for any variation of these 4 fields in the image
2. For each field found, extract the complete text including field name, separator, and value
3. Identify the field type (manufacturing_date, expiry_date, batch_number, mrp)
4. Return the FULL text that needs to be removed

Example responses:
- If you see "MFG DATE: 12/2024", return fieldType: "manufacturing_date", completeText: "MFG DATE: 12/2024"
- If you see "B.NO.: ABC123", return fieldType: "batch_number", completeText: "B.NO.: ABC123"
- If you see "MRP ₹25.00", return fieldType: "mrp", completeText: "MRP ₹25.00"

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
      "context": "found at bottom of package",
      "confidence": "high"
    },
    {
      "fieldType": "expiry_date",
      "fieldName": "EXP DATE",
      "completeText": "EXP DATE: 12/2025",
      "fieldPart": "EXP DATE:",
      "valuePart": "12/2025",
      "context": "found at bottom of package",
      "confidence": "high"
    }
  ],
  "detectionConfidence": "high",
  "totalFound": 2,
  "context": "Auto-detected standard fields on product packaging"
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
            
            console.log('Gemini raw response for auto field detection:', text);
            
            // Parse JSON response
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    if (parsedResult.found && parsedResult.autoDetectedFields && parsedResult.autoDetectedFields.length > 0) {
                        console.log(`✅ Auto-detected ${parsedResult.autoDetectedFields.length} fields:`, 
                            parsedResult.autoDetectedFields.map(f => f.fieldType));
                        return parsedResult;
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response, using fallback');
            }
            
            // Fallback: try to extract fields from text response
            const fallbackResult = this.extractStandardFieldsFromText(text);
            return fallbackResult;
            
        } catch (error) {
            console.error('Error in Gemini auto field detection:', error);
            return {
                found: false,
                autoDetectedFields: [],
                detectionConfidence: "low",
                totalFound: 0,
                context: "Auto field detection failed"
            };
        }
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
     * Step 3: Use Gemini to select which OCR texts belong to each detected field
     */
    async selectOCRTextsWithGemini(imagePath, ocrTexts, detectedFields) {
        try {
            console.log('Using Gemini to select OCR texts for detected fields...');
            
            // Read and encode the image
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            // Create comprehensive prompt for OCR text selection
            const prompt = `You are an expert at analyzing OCR results from product packaging. I have:

1. DETECTED FIELDS from previous analysis:
${detectedFields.map(field => `   - Field: ${field.fieldName} | Complete Text: "${field.completeText}"`).join('\n')}

2. ALL OCR TEXTS from the image:
${ocrTexts.map(text => `   ID: ${text.id} | Text: "${text.text}"`).join('\n')}

YOUR TASK: For each detected field, identify which OCR text IDs should be selected to form that complete field.

IMPORTANT RULES:
- A field might be one OCR text (e.g., ID: 5 contains "Mfg.Date:11/2024")
- A field might be multiple OCR texts (e.g., ID: 5="Mfg.Date:", ID: 6="11/2024")
- Select ALL OCR texts that belong to each field, even if they're separated
- If a field spans multiple lines, select all relevant texts
- Be precise - only select texts that are actually part of the field

EXAMPLE RESPONSES:
- If "Mfg.Date:11/2024" is one OCR text with ID 5: select [5]
- If "Mfg.Date:" is ID 5 and "11/2024" is ID 6: select [5, 6]
- If "Mfg.", "Date:", "11/2024" are IDs 5, 6, 7: select [5, 6, 7]

Respond in JSON format:
{
  "success": true,
  "selectedFields": [
    {
      "fieldType": "manufacturing_date",
      "fieldName": "Mfg.Date",
      "completeText": "Mfg.Date:11/2024",
      "selectedOCRIds": [5, 6],
      "reasoning": "Field name 'Mfg.Date:' is in OCR ID 5, value '11/2024' is in OCR ID 6"
    },
    {
      "fieldType": "batch_number", 
      "fieldName": "Batch No.",
      "completeText": "Batch No.:A333001",
      "selectedOCRIds": [8],
      "reasoning": "Complete field-value pair is contained in single OCR text ID 8"
    }
  ],
  "totalSelectedTexts": 3,
  "confidence": "high"
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
            
            console.log('Gemini OCR selection raw response:', text);
            
            // Parse JSON response
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    if (parsedResult.success && parsedResult.selectedFields && parsedResult.selectedFields.length > 0) {
                        // Validate and enrich the selection with actual OCR data
                        const enrichedSelection = this.enrichGeminiSelection(parsedResult, ocrTexts);
                        console.log('✅ Gemini successfully selected OCR texts for fields');
                        return enrichedSelection;
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response for OCR selection');
            }
            
            // Fallback: create basic selection based on field detection
            const fallbackSelection = this.createFallbackOCRSelection(detectedFields, ocrTexts);
            return fallbackSelection;
            
        } catch (error) {
            console.error('Error in Gemini OCR text selection:', error);
            return {
                success: false,
                selectedFields: [],
                totalSelectedTexts: 0,
                confidence: "low",
                error: error.message
            };
        }
    }

    /**
     * Step 4: Create mask based on Gemini's OCR text selection
     */
    async createMaskFromGeminiSelection(imagePath, selectedFields, padding = 5) {
        try {
            console.log('Creating mask from Gemini OCR selection...');
            
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            // Start with black background
            let maskBuffer = await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 0, g: 0, b: 0 }
                }
            }).png().toBuffer();
            
            const compositeOps = [];
            
            // Create white rectangle for each selected field
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
                
                console.log(`Creating mask for ${field.fieldName}: ${maskWidth}x${maskHeight} at (${minX}, ${minY})`);
                
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
            
            // Apply all masks
            const finalMaskBuffer = await sharp(maskBuffer)
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_gemini_selection_mask.png');
            fs.writeFileSync(maskPath, finalMaskBuffer);
            
            console.log(`Gemini selection mask saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating mask from Gemini selection:', error);
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
                { r: 255, g: 0, b: 0, alpha: 0.4 },     // Red
                { r: 0, g: 255, b: 0, alpha: 0.4 },     // Green  
                { r: 0, g: 0, b: 255, alpha: 0.4 },     // Blue
                { r: 255, g: 255, b: 0, alpha: 0.4 }    // Yellow
            ];
            
            let imageProcessor = sharp(imagePath);
            const compositeOps = [];
            
            // Create colored overlay for each selected field
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
                
                console.log(`Created highlight for ${field.fieldName} with ${field.selectedTexts.length} OCR texts`);
            }
            
            const highlightedBuffer = await imageProcessor
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            const highlightedPath = imagePath.replace(path.extname(imagePath), '_gemini_selection_highlighted.png');
            fs.writeFileSync(highlightedPath, highlightedBuffer);
            
            console.log(`Gemini selection highlight saved to: ${highlightedPath}`);
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
            console.log('Starting inpainting process with Imagen 3 Capability model (4 samples)...');
            
            const authClient = await this.auth.getClient();
            const tokenResponse = await authClient.getAccessToken();
            const accessToken = tokenResponse.token;
            
            const imageBuffer = fs.readFileSync(imagePath);
            const maskBuffer = fs.readFileSync(maskPath);
            
            const imageBase64 = imageBuffer.toString('base64');
            const maskBase64 = maskBuffer.toString('base64');
            
            // Use the imagen-3.0-capability-001 model endpoint
            const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict`;
            
            // Enhanced prompt for complete field removal
            const enhancedPrompt = `${prompt}. Remove text completely and fill with clean background that matches the surrounding packaging material. Do not generate new text, numbers, or characters. Fill the masked area with the same background texture and color as the surrounding area.`;
            
            // API structure with reference images - manual masking only, 4 samples
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
            
            console.log('Sending request to Imagen 3 Capability API for 4 samples...');
            
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
                
                // Process each prediction and save as separate files
                for (let i = 0; i < predictions.length; i++) {
                    const prediction = predictions[i];
                    
                    // Handle different response formats
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
                    
                    // Create unique filename for each sample
                    const outputPath = imagePath.replace(
                        path.extname(imagePath), 
                        `_inpainted_sample_${i + 1}.png`
                    );
                    
                    fs.writeFileSync(outputPath, generatedImageBuffer);
                    outputPaths.push(outputPath);
                    
                    console.log(`Inpainted sample ${i + 1} saved to: ${outputPath}`);
                }
                
                if (outputPaths.length === 0) {
                    throw new Error('No valid images were generated from the predictions');
                }
                
                console.log(`Successfully generated ${outputPaths.length} inpainted variations`);
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
     * HELPER METHODS
     */

    /**
     * Fallback method to extract standard fields from Gemini text response
     */
    extractStandardFieldsFromText(text) {
        console.log('Using fallback method to extract standard fields from text...');
        
        const lines = text.split('\n');
        const autoDetectedFields = [];
        
        for (const standardField of this.STANDARD_FIELDS) {
            const fieldType = standardField.fieldType;
            const variations = standardField.commonVariations;
            
            for (const line of lines) {
                const upperLine = line.toUpperCase();
                
                // Check if line contains any variation of this field
                for (const variation of variations) {
                    if (upperLine.includes(variation)) {
                        // Try to extract the complete field-value pair
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
                                    autoDetectedFields.push({
                                        fieldType: fieldType,
                                        fieldName: variation,
                                        completeText: completeText,
                                        fieldPart: variation,
                                        valuePart: valuePart,
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
            
            // Get actual OCR texts based on Gemini's selection
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
                    confidence: "high"
                });
            }
        }
        
        return {
            success: true,
            selectedFields: enrichedFields,
            totalSelectedTexts: enrichedFields.reduce((sum, field) => sum + field.selectedTexts.length, 0),
            confidence: geminiSelection.confidence,
            method: "gemini_ocr_selection"
        };
    }

    /**
     * Create fallback selection if Gemini selection fails
     */
    createFallbackOCRSelection(detectedFields, ocrTexts) {
        console.log('Creating fallback OCR selection...');
        
        const fallbackFields = [];
        
        for (const field of detectedFields) {
            // Simple text matching as fallback
            const matchingTexts = ocrTexts.filter(ocrText => {
                const fieldWords = field.completeText.toLowerCase().split(/\s+/);
                const ocrWords = ocrText.text.toLowerCase().split(/\s+/);
                
                // Check if OCR text contains any words from the field
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
                    confidence: "medium"
                });
            }
        }
        
        return {
            success: fallbackFields.length > 0,
            selectedFields: fallbackFields,
            totalSelectedTexts: fallbackFields.reduce((sum, field) => sum + field.selectedTexts.length, 0),
            confidence: "medium",
            method: "fallback_selection"
        };
    }

    /**
     * Combine multiple coordinate arrays into a single bounding box
     */
    combineCoordinates(coordinateArrays) {
        const allCoords = coordinateArrays.flat();
        
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
                    // Check if filename contains 'inpainted' - if so, preserve it
                    const filename = path.basename(filePath).toLowerCase();
                    if (filename.includes('inpainted')) {
                        console.log(`Preserving inpainted file: ${filePath}`);
                        return;
                    }
                    
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up file: ${filePath}`);
                }
            } catch (error) {
                console.error(`Error cleaning up file ${filePath}:`, error.message);
            }
        });
    }
}

// Export singleton instance
module.exports = new StreamlinedOCRInpaintingService();