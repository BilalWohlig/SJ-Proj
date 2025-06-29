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
 * Supports both single and multiple text search modes
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
     * Complete workflow with Gemini integration (Manual masking only, no auto-masking)
     * Supports both single and multiple text search
     */
    async processImage(imagePath, searchText, inpaintPrompt = "clean background, seamless removal", padding = 5, useAutoMask = false, createHighlight = true, searchTexts = null) {
        try {
            console.log('=== Starting enhanced OCR + Gemini + Inpainting workflow (Manual masking only) ===');
            const startTime = Date.now();
            
            // Determine if we're doing single or multiple text search
            const isMultipleSearch = searchTexts && Array.isArray(searchTexts) && searchTexts.length > 0;
            const searchTerms = isMultipleSearch ? searchTexts : [searchText];
            
            console.log(`Search mode: ${isMultipleSearch ? 'Multiple' : 'Single'}`);
            console.log(`Search terms:`, searchTerms);
            
            // Step 1: Use Gemini to understand the image and find the target values
            const geminiResult = await this.analyzeImageWithGemini(imagePath, searchTerms, isMultipleSearch);
            console.log('Gemini analysis result:', geminiResult);
            
            let results;
            
            if (!geminiResult.found || (isMultipleSearch && (!geminiResult.foundFields || geminiResult.foundFields.length === 0))) {
                const errorMsg = isMultipleSearch 
                    ? `None of the search terms ${JSON.stringify(searchTerms)} were found in the image`
                    : `Text "${searchText}" not found in the image via Gemini analysis`;
                throw new Error(errorMsg);
            }

            // Step 2: Perform OCR to get all text with coordinates
            const ocrResults = await this.getFullOCRResults(imagePath);
            
            // Step 3: Find and group the target text using smart matching
            let targetTextInfo;
            if (isMultipleSearch) {
                targetTextInfo = await this.findAndGroupMultipleTargetTexts(
                    ocrResults.individualTexts, 
                    geminiResult.foundFields
                );
            } else {
                // For single search, we need to handle complete field structure
                if (geminiResult.completeText) {
                    // Create a field structure for consistency
                    const singleField = {
                        fieldName: geminiResult.searchText,
                        completeText: geminiResult.completeText,
                        fieldPart: geminiResult.fieldPart || geminiResult.searchText,
                        valuePart: geminiResult.valuePart || geminiResult.completeText
                    };
                    targetTextInfo = await this.findAndGroupMultipleTargetTexts(
                        ocrResults.individualTexts, 
                        [singleField]
                    );
                } else {
                    // Fallback to old method for backward compatibility
                    targetTextInfo = await this.findAndGroupTargetText(
                        ocrResults.individualTexts, 
                        searchText, 
                        geminiResult.targetValue || geminiResult.completeText
                    );
                }
            }
            
            if (!targetTextInfo || (!targetTextInfo.coordinates && !targetTextInfo.individualCoordinates)) {
                const errorMsg = isMultipleSearch 
                    ? `Could not locate any of the target texts precisely in OCR results`
                    : `Could not locate target text "${geminiResult.targetValue}" precisely in OCR results`;
                throw new Error(errorMsg);
            }

            // Step 4: Create manual mask around the individual text areas (required)
            let maskPath;
            if (isMultipleSearch && targetTextInfo.individualCoordinates) {
                // Create composite mask with individual areas
                maskPath = await this.createMultiAreaMask(imagePath, targetTextInfo.individualCoordinates, padding);
            } else {
                // Single area mask (backward compatibility)
                const coordinates = targetTextInfo.coordinates || targetTextInfo.individualCoordinates?.[0]?.coordinates;
                if (!coordinates) {
                    throw new Error('No coordinates found for masking');
                }
                maskPath = await this.createMask(imagePath, coordinates, padding);
            }
            
            // Step 5: Create highlighted image (required)
            let highlightedPath = null;
            if (isMultipleSearch && targetTextInfo.allGroupedTexts && targetTextInfo.allGroupedTexts.length > 1) {
                // Multi-highlight for multiple found texts
                highlightedPath = await this.createMultiHighlightedImage(
                    imagePath, 
                    targetTextInfo.allGroupedTexts, 
                    padding
                );
            } else if (targetTextInfo.groupedTexts && targetTextInfo.groupedTexts.length > 1) {
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
            
            // Step 6: Inpaint with manual mask (generates 4 samples)
            const inpaintedPaths = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
            
            // Prepare found text results
            const foundTextResults = isMultipleSearch ? {
                searchTexts: searchTerms,
                foundFields: geminiResult.foundFields.map(field => ({
                    fieldName: field.fieldName,
                    completeText: field.completeText,
                    fieldPart: field.fieldPart,
                    valuePart: field.valuePart,
                    context: field.context,
                    confidence: field.confidence
                })),
                allFoundTexts: targetTextInfo.allFoundTexts || [],
                individualCoordinates: targetTextInfo.individualCoordinates || [],
                confidence: targetTextInfo.confidence,
                totalFound: geminiResult.foundFields.length,
                removalType: "complete_fields",
                maskingType: targetTextInfo.maskingType || "individual_areas"
            } : {
                searchText: searchText,
                completeText: geminiResult.completeText || geminiResult.targetValue,
                fieldPart: geminiResult.fieldPart || searchText,
                valuePart: geminiResult.valuePart || geminiResult.targetValue,
                coordinates: targetTextInfo.coordinates,
                searchCoordinates: targetTextInfo.coordinates,
                groupedTexts: targetTextInfo.groupedTexts,
                confidence: targetTextInfo.confidence,
                removalType: geminiResult.completeText ? "complete_field" : "value_only"
            };
            
            results = {
                originalImage: imagePath,
                foundText: foundTextResults,
                geminiAnalysis: geminiResult,
                maskImage: maskPath,
                highlightedImage: highlightedPath, // Always included
                inpaintedImages: inpaintedPaths, // Array of 4 images
                method: isMultipleSearch ? "manual_mask_4_samples_multiple" : "manual_mask_4_samples"
            };
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            results.processingTime = processingTime;
            
            console.log(`=== Enhanced workflow completed successfully using ${results.method} ===`);
            console.log(`Generated ${inpaintedPaths.length} inpainted variations`);
            
            return results;
            
        } catch (error) {
            console.error('Error in enhanced workflow:', error);
            throw error;
        }
    }

    /**
     * Use Gemini Vision to analyze the image and find complete field-value pairs
     * Supports both single and multiple search terms
     */
    async analyzeImageWithGemini(imagePath, searchTerms, isMultipleSearch = false) {
        try {
            const searchText = Array.isArray(searchTerms) ? searchTerms.join(', ') : searchTerms;
            console.log(`Analyzing image with Gemini for complete fields: "${searchText}"`);
            
            // Read and encode the image
            const imageBuffer = fs.readFileSync(imagePath);
            const imageBase64 = imageBuffer.toString('base64');
            
            let prompt;
            if (isMultipleSearch) {
                prompt = `Analyze this image and find the COMPLETE field-value pairs for these field names: ${JSON.stringify(searchTerms)}. 

IMPORTANT: I need to remove the ENTIRE field (both the field name AND its value), not just the value.

Instructions:
1. Look for each field name in the image (like "B.No.", "MFG.DATE", "EXP.DATE")
2. Find the complete text including the field name, separator (:), and the value
3. Return the FULL text that needs to be removed (field name + separator + value)

Example: 
- If you see "B.No.: SHE4105", return "B.No.: SHE4105" (complete field)
- If you see "MFG.DATE: 12/2024", return "MFG.DATE: 12/2024" (complete field)

Respond in JSON format:
{
  "found": true/false,
  "foundFields": [
    {
      "fieldName": "B.No.",
      "completeText": "B.No.: SHE4105",
      "fieldPart": "B.No.:",
      "valuePart": "SHE4105",
      "context": "found at bottom of package",
      "confidence": "high"
    },
    {
      "fieldName": "MFG.DATE",
      "completeText": "MFG.DATE: 12/2024",
      "fieldPart": "MFG.DATE:",
      "valuePart": "12/2024",
      "context": "found at bottom of package",
      "confidence": "high"
    }
  ],
  "totalFound": 2,
  "searchTerms": ${JSON.stringify(searchTerms)}
}`;
            } else {
                const singleSearchTerm = Array.isArray(searchTerms) ? searchTerms[0] : searchTerms;
                prompt = `Analyze this image and find the COMPLETE field-value pair for "${singleSearchTerm}". 

IMPORTANT: I need to remove the ENTIRE field (both the field name AND its value), not just the value.

Instructions:
1. Look for the field name "${singleSearchTerm}" in the image
2. Find the complete text including the field name, separator, and the value
3. Return the FULL text that needs to be removed

Example: If you see "B.No.: SHE4105", return "B.No.: SHE4105"

Respond in JSON format:
{
  "found": true/false,
  "searchText": "${singleSearchTerm}",
  "completeText": "the complete field-value text to remove",
  "fieldPart": "the field name part",
  "valuePart": "the value part",
  "context": "brief description of where it was found",
  "confidence": "high/medium/low"
}`;
            }

            const imagePart = {
                inlineData: {
                    data: imageBase64,
                    mimeType: this.getMimeType(imagePath)
                }
            };

            const result = await this.geminiModel.generateContent([prompt, imagePart]);
            const response = await result.response;
            const text = response.text();
            
            console.log('Gemini raw response for complete fields:', text);
            
            // Parse JSON response
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    if (isMultipleSearch) {
                        if (parsedResult.found && parsedResult.foundFields && parsedResult.foundFields.length > 0) {
                            return parsedResult;
                        }
                    } else {
                        if (parsedResult.found && parsedResult.completeText) {
                            return parsedResult;
                        }
                    }
                }
            } catch (parseError) {
                console.warn('Could not parse Gemini JSON response, using fallback');
            }
            
            // Fallback: extract complete field-value pairs from text
            if (isMultipleSearch) {
                const fallbackResult = this.extractMultipleCompleteFieldsFromText(text, searchTerms);
                return fallbackResult;
            } else {
                const singleSearchTerm = Array.isArray(searchTerms) ? searchTerms[0] : searchTerms;
                const fallbackResult = this.extractCompleteFieldFromText(text, singleSearchTerm);
                return fallbackResult;
            }
            
        } catch (error) {
            console.error('Error in Gemini analysis for complete fields:', error);
            // Return fallback result
            if (isMultipleSearch) {
                return {
                    found: false,
                    foundFields: [],
                    totalFound: 0,
                    searchTerms: searchTerms,
                    context: "Gemini analysis failed"
                };
            } else {
                const singleSearchTerm = Array.isArray(searchTerms) ? searchTerms[0] : searchTerms;
                return {
                    found: false,
                    searchText: singleSearchTerm,
                    completeText: null,
                    context: "Gemini analysis failed",
                    confidence: "low"
                };
            }
        }
    }

    /**
     * Fallback method to extract complete field from Gemini text response (single search)
     */
    extractCompleteFieldFromText(text, searchTerm) {
        const lines = text.split('\n');
        let completeText = null;
        
        for (const line of lines) {
            if (line.toLowerCase().includes(searchTerm.toLowerCase())) {
                // Look for patterns like "B.No.: SHE4105" or "MFG.DATE: 12/2024"
                const fieldPatterns = [
                    new RegExp(`${searchTerm.replace('.', '\\.')}\\s*:?\\s*[^\\n]*`, 'i'),
                    new RegExp(`${searchTerm.replace(/\./g, '\\.')}[:\\s]+[^\\s][^\\n]*`, 'i')
                ];
                
                for (const pattern of fieldPatterns) {
                    const matches = line.match(pattern);
                    if (matches) {
                        completeText = matches[0].trim();
                        break;
                    }
                }
                
                if (completeText) break;
            }
        }
        
        return {
            found: !!completeText,
            searchText: searchTerm,
            completeText: completeText,
            fieldPart: searchTerm,
            valuePart: completeText ? completeText.replace(searchTerm, '').replace(/^[:\s]+/, '') : null,
            context: "Extracted from text response",
            confidence: completeText ? "medium" : "low"
        };
    }

    /**
     * Fallback method to extract multiple complete fields from Gemini text response
     */
    extractMultipleCompleteFieldsFromText(text, searchTerms) {
        const lines = text.split('\n');
        const foundFields = [];
        
        for (const searchTerm of searchTerms) {
            let completeText = null;
            
            for (const line of lines) {
                if (line.toLowerCase().includes(searchTerm.toLowerCase())) {
                    // Look for complete field patterns
                    const fieldPatterns = [
                        new RegExp(`${searchTerm.replace(/\./g, '\\.')}\\s*:?\\s*[^\\n]*`, 'i'),
                        new RegExp(`${searchTerm.replace(/\./g, '\\.')}[:\\s]+[^\\s][^\\n]*`, 'i')
                    ];
                    
                    for (const pattern of fieldPatterns) {
                        const matches = line.match(pattern);
                        if (matches) {
                            completeText = matches[0].trim();
                            break;
                        }
                    }
                    
                    if (completeText) break;
                }
            }
            
            if (completeText) {
                const valuePart = completeText.replace(searchTerm, '').replace(/^[:\s]+/, '');
                foundFields.push({
                    fieldName: searchTerm,
                    completeText: completeText,
                    fieldPart: searchTerm,
                    valuePart: valuePart,
                    context: "Extracted from text response",
                    confidence: "medium"
                });
            }
        }
        
        return {
            found: foundFields.length > 0,
            foundFields: foundFields,
            totalFound: foundFields.length,
            searchTerms: searchTerms,
            context: "Extracted from text response"
        };
    }

    /**
     * Find and group multiple complete field-value pairs in OCR results
     * Returns individual coordinates for separate masking
     */
    async findAndGroupMultipleTargetTexts(ocrTexts, foundFields) {
        try {
            console.log(`Finding and grouping multiple complete fields:`, foundFields.map(f => f.completeText));
            
            if (!foundFields || foundFields.length === 0) {
                throw new Error('No target fields provided for multiple text search');
            }
            
            // Log all OCR detected texts for debugging
            console.log('All OCR detected texts:', ocrTexts.map(t => t.text));
            
            const allFoundTexts = [];
            const allGroupedTexts = [];
            const individualCoordinates = []; // Store individual coordinates separately
            
            // Process each found field
            for (const field of foundFields) {
                const completeText = field.completeText;
                console.log(`\n--- Processing complete field: ${field.fieldName} = "${completeText}" ---`);
                
                if (!completeText) continue;
                
                // Step 1: Try to find the complete field as one piece
                let bestMatch = this.findCompleteFieldInOCR(ocrTexts, completeText, field.fieldPart, field.valuePart);
                let matchType = "complete_field";
                
                if (!bestMatch) {
                    // Step 2: Try to find field and value separately then combine
                    bestMatch = this.findFieldValueSeparately(ocrTexts, field.fieldPart, field.valuePart);
                    matchType = "separate_field_value";
                }
                
                if (!bestMatch) {
                    // Step 3: Try similarity matching with relaxed threshold
                    bestMatch = this.findSimilarityMatch(ocrTexts, completeText, 0.6);
                    matchType = "similarity";
                }
                
                if (bestMatch) {
                    console.log(`✅ Found match for "${completeText}" using ${matchType} method`);
                    
                    // Store individual coordinates instead of combining
                    individualCoordinates.push({
                        fieldName: field.fieldName,
                        coordinates: bestMatch.coordinates,
                        area: this.calculateArea(bestMatch.coordinates)
                    });
                    
                    allGroupedTexts.push(...bestMatch.groupedTexts);
                    allFoundTexts.push({
                        fieldName: field.fieldName,
                        completeText: completeText,
                        coordinates: bestMatch.coordinates,
                        groupedTexts: bestMatch.groupedTexts,
                        confidence: bestMatch.confidence,
                        matchedText: bestMatch.matchedText,
                        matchType: matchType
                    });
                } else {
                    console.log(`❌ No match found for "${completeText}"`);
                }
            }
            
            if (allFoundTexts.length === 0) {
                throw new Error(`Could not find any of the target complete fields in OCR results`);
            }
            
            console.log(`\n--- Final Results ---`);
            console.log(`Successfully matched ${allFoundTexts.length} out of ${foundFields.length} complete fields`);
            allFoundTexts.forEach(ft => {
                console.log(`  ${ft.fieldName}: "${ft.completeText}" (${ft.matchType})`);
            });
            
            // Return individual coordinates instead of combined
            return {
                individualCoordinates: individualCoordinates, // Array of separate coordinate areas
                allFoundTexts: allFoundTexts,
                allGroupedTexts: allGroupedTexts,
                confidence: allFoundTexts.reduce((sum, item) => sum + item.confidence, 0) / allFoundTexts.length,
                foundCount: allFoundTexts.length,
                maskingType: "individual_areas" // Flag to indicate separate masking
            };
            
        } catch (error) {
            console.error('Error in finding and grouping multiple complete fields:', error);
            throw error;
        }
    }

    /**
     * Calculate area of coordinates (for debugging/optimization)
     */
    calculateArea(coordinates) {
        const xs = coordinates.map(coord => coord.x);
        const ys = coordinates.map(coord => coord.y);
        
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        
        return width * height;
    }

    /**
     * Find complete field-value pair in OCR results
     */
    findCompleteFieldInOCR(ocrTexts, completeText, fieldPart, valuePart) {
        console.log(`Trying to find complete field: "${completeText}"`);
        
        // Group nearby texts to form potential complete fields
        const groupedCandidates = this.groupNearbyTexts(ocrTexts);
        
        for (const group of groupedCandidates) {
            const groupText = group.texts.map(t => t.text).join(' ').trim();
            const groupTextNoSpaces = group.texts.map(t => t.text).join('').trim();
            
            // Check if the grouped text matches the complete field
            if (groupText === completeText || groupTextNoSpaces === completeText ||
                groupText.includes(fieldPart) && groupText.includes(valuePart)) {
                
                console.log(`Found complete field match: "${groupText}"`);
                const combinedCoordinates = this.combineCoordinates(group.texts.map(t => t.coordinates));
                return {
                    coordinates: combinedCoordinates,
                    groupedTexts: group.texts,
                    confidence: 1.0,
                    matchedText: groupText
                };
            }
        }
        
        return null;
    }

    /**
     * Find field part and value part separately, then combine their coordinates
     */
    findFieldValueSeparately(ocrTexts, fieldPart, valuePart) {
        console.log(`Trying to find field "${fieldPart}" and value "${valuePart}" separately`);
        
        let fieldMatch = null;
        let valueMatch = null;
        const allMatchedTexts = [];
        
        // Find field part
        for (const ocrText of ocrTexts) {
            if (ocrText.text.trim().toLowerCase().includes(fieldPart.toLowerCase().replace(/[:.]/g, ''))) {
                fieldMatch = ocrText;
                allMatchedTexts.push(ocrText);
                console.log(`Found field part: "${ocrText.text}"`);
                break;
            }
        }
        
        // Find value part near the field
        if (fieldMatch && valuePart) {
            const fieldY = (fieldMatch.coordinates[0].y + fieldMatch.coordinates[2].y) / 2;
            const fieldRightX = Math.max(...fieldMatch.coordinates.map(c => c.x));
            
            // Look for value within reasonable distance from field
            for (const ocrText of ocrTexts) {
                const textY = (ocrText.coordinates[0].y + ocrText.coordinates[2].y) / 2;
                const textLeftX = Math.min(...ocrText.coordinates.map(c => c.x));
                
                // Check if text is on similar Y level and to the right of field
                const yDiff = Math.abs(fieldY - textY);
                const xDiff = textLeftX - fieldRightX;
                
                if (yDiff < 20 && xDiff >= -10 && xDiff <= 100) { // Reasonable proximity
                    if (ocrText.text.trim().includes(valuePart.trim())) {
                        valueMatch = ocrText;
                        allMatchedTexts.push(ocrText);
                        console.log(`Found value part: "${ocrText.text}"`);
                        break;
                    }
                }
            }
        }
        
        if (fieldMatch && (valueMatch || !valuePart)) {
            console.log(`Successfully found field and value separately`);
            const combinedCoordinates = this.combineCoordinates(allMatchedTexts.map(t => t.coordinates));
            return {
                coordinates: combinedCoordinates,
                groupedTexts: allMatchedTexts,
                confidence: 0.9,
                matchedText: allMatchedTexts.map(t => t.text).join(' ')
            };
        }
        
        return null;
    }

    /**
     * Find exact match in OCR results
     */
    findExactMatch(ocrTexts, targetValue) {
        console.log(`Trying exact match for: "${targetValue}"`);
        
        // Try to find exact match in single text elements
        for (const ocrText of ocrTexts) {
            if (ocrText.text.trim() === targetValue.trim()) {
                console.log(`Found exact single match: "${ocrText.text}"`);
                return {
                    coordinates: ocrText.coordinates,
                    groupedTexts: [ocrText],
                    confidence: 1.0,
                    matchedText: ocrText.text
                };
            }
        }
        
        // Try to find exact match in grouped texts
        const groupedCandidates = this.groupNearbyTexts(ocrTexts);
        for (const group of groupedCandidates) {
            const groupText = group.texts.map(t => t.text).join('').trim();
            const groupTextWithSpaces = group.texts.map(t => t.text).join(' ').trim();
            
            if (groupText === targetValue.trim() || groupTextWithSpaces === targetValue.trim()) {
                console.log(`Found exact group match: "${groupText}" or "${groupTextWithSpaces}"`);
                const combinedCoordinates = this.combineCoordinates(group.texts.map(t => t.coordinates));
                return {
                    coordinates: combinedCoordinates,
                    groupedTexts: group.texts,
                    confidence: 1.0,
                    matchedText: groupText
                };
            }
        }
        
        console.log(`No exact match found for: "${targetValue}"`);
        return null;
    }

    /**
     * Find similarity match with specified threshold
     */
    findSimilarityMatch(ocrTexts, targetValue, threshold = 0.85) {
        console.log(`Trying similarity match for: "${targetValue}" with threshold ${threshold}`);
        
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
            
            console.log(`  Comparing "${cleanTargetValue}" vs "${groupText}" = ${similarity.toFixed(3)}`);
            
            if (similarity > bestScore && similarity >= threshold) {
                bestScore = similarity;
                bestMatch = group;
            }
        }
        
        if (bestMatch) {
            console.log(`Found similarity match with score ${bestScore.toFixed(3)}`);
            const combinedCoordinates = this.combineCoordinates(bestMatch.texts.map(t => t.coordinates));
            return {
                coordinates: combinedCoordinates,
                groupedTexts: bestMatch.texts,
                confidence: bestScore,
                matchedText: bestMatch.texts.map(t => t.text).join('')
            };
        }
        
        console.log(`No similarity match found above threshold ${threshold}`);
        return null;
    }

    /**
     * Smart text grouping to combine fragmented OCR results (Enhanced for single search)
     */
    async findAndGroupTargetText(ocrTexts, searchText, targetValue) {
        try {
            console.log(`Finding and grouping target text: "${targetValue}"`);
            
            if (!targetValue) {
                // Fallback to original method if Gemini didn't find anything
                return this.findAssociatedTextFallback(ocrTexts, searchText);
            }
            
            // Log all OCR detected texts for debugging
            console.log('All OCR detected texts:', ocrTexts.map(t => t.text));
            
            // Step 1: Try exact match first (highest priority)
            let bestMatch = this.findExactMatch(ocrTexts, targetValue);
            let matchType = "exact";
            
            if (!bestMatch) {
                // Step 2: Try exact substring matching  
                bestMatch = this.findExactSubstringMatch(ocrTexts, targetValue);
                matchType = "substring";
            }
            
            if (!bestMatch) {
                // Step 3: Try similarity matching with high threshold
                bestMatch = this.findSimilarityMatch(ocrTexts, targetValue, 0.85);
                matchType = "similarity";
            }
            
            if (!bestMatch) {
                // Step 4: Try relaxed similarity matching
                bestMatch = this.findSimilarityMatch(ocrTexts, targetValue, 0.7);
                matchType = "relaxed_similarity";
            }
            
            if (bestMatch) {
                console.log(`✅ Found match for "${targetValue}" using ${matchType} method: "${bestMatch.matchedText}"`);
                return {
                    coordinates: bestMatch.coordinates,
                    groupedTexts: bestMatch.groupedTexts,
                    confidence: bestMatch.confidence,
                    matchedText: bestMatch.matchedText,
                    matchType: matchType
                };
            }
            
            console.log(`❌ No match found for "${targetValue}"`);
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
     * Create highlighted version showing individual field areas with different colors
     */
    async createIndividualAreasHighlight(imagePath, individualCoordinates, padding = 5) {
        try {
            console.log('Creating individual areas highlight for separate field masking...');
            
            if (!individualCoordinates || individualCoordinates.length === 0) {
                throw new Error('No individual coordinates provided for highlighting');
            }
            
            // Different colors for each field area
            const colors = [
                { r: 255, g: 0, b: 0, alpha: 0.4 },     // Red
                { r: 0, g: 255, b: 0, alpha: 0.4 },     // Green  
                { r: 0, g: 0, b: 255, alpha: 0.4 },     // Blue
                { r: 255, g: 255, b: 0, alpha: 0.4 },   // Yellow
                { r: 255, g: 0, b: 255, alpha: 0.4 },   // Magenta
                { r: 0, g: 255, b: 255, alpha: 0.4 }    // Cyan
            ];
            
            // Start with the original image
            let imageProcessor = sharp(imagePath);
            const compositeOps = [];
            
            // Create overlay for each individual area
            for (let i = 0; i < individualCoordinates.length; i++) {
                const area = individualCoordinates[i];
                const coordinates = area.coordinates;
                const color = colors[i % colors.length];
                
                const xs = coordinates.map(coord => coord.x || 0);
                const ys = coordinates.map(coord => coord.y || 0);
                
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
                
                console.log(`Created highlight for field "${area.fieldName}" at (${minX}, ${minY}) with ${color.r === 255 && color.g === 0 ? 'red' : color.g === 255 && color.r === 0 ? 'green' : 'blue'} color`);
            }
            
            // Apply all overlays at once
            const individualHighlightedBuffer = await imageProcessor
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            // Save individual areas highlighted image
            const individualHighlightedPath = imagePath.replace(path.extname(imagePath), '_individual_areas_highlighted.png');
            fs.writeFileSync(individualHighlightedPath, individualHighlightedBuffer);
            
            console.log(`Individual areas highlighted image saved to: ${individualHighlightedPath}`);
            console.log(`Shows ${individualCoordinates.length} separate field areas (not combined rectangle)`);
            
            return individualHighlightedPath;
            
        } catch (error) {
            console.error('Error creating individual areas highlight:', error);
            throw error;
        }
    }
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
     * Use Imagen 3 Capability API for inpainting with proper mask reference handling
     * Modified to generate 4 samples and return multiple files
     * Enhanced for complete field removal
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
                                maskMode: "MASK_MODE_USER_PROVIDED", // Only manual masking
                                dilation: 0.01 // Slight dilation for better edge handling
                            }
                        }
                    ]
                }],
                parameters: {
                    sampleCount: 4, // Generate 4 samples
                    guidanceScale: 12, // Moderate guidance for field removal
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
                timeout: 120000 // 2 minute timeout for 4 samples
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
                return outputPaths; // Return array of file paths
                
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
     * Create composite mask with multiple separate areas
     */
    async createMultiAreaMask(imagePath, individualCoordinates, padding = 5) {
        try {
            console.log('Creating composite mask for multiple individual areas...');
            console.log('Individual areas to mask:', individualCoordinates.map(area => ({
                field: area.fieldName,
                area: area.area
            })));
            
            const imageMetadata = await sharp(imagePath).metadata();
            const { width, height } = imageMetadata;
            
            // Start with black background (no masking)
            let maskBuffer = await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 0, g: 0, b: 0 }
                }
            }).png().toBuffer();
            
            // Create white rectangles for each individual area
            const compositeOps = [];
            
            for (let i = 0; i < individualCoordinates.length; i++) {
                const area = individualCoordinates[i];
                const coordinates = area.coordinates;
                
                const xs = coordinates.map(coord => coord.x || 0);
                const ys = coordinates.map(coord => coord.y || 0);
                
                const minX = Math.max(0, Math.min(...xs) - padding);
                const minY = Math.max(0, Math.min(...ys) - padding);
                const maxX = Math.min(width, Math.max(...xs) + padding);
                const maxY = Math.min(height, Math.max(...ys) + padding);
                
                const maskWidth = maxX - minX;
                const maskHeight = maxY - minY;
                
                console.log(`Area ${i + 1} (${area.fieldName}): ${maskWidth}x${maskHeight} at position (${minX}, ${minY})`);
                
                // Create white rectangle for this area
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
            
            // Apply all white rectangles to the black background
            const finalMaskBuffer = await sharp(maskBuffer)
                .composite(compositeOps)
                .png()
                .toBuffer();
            
            const maskPath = imagePath.replace(path.extname(imagePath), '_multi_area_mask.png');
            fs.writeFileSync(maskPath, finalMaskBuffer);
            
            console.log(`Composite mask with ${individualCoordinates.length} separate areas saved to: ${maskPath}`);
            return maskPath;
            
        } catch (error) {
            console.error('Error creating multi-area mask:', error);
            throw error;
        }
    }

    /**
     * Create mask around coordinates (single area)
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
     * Find text coordinates in image (legacy method for single search)
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
            const inpaintedPaths = await this.inpaintImage(imagePath, maskPath, inpaintPrompt);
            
            const endTime = Date.now();
            const processingTime = `${(endTime - startTime) / 1000}s`;
            
            console.log('=== Manual coordinates workflow completed successfully ===');
            
            return {
                originalImage: imagePath,
                boundingBox: boundingBox,
                maskImage: maskPath,
                inpaintedImages: inpaintedPaths, // Now returns array of 4 images
                processingTime: processingTime,
                method: "manual_coordinates_4_samples"
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
     * Clean up temporary files with support for multiple inpainted files
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