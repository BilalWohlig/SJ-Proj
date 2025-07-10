const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const __constants = require('../../config/constants');
const OCRInpaintingService = require('../../services/ocr/OCRInpaintingService');
const validationOfAPI = require('../../middlewares/validation');

/**
 * @namespace -OCR-Inpainting-
 * @description API related to OCR text detection and inpainting operations with automatic field detection.
 */

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads/ocr-images';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `ocr-${timestamp}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WEBP are allowed.'));
    }
  }
});

/**
 * @memberof -OCR-Inpainting-
 * @name processImage
 * @path {POST} /api/ocr/processImage
 * @description Complete workflow to process an image: Auto-detect standard fields -> OCR -> Create combined mask -> Inpaint (4 samples) -> Return processed images
 * @body {file} image - Image file to process (required)
 * @body {string} inpaintPrompt - Custom prompt for inpainting (optional)
 * @body {number} padding - Extra padding around text for mask (optional, default: 5)
 * @body {boolean} returnOriginal - Whether to include original image in response (optional, default: false)
 * @body {boolean} returnMask - Whether to include mask image in response (optional, default: false)
 * @body {boolean} returnHighlighted - Whether to include highlighted image in response (optional, default: true)
 * @response {string} ContentType=application/json - Response content type with image data
 * @response {string} metadata.msg=Success - Images processed successfully
 * @response {object} metadata.data - Processing results with base64 encoded images and metadata (includes 4 inpainted samples)
 * @code {200} If the msg is 'Success', returns processed images and metadata
 * @code {400} If validation fails or required parameters are missing
 * @code {500} If there is a server error during processing
 * *** Last-Updated :- 10th July 2025 ***
 */

const validationSchema = {
  type: 'object',
  required: [], // Only image file is required
  // properties: {
  //   inpaintPrompt: {
  //     type: 'string',
  //     maxLength: 500,
  //     description: 'Custom prompt for inpainting process'
  //   },
  //   padding: {
  //     type: 'number',
  //     minimum: 0,
  //     maximum: 50,
  //     description: 'Extra padding around text for mask creation'
  //   },
  //   returnOriginal: {
  //     type: 'boolean',
  //     description: 'Whether to include original image in response'
  //   },
  //   returnMask: {
  //     type: 'boolean',
  //     description: 'Whether to include mask image in response'
  //   },
  //   returnHighlighted: {
  //     type: 'boolean',
  //     description: 'Whether to include highlighted image showing masked area'
  //   }
  // }
};

const validation = (req, res, next) => {
  return validationOfAPI(req, res, next, validationSchema, 'body');
};

