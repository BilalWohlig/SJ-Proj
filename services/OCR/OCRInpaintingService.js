const vision = require('@google-cloud/vision');
const { GoogleAuth } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');

/**
 * Complete Enhanced OCR Inpainting Service with Gemini Integration
 * Handles OCR text detection, Gemini vision analysis, highlighting, and inpainting operations
 */
class CompleteEnhancedOCRInpaintingService {
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
    }

    /**
     * Complete workflow with Gemini integration and enhanced Imagen 3 Capability API
     */
    async processImage(imagePath, searchText, inpaintPrompt = "clean background, seamless removal", padding = 5, useAutoMask = false, createHighlight = true) {
        try {
            console.log('=== Starting enhanced OCR + Gemini + Inpainting workflow ===');
            const startTime = Date.now();
            
            // Step 1: Use Gemini to understand the image and find the target value
            const geminiResult = await this.analyzeImageWithGemini(imagePath, searchText);
            console.log('Gemini analysis result:', geminiResult);
            
            let results;
            
            if (useAutoMask || !geminiResult.found) {
                console.log('Using automatic mask generation...');
                // Fallback to automatic mask generation
                const inpaintedPath = await this.inpaintImageWithAutoMask(
                    imagePath, 
                    `${inpaintPrompt}. Remove text related to "${searchText}"`,
                    "MASK_MODE_SEMANTIC"
                );
                
                results = {
                    originalImage: imagePath,
                    foundText: {
                        searchText: searchText,
                        associatedText: geminiResult.targetValue || "Auto-detected",
                        coordinates: null,
                        groupedTexts: [],
                        confidence: 0.5
                    },
                    geminiAnalysis: geminiResult,
                    maskImage: null, // No manual mask created
                    highlightedImage: null, // No specific coordinates to highlight
                    inpaintedImage: inpaintedPath,
                    method: "auto_mask"
                };
            } else {
                // Step 2: Perform OCR to get all text with coordinates
                const ocrResults = await this.getFullOCRResults(imagePath);
                
                // Step 3: Find and group the target text using smart matching
                const targetTextInfo = await this.findAndGroupTargetText(
                    ocrResults.individualTexts, 
                    searchText, 
                    geminiResult.targetValue
                );
                
                if (!targetTextInfo || !targetTextInfo.coordinates) {
                    console.log('Could not locate target text precisely, falling back to auto mask...');
                    const inpaintedPath = await this.inpaintImageWithAutoMask(
                        imagePath, 
                        `${inpaintPrompt}. Remove "${geminiResult.targetValue}"`,
                        "MASK_MODE_SEMANTIC"
                    );
                    
                    results = {
                        originalImage: imagePath,
                        foundText: {
                            searchText: searchText,
                            associatedText: geminiResult.targetValue,
                            coordinates: null,
                            groupedTexts: [],
                            confidence: 0.6
                        },
                        geminiAnalysis: geminiResult,
                        maskImage: null,
                        highlightedImage: null,
                        inpaintedImage: inpaintedPath,
                        method: "auto_mask_fallback"
                    };
                } else {
                    // Step 4: Create manual mask around the grouped text
                    const maskPath = await this.createMask(imagePath, targetTextInfo.coordinates, padding);
                    
                    // Step 5: Create highlighted image (if requested)
                    let highlightedPath = null;
                    if (createHighlight) {
                        if (targetTextInfo.groupedTexts && targetTextInfo.groupedTexts.length > 1) {
                            // Multi-highlight for grouped texts
                            highlightedPath = await this.createMultiHighlightedImage(
                                imagePath, 
                                targetTextInfo.groupedTexts, 
                                padding
                            );
                        } else {
                            // Single highlight for combined coordinates
                            highlightedPath = await this.createHighlightedImage(
                                imagePath, 
                                targetTextInfo.coordinates, 
                                padding
                            );
                        }
                    }
                    
                    // Step 6: Inpaint with manual mask
                    const inpaintedPath = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
                    
                    results = {
                        originalImage: imagePath,
                        foundText: {
                            searchText: searchText,
                            associatedText: geminiResult.targetValue,
                            coordinates: targetTextInfo.coordinates,
                            groupedTexts: targetTextInfo.groupedTexts,
                            confidence: targetTextInfo.confidence
                        },
                        geminiAnalysis: geminiResult,
                        maskImage: maskPath,
                        highlightedImage: highlightedPath,
                        inpaintedImage: inpaintedPath,
                        method: "manual_mask"
                    };
                }
            }
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            results.processingTime = processingTime;
            
            console.log(`=== Enhanced workflow completed successfully using ${results.method} ===`);
            
            return results;
            
        } catch (error) {
            console.error('Error in enhanced workflow:', error);
            throw error;
        }
    }

    /**
     * Use Gemini Vision to analyze the image and find the target value
     */
    async analyzeImageWithGemini(imagePath, searchText) {
        try {
            console.log(`Analyzing image with Gemini for: "${searchText}"`);
            
            // Read and encode the image
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            const prompt = `Analyze this image and find the value associated with "${searchText}". 

Instructions:
1. Look for the text "${searchText}" in the image
2. Identify what value or text appears next to it or is associated with it
3. Return the exact text as it appears in the image
4. Be precise with the formatting (including spaces, hyphens, etc.)

Example: If you see "Packed On: 27-Jan-21", return "27-Jan-21"

Respond in JSON format:
{
  "found": true/false,
  "searchText": "${searchText}",
  "targetValue": "the exact associated value",
  "context": "brief description of where it was found",
  "confidence": "high/medium/low"
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
            
            console.log('Gemini raw response:', text);
            
            // Parse JSON response
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    if (parsedResult.found && parsedResult.targetValue) {
                        return parsedResult;
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response, using fallback');
            }
            
            // Fallback: extract target value from text
            const fallbackResult = this.extractTargetValueFromText(text, searchText);
            return fallbackResult;
            
        } catch (error) {
            console.error('Error in Gemini analysis:', error);
            // Return fallback result
            return {
                found: false,
                searchText: searchText,
                targetValue: null,
                context: "Gemini analysis failed",
                confidence: "low"
            };
        }
    }

    /**
     * Fallback method to extract target value from Gemini text response
     */
    extractTargetValueFromText(text, searchText) {
        const lines = text.split('\n');
        let targetValue = null;
        
        for (const line of lines) {
            if (line.toLowerCase().includes(searchText.toLowerCase())) {
                // Look for patterns like "Packed On: 27-Jan-21" or "27-Jan-21"
                const matches = line.match(/[0-9]{1,2}[-\/][A-Za-z]{3}[-\/][0-9]{2,4}/);
                if (matches) {
                    targetValue = matches[0];
                    break;
                }
            }
        }
        
        return {
            found: !!targetValue,
            searchText: searchText,
            targetValue: targetValue,
            context: "Extracted from text response",
            confidence: targetValue ? "medium" : "low"
        };
    }

    /**
     * Smart text grouping to combine fragmented OCR results
     */
    async findAndGroupTargetText(ocrTexts, searchText, targetValue) {
        try {
            console.log(`Finding and grouping target text: "${targetValue}"`);
            
            if (!targetValue) {
                // Fallback to original method if Gemini didn't find anything
                return this.findAssociatedTextFallback(ocrTexts, searchText);
            }
            
            // Clean the target value for comparison
            const cleanTargetValue = targetValue.replace(/\s+/g, '');
            
            // Group nearby text elements that could form the target value
            const groupedCandidates = this.groupNearbyTexts(ocrTexts);
            
            // Find the best matching group
            let bestMatch = null;
            let bestScore = 0;
            
            for (const group of groupedCandidates) {
                const groupText = group.texts.map(t => t.text).join('').replace(/\s+/g, '');
                const similarity = this.calculateSimilarity(cleanTargetValue, groupText);
                
                if (similarity > bestScore && similarity > 0.7) { // 70% similarity threshold
                    bestScore = similarity;
                    bestMatch = group;
                }
            }
            
            if (bestMatch) {
                const combinedCoordinates = this.combineCoordinates(bestMatch.texts.map(t => t.coordinates));
                return {
                    coordinates: combinedCoordinates,
                    groupedTexts: bestMatch.texts,
                    confidence: bestScore,
                    matchedText: bestMatch.texts.map(t => t.text).join('')
                };
            }
            
            // Fallback: try exact substring matching
            const exactMatch = this.findExactSubstringMatch(ocrTexts, targetValue);
            if (exactMatch) {
                return exactMatch;
            }
            
            throw new Error(`Could not find target text "${targetValue}" in OCR results`);
            
        } catch (error) {
            console.error('Error in finding and grouping target text:', error);
            throw error;
        }
    }

    /**
     * Group nearby text elements that could form a single word/phrase
     */
    groupNearbyTexts(ocrTexts) {
        const groups = [];
        const used = new Set();
        
        for (let i = 0; i < ocrTexts.length; i++) {
            if (used.has(i)) continue;
            
            const group = { texts: [ocrTexts[i]], indices: [i] };
            used.add(i);
            
            // Look for nearby texts within reasonable distance
            const baseCoords = ocrTexts[i].coordinates;
            const baseY = (baseCoords[0].y + baseCoords[2].y) / 2;
            const baseHeight = baseCoords[2].y - baseCoords[0].y;
            
            for (let j = i + 1; j < ocrTexts.length; j++) {
                if (used.has(j)) continue;
                
                const candidateCoords = ocrTexts[j].coordinates;
                const candidateY = (candidateCoords[0].y + candidateCoords[2].y) / 2;
                const candidateHeight = candidateCoords[2].y - candidateCoords[0].y;
                
                // Check if texts are on similar Y level (same line)
                const yDiff = Math.abs(baseY - candidateY);
                const avgHeight = (baseHeight + candidateHeight) / 2;
                
                if (yDiff < avgHeight * 0.5) { // Same line threshold
                    // Check horizontal distance
                    const lastText = group.texts[group.texts.length - 1];
                    const lastCoords = lastText.coordinates;
                    const rightEdge = Math.max(...lastCoords.map(c => c.x));
                    const leftEdge = Math.min(...candidateCoords.map(c => c.x));
                    
                    const horizontalGap = leftEdge - rightEdge;
                    
                    // If gap is reasonable (not too far apart)
                    if (horizontalGap >= -5 && horizontalGap <= avgHeight * 2) {
                        group.texts.push(ocrTexts[j]);
                        group.indices.push(j);
                        used.add(j);
                    }
                }
            }
            
            groups.push(group);
        }
        
        return groups;
    }

    /**
     * Find exact substring match in OCR results
     */
    findExactSubstringMatch(ocrTexts, targetValue) {
        const targetParts = targetValue.split(/[-\/\s]/);
        
        for (let i = 0; i < ocrTexts.length; i++) {
            const matchingTexts = [];
            let currentIndex = i;
            
            for (const part of targetParts) {
                let found = false;
                
                // Look for this part within a reasonable range
                for (let j = currentIndex; j < Math.min(currentIndex + 5, ocrTexts.length); j++) {
                    if (ocrTexts[j].text.trim().toLowerCase() === part.toLowerCase()) {
                        matchingTexts.push(ocrTexts[j]);
                        currentIndex = j + 1;
                        found = true;
                        break;
                    }
                }
                
                if (!found) break;
            }
            
            if (matchingTexts.length === targetParts.length) {
                const combinedCoordinates = this.combineCoordinates(matchingTexts.map(t => t.coordinates));
                return {
                    coordinates: combinedCoordinates,
                    groupedTexts: matchingTexts,
                    confidence: 0.9,
                    matchedText: matchingTexts.map(t => t.text).join('')
                };
            }
        }
        
        return null;
    }

    /**
     * Calculate text similarity
     */
    calculateSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }

    /**
     * Calculate Levenshtein distance
     */
    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
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
     * Fallback method for finding associated text (original approach)
     */
    findAssociatedTextFallback(ocrTexts, searchText) {
        const searchLower = searchText.toLowerCase();
        let targetIndex = -1;
        
        // Find the search text
        for (let i = 0; i < ocrTexts.length; i++) {
            if (ocrTexts[i].text.toLowerCase().includes(searchLower)) {
                targetIndex = i;
                break;
            }
        }
        
        if (targetIndex === -1) {
            return null;
        }

        // Look for nearby text elements
        for (let i = targetIndex + 1; i < Math.min(targetIndex + 5, ocrTexts.length); i++) {
            const text = ocrTexts[i].text;
            if (text.length > 1 && !/^[^\w\s]$/.test(text)) {
                return {
                    coordinates: ocrTexts[i].coordinates,
                    groupedTexts: [ocrTexts[i]],
                    confidence: 0.6,
                    matchedText: text
                };
            }
        }
        
        return null;
    }

    /**
     * Create a highlighted version of the original image showing the masked area
     */
    async createHighlightedImage(imagePath, coordinates, padding = 5, highlightColor = { r: 255, g: 0, b: 0, alpha: 0.5 }) {
        try {
            console.log('Creating highlighted image showing masked area...');
            
            // Get image dimensions
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            // Calculate bounding box
            const xs = coordinates.map(coord => coord.x || 0);
            const ys = coordinates.map(coord => coord.y || 0);
            
            const minX = Math.max(0, Math.min(...xs) - padding);
            const minY = Math.max(0, Math.min(...ys) - padding);
            const maxX = Math.min(width, Math.max(...xs) + padding);
            const maxY = Math.min(height, Math.max(...ys) + padding);
            
            const overlayWidth = maxX - minX;
            const overlayHeight = maxY - minY;
            
            console.log(`Highlight overlay dimensions: ${overlayWidth}x${overlayHeight} at position (${minX}, ${minY})`);
            
            // Create a semi-transparent red overlay
            const overlay = await sharp({
                create: {
                    width: overlayWidth,
                    height: overlayHeight,
                    channels: 4,
                    background: {
                        r: highlightColor.r,
                        g: highlightColor.g,
                        b: highlightColor.b,
                        alpha: highlightColor.alpha
                    }
                }
            }).png().toBuffer();
            
            // Create highlighted image by compositing the overlay on the original
            const highlightedImageBuffer = await sharp(imagePath)
                .composite([{
                    input: overlay,
                    top: minY,
                    left: minX,
                    blend: 'over'
                }])
                .png()
                .toBuffer();
            
            // Save highlighted image
            const highlightedPath = imagePath.replace(path.extname(imagePath), '_highlighted.png');
            fs.writeFileSync(highlightedPath, highlightedImageBuffer);
            
            console.log(`Highlighted image saved to: ${highlightedPath}`);
            return highlightedPath;
            
        } catch (error) {
            console.error('Error creating highlighted image:', error);
            throw error;
        }
    }

    /**
     * Create a highlighted version showing multiple text areas (for grouped texts)
     */
    async createMultiHighlightedImage(imagePath, groupedTexts, padding = 5, highlightColors = null) {
        try {
            console.log('Creating multi-highlighted image for grouped texts...');
            
            if (!groupedTexts || groupedTexts.length === 0) {
                throw new Error('No grouped texts provided for highlighting');
            }
            
            // Default colors for multiple highlights
            const defaultColors = [
                { r: 255, g: 0, b: 0, alpha: 0.4 },     // Red
                { r: 0, g: 255, b: 0, alpha: 0.4 },     // Green
                { r: 0, g: 0, b: 255, alpha: 0.4 },     // Blue
                { r: 255, g: 255, b: 0, alpha: 0.4 },   // Yellow
                { r: 255, g: 0, b: 255, alpha: 0.4 }    // Magenta
            ];
            
            const colors = highlightColors || defaultColors;
            
            // Start with the original image
            let imageProcessor = sharp(imagePath);
            const compositeOps = [];
            
            // Create overlay for each grouped text
            for (let i = 0; i < groupedTexts.length; i++) {
                const text = groupedTexts[i];
                const color = colors[i % colors.length];
                
                const xs = text.coordinates.map(coord => coord.x || 0);
                const ys = text.coordinates.map(coord => coord.y || 0);
                
                const minX = Math.max(0, Math.min(...xs) - padding);
                const minY = Math.max(0, Math.min(...ys) - padding);
                const maxX = Math.max(...xs) + padding;
                const maxY = Math.max(...ys) + padding;
                
                const overlayWidth = maxX - minX;
                const overlayHeight = maxY - minY;
                
                // Create individual overlay
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
                
                console.log(`Created highlight for text "${text.text}" at (${minX}, ${minY})`);
            }
            
            // Apply all overlays at once
            const multiHighlightedBuffer = await imageProcessor
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            // Save multi-highlighted image
            const multiHighlightedPath = imagePath.replace(path.extname(imagePath), '_multi_highlighted.png');
            fs.writeFileSync(multiHighlightedPath, multiHighlightedBuffer);
            
            console.log(`Multi-highlighted image saved to: ${multiHighlightedPath}`);
            return multiHighlightedPath;
            
        } catch (error) {
            console.error('Error creating multi-highlighted image:', error);
            throw error;
        }
    }

    /**
     * Use Imagen 3 Capability API for inpainting with automatic mask generation
     */
    async inpaintImageWithAutoMask(imagePath, prompt = "clean background, no text", maskMode = "MASK_MODE_SEMANTIC") {
        try {
            console.log('Starting inpainting with automatic mask generation...');
            
            const authClient = await this.auth.getClient();
            const tokenResponse = await authClient.getAccessToken();
            const accessToken = tokenResponse.token;
            
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict`;
            
            // Request with automatic mask generation
            const requestBody = {
                instances: [{
                    prompt: prompt,
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
                                bytesBase64Encoded: imageBase64 // Same image for auto mask generation
                            },
                            maskImageConfig: {
                                maskMode: maskMode,
                                dilation: 0.05 // Slight dilation for better coverage
                            }
                        }
                    ]
                }],
                parameters: {
                    sampleCount: 1,
                    safetyFilterLevel: "block_some",
                    personGeneration: "dont_allow",
                    language: "en"
                }
            };
            
            const response = await axios.post(apiUrl, requestBody, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            
            if (response.data.predictions && response.data.predictions.length > 0) {
                const prediction = response.data.predictions[0];
                
                let generatedImageBase64;
                if (prediction.bytesBase64Encoded) {
                    generatedImageBase64 = prediction.bytesBase64Encoded;
                } else if (prediction.generatedImage && prediction.generatedImage.bytesBase64Encoded) {
                    generatedImageBase64 = prediction.generatedImage.bytesBase64Encoded;
                } else if (prediction.images && prediction.images.length > 0) {
                    generatedImageBase64 = prediction.images[0].bytesBase64Encoded;
                } else {
                    throw new Error('No image data found in API response');
                }
                
                const generatedImageBuffer = Buffer.from(generatedImageBase64, 'base64');
                
                const outputPath = imagePath.replace(path.extname(imagePath), '_auto_inpainted.png');
                fs.writeFileSync(outputPath, generatedImageBuffer);
                
                console.log(`Auto-inpainted image saved to: ${outputPath}`);
                return outputPath;
            } else {
                throw new Error('No predictions returned from Imagen API');
            }
            
        } catch (error) {
            console.error('Error in auto-mask inpainting:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Use Imagen 3 Capability API for inpainting with proper mask reference handling
     */
    async inpaintImage(imagePath, maskPath, prompt = "clean background, seamless text removal`") {
        try {
            console.log('Starting inpainting process with Imagen 3 Capability model...');
            
            const authClient = await this.auth.getClient();
            const tokenResponse = await authClient.getAccessToken();
            const accessToken = tokenResponse.token;
            
            const imageBuffer = fs.readFileSync(imagePath);
            const maskBuffer = fs.readFileSync(maskPath);
            
            const imageBase64 = imageBuffer.toString('base64');
            const maskBase64 = maskBuffer.toString('base64');
            
            // Use the new imagen-3.0-capability-001 model endpoint
            const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict`;
            
            // New API structure with reference images
            const requestBody = {
                instances: [{
                    prompt: prompt,
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
                                dilation: 0.0
                            }
                        }
                    ]
                }],
                parameters: {
                    sampleCount: 1,
                    // safetyFilterLevel: "block_some",
                    // personGeneration: "dont_allow",
                    language: "en",
                    editMode: "EDIT_MODE_INPAINT_REMOVAL"
                }
            };
            
            console.log('Sending request to Imagen 3 Capability API...');
            
            const response = await axios.post(apiUrl, requestBody, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000 // 60 second timeout
            });
            
            if (response.data.predictions && response.data.predictions.length > 0) {
                const prediction = response.data.predictions[0];
                
                // Handle different response formats
                let generatedImageBase64;
                if (prediction.bytesBase64Encoded) {
                    generatedImageBase64 = prediction.bytesBase64Encoded;
                } else if (prediction.generatedImage && prediction.generatedImage.bytesBase64Encoded) {
                    generatedImageBase64 = prediction.generatedImage.bytesBase64Encoded;
                } else if (prediction.images && prediction.images.length > 0) {
                    generatedImageBase64 = prediction.images[0].bytesBase64Encoded;
                } else {
                    throw new Error('No image data found in API response');
                }
                
                const generatedImageBuffer = Buffer.from(generatedImageBase64, 'base64');
                
                const outputPath = imagePath.replace(path.extname(imagePath), '_inpainted.png');
                fs.writeFileSync(outputPath, generatedImageBuffer);
                
                console.log(`Inpainted image saved to: ${outputPath}`);
                return outputPath;
            } else {
                throw new Error('No predictions returned from Imagen API');
            }
            
        } catch (error) {
            console.error('Error in inpainting:', error.response?.data || error.message);
            
            // Provide more detailed error information
            if (error.response?.data) {
                console.error('API Error Details:', JSON.stringify(error.response.data, null, 2));
            }
            
            throw error;
        }
    }

    /**
     * Get full OCR results including individual texts
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
     * Create mask around coordinates
     */
    async createMask(imagePath, coordinates, padding = 5) {
        try {
            console.log('Creating mask for coordinates:', coordinates);
            
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            const xs = coordinates.map(coord => coord.x || 0);
            const ys = coordinates.map(coord => coord.y || 0);
            
            const minX = Math.max(0, Math.min(...xs) - padding);
            const minY = Math.max(0, Math.min(...ys) - padding);
            const maxX = Math.min(width, Math.max(...xs) + padding);
            const maxY = Math.min(height, Math.max(...ys) + padding);
            
            const maskWidth = maxX - minX;
            const maskHeight = maxY - minY;
            
            console.log(`Mask dimensions: ${maskWidth}x${maskHeight} at position (${minX}, ${minY})`);
            
            const maskBuffer = await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 0, g: 0, b: 0 }
                }
            })
            .composite([{
                input: await sharp({
                    create: {
                        width: maskWidth,
                        height: maskHeight,
                        channels: 3,
                        background: { r: 255, g: 255, b: 255 }
                    }
                }).png().toBuffer(),
                top: minY,
                left: minX
            }])
            .png()
            .toBuffer();
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_mask.png');
            fs.writeFileSync(maskPath, maskBuffer);
            
            console.log(`Mask saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating mask:', error);
            throw error;
        }
    }

    /**
     * Find text coordinates in image
     */
    async findTextCoordinates(imagePath, searchText) {
        try {
            console.log(`Performing OCR on image: ${imagePath}`);
            
            const imageBuffer = fs.readFileSync(imagePath);
            
            const [result] = await this.visionClient.textDetection({
                image: { content: imageBuffer }
            });

            const detections = result.textAnnotations;
            
            if (!detections || detections.length === 0) {
                throw new Error('No text found in image');
            }

            const foundText = this.findAssociatedTextFallback(detections.slice(1), searchText);
            
            if (!foundText) {
                throw new Error(`Text "${searchText}" not found in image`);
            }

            console.log(`Found "${searchText}" with associated text: "${foundText.matchedText}"`);
            console.log('Coordinates:', foundText.coordinates);
            
            return foundText;
        } catch (error) {
            console.error('Error in OCR:', error);
            throw error;
        }
    }

    /**
     * Detect all text in image without searching for specific text
     */
    async detectAllText(imagePath) {
        try {
            console.log(`Detecting all text in image: ${imagePath}`);
            
            const imageBuffer = fs.readFileSync(imagePath);
            
            const [result] = await this.visionClient.textDetection({
                image: { content: imageBuffer }
            });

            const detections = result.textAnnotations;
            
            if (!detections || detections.length === 0) {
                return [];
            }

            return detections.slice(1).map((detection, index) => ({
                id: index + 1,
                text: detection.description,
                coordinates: detection.boundingPoly.vertices,
                confidence: detection.confidence || null
            }));
        } catch (error) {
            console.error('Error detecting all text:', error);
            throw error;
        }
    }

    /**
     * Create mask for manually specified coordinates
     */
    async createManualMask(imagePath, boundingBox, padding = 5) {
        try {
            console.log('Creating manual mask for bounding box:', boundingBox);
            
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            const { x, y, width: boxWidth, height: boxHeight } = boundingBox;
            
            const minX = Math.max(0, x - padding);
            const minY = Math.max(0, y - padding);
            const maxX = Math.min(width, x + boxWidth + padding);
            const maxY = Math.min(height, y + boxHeight + padding);
            
            const maskWidth = maxX - minX;
            const maskHeight = maxY - minY;
            
            console.log(`Manual mask dimensions: ${maskWidth}x${maskHeight} at position (${minX}, ${minY})`);
            
            const maskBuffer = await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 0, g: 0, b: 0 }
                }
            })
            .composite([{
                input: await sharp({
                    create: {
                        width: maskWidth,
                        height: maskHeight,
                        channels: 3,
                        background: { r: 255, g: 255, b: 255 }
                    }
                }).png().toBuffer(),
                top: minY,
                left: minX
            }])
            .png()
            .toBuffer();
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_manual_mask.png');
            fs.writeFileSync(maskPath, maskBuffer);
            
            console.log(`Manual mask saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating manual mask:', error);
            throw error;
        }
    }

    /**
     * Process image with manual coordinates (skip OCR)
     */
    async processImageWithManualCoordinates(imagePath, boundingBox, inpaintPrompt = "clean background, seamless removal", padding = 5) {
        try {
            console.log('=== Starting manual coordinates inpainting workflow ===');
            const startTime = Date.now();
            
            const maskPath = await this.createManualMask(imagePath, boundingBox, padding);
            const inpaintedPath = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            
            console.log('=== Manual coordinates workflow completed successfully ===');
            
            return {
                originalImage: imagePath,
                boundingBox: boundingBox,
                maskImage: maskPath,
                inpaintedImage: inpaintedPath,
                processingTime: processingTime
            };
            
        } catch (error) {
            console.error('Error in manual coordinates workflow:', error);
            throw error;
        }
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
     * Clean up temporary files (preserves inpainted images)
     */
    cleanupFiles(filePaths) {
        filePaths.forEach(filePath => {
            try {
                if (fs.existsSync(filePath)) {
                    // Check if filename contains 'inpainted' - if so, preserve it
                    const filename = path.basename(filePath).toLowerCase();
                    if (filename.includes('inpainted')) {
                        console.log(`Preserving inpainted file: ${filePath}`);
                        return; // Skip deletion for inpainted files
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
module.exports = new CompleteEnhancedOCRInpaintingService();