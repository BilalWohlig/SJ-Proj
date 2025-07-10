const vision = require('@google-cloud/vision');
const { GoogleAuth } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');

/**
 * Streamlined OCR Inpainting Service with Gemini OCR Selection
 * Workflow: Gemini Field Detection → OCR → Gemini OCR Selection → Mask → Inpaint
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
        this.geminiModel = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
     * MAIN WORKFLOW: Process image with Gemini OCR text selection
     */
    async processImageWithAutoFieldDetection(imagePath, inpaintPrompt = "clean background, seamless removal", padding = 5, createHighlight = true) {
        try {
            console.log('=== Starting Gemini OCR Selection workflow ===');
            const startTime = Date.now();
            
            // Step 1: Use Gemini to detect fields with retry logic
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
            
            // Step 5: Create highlighted image (optional)
            let highlightedPath = null;
            if (createHighlight) {
                highlightedPath = await this.createHighlightFromGeminiSelection(imagePath, geminiOCRSelection.selectedFields, padding);
            }
            
            // Step 6: Inpaint with 4 samples (FINAL STEP)
            const inpaintedPaths = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
            
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
            console.log(`Auto-detected ${geminiFieldDetection.autoDetectedFields.length} fields with distance analysis`);
            console.log(`Distance analysis results:`);
            geminiFieldDetection.autoDetectedFields.forEach(field => {
                console.log(`  - ${field.fieldName}: ${field.distance} distance, ${field.maskingStrategy} strategy`);
            });
            console.log(`Selected ${geminiOCRSelection.totalSelectedTexts} OCR texts for masking`);
            console.log(`Generated ${inpaintedPaths.length} inpainted variations`);
            console.log(`Workflow completed in ${processingTime}`);
            
            return results;
            
        } catch (error) {
            console.error('Error in Gemini OCR Selection workflow:', error);
            throw error;
        }
    }

    /**
     * Step 1: Use Gemini to automatically detect standard fields with retry logic
     */
    async autoDetectStandardFields(imagePath, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Analyzing image with Gemini (attempt ${attempt}/${maxRetries})...`);
                
                // Rate limiting
                const timeSinceLastCall = Date.now() - this.lastGeminiCall;
                if (timeSinceLastCall < this.minTimeBetweenCalls) {
                    await this.delay(this.minTimeBetweenCalls - timeSinceLastCall);
                }
                
                // Read and encode the image
                const imageBuffer = fs.readFileSync(imagePath);
                const imageBase64 = imageBuffer.toString('base64');
                
                // Create comprehensive prompt for auto-detection with distance analysis
                const prompt = `Analyze this product packaging image and automatically detect these 4 standard fields if they exist:

1. MANUFACTURING DATE (variations: MFG DATE, MFG DT, MFG.DATE, MFGDATE, MANUFACTURING DATE, MANUFACTURED ON, MFD, MFG, PROD DATE, PRODUCTION DATE)
2. EXPIRY DATE (variations: EXP DATE, EXP DT, EXP.DATE, EXPDATE, EXPIRY DATE, EXPIRE DATE, EXPIRES ON, EXP, BEST BEFORE, USE BY, VALID UNTIL)
3. BATCH NUMBER (variations: BATCH NO, BATCH NO., BATCH NUMBER, B.NO, B.NO., BNO, BATCH, LOT NO, LOT NO., LOT NUMBER, LOT, BATCH CODE, LOT CODE)
4. MRP (variations: MRP, M.R.P, M.R.P., MAX RETAIL PRICE, MAXIMUM RETAIL PRICE, RETAIL PRICE, PRICE, COST, RATE)

CRITICAL DISTANCE ANALYSIS: For each field found, analyze the visual distance between the field name and its value:

- **LOW DISTANCE** (field and value are directly connected/adjacent with no gap): Both field name AND value should be masked for inpainting
- **HIGH DISTANCE** (field and value are separated by significant spacing or in different columns): Only the VALUE should be masked for inpainting, keep the field name

Examples of LOW DISTANCE (mask both field and value):
- "B.No.SXG0306A" (field and value directly connected)
- "MFG.Dt.02/2025" (field and value connected with dots)
- "EXP.Dt.07/2026" (field and value connected directly)
- "M.R.P.₹95.00" (field and value connected with symbol)

Examples of HIGH DISTANCE (mask only value):
- "Mfg. Lic. No." in left column and "G/25/2150" in right column (separated by significant space)
- "Batch No." in left column and "S24K016" in right column (tabular layout)
- "Mfg. Date" in left column and "11/2024" in right column (separated layout)
- "Max. Retail Price ₹" in left column and "69.00" in right column (split across columns)

IMPORTANT: HIGH DISTANCE typically occurs in tabular layouts where field names are in one column and values are in another column, separated by significant whitespace or alignment gaps.

Instructions:
1. Look for any variation of these 4 fields in the image
2. For each field found, analyze the distance between field name and value
3. Determine what should be masked based on distance analysis and give reason to support your decision.
4. Return the masking strategy for each field

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
      "distance": "low",
      "distanceReason": "The field MFG DATE and value 12/2024 are directly connected with no gap",
      "maskingStrategy": "both",
      "textToMask": "MFG DATE: 12/2024",
      "textToKeep": "",
      "context": "found at bottom of package",
      "confidence": "high"
    },
    {
      "fieldType": "expiry_date",
      "fieldName": "EXP DATE",
      "completeText": "EXP DATE 01/2026",
      "fieldPart": "EXP DATE",
      "valuePart": "01/2026",
      "distance": "high",
      "distanceReason": "The field EXP DATE and value 01/2026 are separated by significant whitespace",
      "maskingStrategy": "value_only",
      "textToMask": "01/2026",
      "textToKeep": "EXP DATE",
      "context": "field and value are separated",
      "confidence": "high"
    }
  ],
  "detectionConfidence": "high",
  "totalFound": 2,
  "context": "Auto-detected standard fields with distance analysis"
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
                if (fallbackResult.found) {
                    return fallbackResult;
                }
                
                throw new Error('No fields detected in response');
                
            } catch (error) {
                lastError = error;
                console.error(`Gemini API attempt ${attempt} failed:`, error.message);
                
                if (error.status === 503 || error.message.includes('overloaded')) {
                    if (attempt < maxRetries) {
                        // Exponential backoff with jitter
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
                const variations = standardField.commonVariations;
                
                for (const ocrText of ocrResults.individualTexts) {
                    const textUpper = ocrText.text.toUpperCase();
                    
                    for (const variation of variations) {
                        if (textUpper.includes(variation)) {
                            const fieldValue = this.findNearbyValue(ocrText, ocrResults.individualTexts);
                            const completeText = `${ocrText.text}${fieldValue ? ' ' + fieldValue : ''}`;
                            
                            // Distance analysis for fallback - check if field and value are connected
                            const isConnected = completeText.includes(variation) && !completeText.includes(' : ') && !completeText.includes('  ');
                            const distance = isConnected ? 'low' : 'high';
                            const maskingStrategy = distance === 'low' ? 'both' : 'value_only';
                            const textToMask = maskingStrategy === 'both' ? completeText : valuePart;
                            
                            detectedFields.push({
                                fieldType: fieldType,
                                fieldName: variation,
                                completeText: completeText,
                                fieldPart: ocrText.text,
                                valuePart: fieldValue || '',
                                distance: distance,
                                maskingStrategy: maskingStrategy,
                                textToMask: textToMask,
                                textToKeep: maskingStrategy === 'value_only' ? ocrText.text : '',
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
            
            return {
                found: detectedFields.length > 0,
                autoDetectedFields: detectedFields,
                detectionConfidence: detectedFields.length > 2 ? "high" : detectedFields.length > 0 ? "medium" : "low",
                totalFound: detectedFields.length,
                context: "OCR fallback detection completed"
            };
            
        } catch (error) {
            console.error('Error in OCR fallback detection:', error);
            return {
                found: false,
                autoDetectedFields: [],
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
     * Step 3: Use Gemini to select which OCR texts belong to each detected field (with distance-based masking)
     */
    async selectOCRTextsWithGemini(imagePath, ocrTexts, detectedFields) {
        try {
            console.log('Using Gemini to select OCR texts for detected fields with distance-based masking...');
            
            // Rate limiting
            const timeSinceLastCall = Date.now() - this.lastGeminiCall;
            if (timeSinceLastCall < this.minTimeBetweenCalls) {
                await this.delay(this.minTimeBetweenCalls - timeSinceLastCall);
            }
            
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            const prompt = `You are an expert at analyzing OCR results from product packaging. I have:

1. DETECTED FIELDS with distance analysis from previous step:
${detectedFields.map(field => `   - Field: ${field.fieldName} | Text to Mask: "${field.textToMask}" | Strategy: ${field.maskingStrategy} | Distance: ${field.distance}`).join('\n')}

2. ALL OCR TEXTS from the image:
${ocrTexts.map(text => `   ID: ${text.id} | Text: "${text.text}"`).join('\n')}

YOUR TASK: For each detected field, identify which OCR text IDs should be selected based on the masking strategy:

MASKING RULES:
- **"both"** strategy (low distance): Select OCR texts for both field name AND value
- **"value_only"** strategy (high distance): Select OCR texts ONLY for the value part, NOT the field name

IMPORTANT:
- For "both" strategy: Select all OCR texts that form the complete field-value pair
- For "value_only" strategy: Select only OCR texts that contain the value, avoid field name texts
- Be precise - only select texts that match the intended masking strategy

Respond in JSON format:
{
  "success": true,
  "selectedFields": [
    {
      "fieldType": "manufacturing_date",
      "fieldName": "Mfg.Date",
      "completeText": "Mfg.Date:11/2024",
      "maskingStrategy": "both",
      "textToMask": "Mfg.Date:11/2024",
      "selectedOCRIds": [5, 6],
      "reasoning": "Both strategy - selecting field name (ID 5) and value (ID 6)"
    },
    {
      "fieldType": "expiry_date",
      "fieldName": "EXP DATE",
      "completeText": "EXP DATE 01/2026",
      "maskingStrategy": "value_only",
      "textToMask": "01/2026",
      "selectedOCRIds": [8],
      "reasoning": "Value only strategy - selecting only the value part (ID 8), keeping field name"
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
            
            this.lastGeminiCall = Date.now();
            
            console.log('Gemini OCR selection raw response:', text);
            
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    if (parsedResult.success && parsedResult.selectedFields && parsedResult.selectedFields.length > 0) {
                        const enrichedSelection = this.enrichGeminiSelection(parsedResult, ocrTexts);
                        console.log('✅ Gemini successfully selected OCR texts for fields');
                        return enrichedSelection;
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response for OCR selection');
            }
            
            const fallbackSelection = this.createFallbackOCRSelection(detectedFields, ocrTexts);
            return fallbackSelection;
            
        } catch (error) {
            console.error('Error in Gemini OCR text selection:', error);
            return this.createFallbackOCRSelection(detectedFields, ocrTexts);
        }
    }

    /**
     * Step 4: Create mask based on Gemini's OCR text selection (with distance-based masking)
     */
    async createMaskFromGeminiSelection(imagePath, selectedFields, padding = 5) {
        try {
            console.log('Creating mask from Gemini OCR selection with distance-based masking...');
            
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
                
                const strategy = field.maskingStrategy || 'both';
                console.log(`Creating mask for ${field.fieldName} (${strategy} strategy): ${maskWidth}x${maskHeight} at (${minX}, ${minY})`);
                
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
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_distance_based_mask.png');
            fs.writeFileSync(maskPath, finalMaskBuffer);
            
            console.log(`Distance-based mask saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating distance-based mask from Gemini selection:', error);
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
                
                for (const variation of variations) {
                    if (upperLine.includes(variation)) {
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

module.exports = new StreamlinedOCRInpaintingService();