router.post('/processImage', upload.single('image'), validation, async (req, res) => {
  let tempFiles = [];
  
  try {
    // Check if image file was uploaded
    if (!req.file) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.BAD_REQUEST,
        err: 'Image file is required'
      });
    }

    const {
      inpaintPrompt = 'clean background, seamless text removal',
      padding = 5,
      returnOriginal = false,
      returnMask = false,
      returnHighlighted = true
    } = req.body;

    const imagePath = req.file.path;
    tempFiles.push(imagePath);

    console.log(`Processing OCR inpainting for image: ${imagePath}`);
    console.log(`Auto-detecting standard fields: Manufacturing Date, Expiry Date, Batch Number, MRP`);
    console.log(`Will generate 4 inpainted samples with automatic field detection`);

    // Validate the uploaded image
    const validation = await OCRInpaintingService.validateImage(imagePath);
    if (!validation.valid) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.BAD_REQUEST,
        err: `Invalid image: ${validation.error}`
      });
    }

    // Process the image using OCR and inpainting with automatic field detection
    const results = await OCRInpaintingService.processImageWithAutoFieldDetection(
      imagePath,
      inpaintPrompt,
      parseInt(padding),
      true // createHighlight = true (always create highlighted image)
    );

    // Add generated files to cleanup list
    if (results.maskImage) tempFiles.push(results.maskImage);
    if (results.highlightedImage) tempFiles.push(results.highlightedImage);
    
    // Add all inpainted images to cleanup list (they are preserved by cleanupFiles method)
    if (results.inpaintedImages && Array.isArray(results.inpaintedImages)) {
      tempFiles.push(...results.inpaintedImages);
    }

    // Process all 4 inpainted images
    const processedImages = [];
    if (results.inpaintedImages && Array.isArray(results.inpaintedImages)) {
      for (let i = 0; i < results.inpaintedImages.length; i++) {
        const inpaintedImagePath = results.inpaintedImages[i];
        const inpaintedImageBuffer = fs.readFileSync(inpaintedImagePath);
        const inpaintedImageBase64 = inpaintedImageBuffer.toString('base64');
        
        processedImages.push({
          data: inpaintedImageBase64,
          mimeType: 'image/png',
          filename: path.basename(inpaintedImagePath),
          size: inpaintedImageBuffer.length,
          sampleNumber: i + 1
        });
      }
    }

    // Prepare response data with all 4 samples
    const responseData = {
      processedImages: processedImages, // Array of 4 inpainted samples
      samplesCount: processedImages.length,
      searchMode: 'auto_field_detection',
      autoDetectedFields: results.autoDetectedFields || [],
      foundFields: results.foundText?.foundFields || [],
      processing: {
        inpaintPrompt: inpaintPrompt,
        padding: parseInt(padding),
        processingTime: results.processingTime,
        method: results.method,
        autoFieldDetection: true,
        detectedFieldsCount: results.foundText?.foundFields?.length || 0
      },
      originalImage: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        dimensions: {
          width: validation.width,
          height: validation.height
        }
      },
      metadata: {
        processedAt: new Date().toISOString(),
        success: true,
        note: `Auto-detected standard fields - ${results.foundText?.foundFields?.length || 0} fields found and processed with 4 inpainted samples`
      }
    };

    // Optionally include original image
    if (returnOriginal) {
      const originalImageBuffer = fs.readFileSync(imagePath);
      responseData.originalImage.data = originalImageBuffer.toString('base64');
      responseData.originalImage.mimeType = req.file.mimetype;
    }

    // Optionally include mask image
    if (returnMask && results.maskImage) {
      const maskImageBuffer = fs.readFileSync(results.maskImage);
      responseData.maskImage = {
        data: maskImageBuffer.toString('base64'),
        mimeType: 'image/png',
        filename: path.basename(results.maskImage),
        size: maskImageBuffer.length
      };
    }

    // Include highlighted image (default behavior)
    if (returnHighlighted && results.highlightedImage) {
      const highlightedImageBuffer = fs.readFileSync(results.highlightedImage);
      responseData.highlightedImage = {
        data: highlightedImageBuffer.toString('base64'),
        mimeType: 'image/png',
        filename: path.basename(results.highlightedImage),
        size: highlightedImageBuffer.length
      };
    }

    // Include Gemini analysis results
    if (results.geminiAnalysis) {
      responseData.geminiAnalysis = {
        found: results.geminiAnalysis.found,
        autoDetectedFields: results.geminiAnalysis.autoDetectedFields,
        detectionConfidence: results.geminiAnalysis.detectionConfidence,
        context: results.geminiAnalysis.context
      };
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: responseData,
    });

  } catch (err) {
    console.error('Error in OCR inpainting process:', err);
    
    // Determine error type and message
    let errorType = __constants.RESPONSE_MESSAGES.SERVER_ERROR;
    let errorMessage = err.message || err;

    if (err.message?.includes('No standard fields found')) {
      errorType = __constants.RESPONSE_MESSAGES.NOT_FOUND;
      errorMessage = 'No standard fields (Manufacturing Date, Expiry Date, Batch Number, MRP) were found in the image';
    } else if (err.message?.includes('Invalid') || err.message?.includes('validation')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
    } else if (err.message?.includes('API') || err.message?.includes('quota')) {
      errorType = __constants.RESPONSE_MESSAGES.SERVICE_UNAVAILABLE;
      errorMessage = 'External service temporarily unavailable. Please try again later.';
    }

    res.sendJson({
      type: errorType,
      err: errorMessage,
      metadata: {
        processedAt: new Date().toISOString(),
        success: false,
        note: "Auto field detection failed",
        searchMode: 'auto_field_detection'
      }
    });
  } finally {
    // Clean up temporary files after a delay to ensure response is sent
    // setTimeout(() => {
    //   OCRInpaintingService.cleanupFiles(tempFiles);
    // }, 5000); // 5 second delay
  }
});

module.exports = router;