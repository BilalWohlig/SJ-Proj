const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Simple Detail Restore Service
 * Takes original image, mask, and distorted inpainted image
 * Returns image with original details restored outside mask
 */
class SimpleDetailRestoreService {
    
    /**
     * Main function to restore original details outside mask
     * @param {string} originalImagePath - Path to original undistorted image
     * @param {string} maskImagePath - Path to binary mask (white = inpainted areas)
     * @param {string} inpaintedImagePath - Path to inpainted image with distorted text
     * @param {object} options - Processing options
     */
    async restoreDetails(originalImagePath, maskImagePath, inpaintedImagePath, options = {}) {
        const {
            outputPath = null,
            featherRadius = 1,
            blendMode = 'normal',
            maskChannel = 'red' // 'red', 'green', 'blue', 'alpha', 'auto'
        } = options;

        let tempFiles = [];

        try {
            console.log('=== Starting Simple Detail Restoration ===');
            console.log(`Original: ${originalImagePath}`);
            console.log(`Mask: ${maskImagePath}`);
            console.log(`Inpainted: ${inpaintedImagePath}`);
            console.log(`Mask Channel: ${maskChannel.toUpperCase()}`);
            
            // Step 1: Get dimensions and ensure all images match
            const originalMeta = await sharp(originalImagePath).metadata();
            const inpaintedMeta = await sharp(inpaintedImagePath).metadata();
            const maskMeta = await sharp(maskImagePath).metadata();
            
            console.log(`Original dimensions: ${originalMeta.width}x${originalMeta.height}`);
            console.log(`Inpainted dimensions: ${inpaintedMeta.width}x${inpaintedMeta.height}`);
            console.log(`Mask dimensions: ${maskMeta.width}x${maskMeta.height}`);
            
            const targetWidth = originalMeta.width;
            const targetHeight = originalMeta.height;
            
            // Step 2: Resize all images to match original dimensions if needed
            let resizedInpaintedPath = inpaintedImagePath;
            let resizedMaskPath = maskImagePath;
            
            if (inpaintedMeta.width !== targetWidth || inpaintedMeta.height !== targetHeight) {
                console.log('Resizing inpainted image to match original...');
                resizedInpaintedPath = inpaintedImagePath.replace(path.extname(inpaintedImagePath), '_resized.png');
                await sharp(inpaintedImagePath)
                    .resize(targetWidth, targetHeight, {
                        kernel: sharp.kernel.lanczos3,
                        fit: 'fill'
                    })
                    .png()
                    .toFile(resizedInpaintedPath);
                tempFiles.push(resizedInpaintedPath);
            }
            
            // Step 3: Process mask with channel extraction and resizing if needed
            console.log('Processing mask with channel extraction...');
            const processedMaskPath = maskImagePath.replace(path.extname(maskImagePath), '_processed.png');
            await this.processMaskWithChannel(maskImagePath, processedMaskPath, targetWidth, targetHeight, maskChannel);
            resizedMaskPath = processedMaskPath;
            tempFiles.push(processedMaskPath);
            
            // Step 4: Create inverse mask (areas to preserve from original)
            console.log('Creating inverse mask...');
            const inverseMaskPath = resizedMaskPath.replace('.png', '_inverse.png');
            await sharp(resizedMaskPath)
                .negate() // Black becomes white, white becomes black
                .png()
                .toFile(inverseMaskPath);
            tempFiles.push(inverseMaskPath);
            
            // Step 5: Apply feathering to soften edges (optional)
            let finalInverseMaskPath = inverseMaskPath;
            if (featherRadius > 0) {
                console.log(`Applying feathering with radius ${featherRadius}...`);
                finalInverseMaskPath = inverseMaskPath.replace('.png', '_feathered.png');
                await sharp(inverseMaskPath)
                    .blur(featherRadius)
                    .png()
                    .toFile(finalInverseMaskPath);
                tempFiles.push(finalInverseMaskPath);
            }
            
            // Step 6: Create the restored image using mask blending
            console.log('Restoring original details...');
            
            const finalOutputPath = outputPath || 
                originalImagePath.replace(path.extname(originalImagePath), '_detail_restored.png');
            
            // Use the mask to blend original details back
            await this.pixelLevelBlend(
                resizedInpaintedPath,    // Base: inpainted image
                originalImagePath ,     // Overlay: original image 
                finalInverseMaskPath,  // Mask: inverse mask
                finalOutputPath
            );
            
            console.log(`✅ Detail restoration complete: ${finalOutputPath}`);
            
            // Clean up temporary files
            // this.cleanupTempFiles(tempFiles);
            
            return {
                success: true,
                outputPath: finalOutputPath,
                method: 'mask_based_detail_restoration',
                processingSteps: [
                    'dimension_matching',
                    'mask_channel_extraction',
                    'inverse_mask_creation',
                    'optional_feathering',
                    'mask_based_blending'
                ],
                maskChannel: maskChannel
            };
            
        } catch (error) {
            console.error('Error in detail restoration:', error);
            // Clean up on error
            // this.cleanupTempFiles(tempFiles);
            throw error;
        }
    }
    
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
     * Advanced blending with mask
     */
    async blendWithMask(baseImagePath, overlayImagePath, maskPath, outputPath) {
        try {
            console.log('Performing mask-based blending...');
            
            // Method: Use the mask to selectively blend original details back
            
            // First, create a version where original image is only visible through the inverse mask
            const maskedOriginalPath = baseImagePath.replace('.png', '_temp_masked_original.png');
            await sharp(overlayImagePath)
                .composite([
                    {
                        input: maskPath,
                        blend: 'dest-in'  // Keep only areas where mask is white
                    }
                ])
                .png()
                .toFile(maskedOriginalPath);
            
            // Then composite the masked original over the inpainted image
            await sharp(baseImagePath)
                .composite([
                    {
                        input: maskedOriginalPath,
                        blend: 'over'  // Overlay the masked original details
                    }
                ])
                .png({ quality: 100 })
                .toFile(outputPath);
            
            // Clean up temp file
            if (fs.existsSync(maskedOriginalPath)) {
                fs.unlinkSync(maskedOriginalPath);
            }
            
            console.log('✅ Mask-based blending completed');
            
        } catch (error) {
            console.error('Error in mask blending:', error);
            throw error;
        }
    }
    
    /**
     * Alternative method: Pixel-level blending
     */
    async pixelLevelBlend(originalImagePath, inpaintedImagePath, maskPath, outputPath) {
        try {
            console.log('Using pixel-level blending method...');
            
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
            
            console.log('✅ Pixel-level blending completed');
            
        } catch (error) {
            console.error('Error in pixel-level blending:', error);
            throw error;
        }
    }
    
    /**
     * Quick test function - processes all images in a directory
     */
    async batchRestore(inputDir, outputDir) {
        try {
            console.log('=== Starting Batch Detail Restoration ===');
            
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            
            const files = fs.readdirSync(inputDir);
            
            // Look for triplets: original, mask, inpainted
            const imageGroups = {};
            
            files.forEach(file => {
                const baseName = file.replace(/_original|_mask|_inpainted/, '').replace(/\.[^.]+$/, '');
                if (!imageGroups[baseName]) {
                    imageGroups[baseName] = {};
                }
                
                if (file.includes('_original')) {
                    imageGroups[baseName].original = path.join(inputDir, file);
                } else if (file.includes('_mask')) {
                    imageGroups[baseName].mask = path.join(inputDir, file);
                } else if (file.includes('_inpainted')) {
                    imageGroups[baseName].inpainted = path.join(inputDir, file);
                }
            });
            
            let processedCount = 0;
            
            // Process each complete group
            for (const [baseName, group] of Object.entries(imageGroups)) {
                if (group.original && group.mask && group.inpainted) {
                    console.log(`Processing group: ${baseName}`);
                    
                    const outputPath = path.join(outputDir, `${baseName}_restored.png`);
                    
                    try {
                        await this.restoreDetails(
                            group.original,
                            group.mask,
                            group.inpainted,
                            { outputPath }
                        );
                        processedCount++;
                        console.log(`✅ Completed: ${baseName}`);
                    } catch (error) {
                        console.error(`❌ Failed processing ${baseName}:`, error.message);
                    }
                } else {
                    console.log(`⚠️ Skipping incomplete group: ${baseName}`, {
                        hasOriginal: !!group.original,
                        hasMask: !!group.mask,
                        hasInpainted: !!group.inpainted
                    });
                }
            }
            
            console.log(`=== Batch processing complete: ${processedCount} images processed ===`);
            return { processedCount, totalGroups: Object.keys(imageGroups).length };
            
        } catch (error) {
            console.error('Error in batch restore:', error);
            throw error;
        }
    }
    
    /**
     * Clean up temporary files
     */
    cleanupTempFiles(filePaths) {
        filePaths.forEach(filePath => {
            try {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`);
                }
            } catch (error) {
                console.error(`Error cleaning up ${filePath}:`, error.message);
            }
        });
    }
}

module.exports = new SimpleDetailRestoreService();