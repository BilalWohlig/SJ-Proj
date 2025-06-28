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
 * @description API related to OCR text detection and inpainting operations.
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
 * @description Complete workflow to process an image: OCR -> Find text -> Create mask -> Inpaint -> Return processed image
 * @body {file} image - Image file to process (required)
 * @body {string} searchText - Text to search for and remove (required)
 * @body {string} inpaintPrompt - Custom prompt for inpainting (optional)
 * @body {number} padding - Extra padding around text for mask (optional, default: 5)
 * @body {boolean} returnOriginal - Whether to include original image in response (optional, default: false)
 * @body {boolean} returnMask - Whether to include mask image in response (optional, default: false)
 * @response {string} ContentType=application/json - Response content type with image data
 * @response {string} metadata.msg=Success - Image processed successfully
 * @response {object} metadata.data - Processing results with base64 encoded images and metadata
 * @code {200} If the msg is 'Success', returns processed image and metadata
 * @code {400} If validation fails or required parameters are missing
 * @code {500} If there is a server error during processing
 * *** Last-Updated :- 28th June 2025 ***
 */

const validationSchema = {
  type: 'object',
  required: ['searchText'],
//   properties: {
//     searchText: {
//       type: 'string',
//       minLength: 1,
//       maxLength: 100,
//       description: 'Text to search for in the image'
//     },
//     inpaintPrompt: {
//       type: 'string',
//       maxLength: 500,
//       description: 'Custom prompt for inpainting process'
//     },
//     padding: {
//       type: 'number',
//       minimum: 0,
//       maximum: 50,
//       description: 'Extra padding around text for mask creation'
//     },
//     returnOriginal: {
//       type: 'boolean',
//       description: 'Whether to include original image in response'
//     },
//     returnMask: {
//       type: 'boolean',
//       description: 'Whether to include mask image in response'
//     },
//     returnHighlighted: {
//       type: 'boolean',
//       description: 'Whether to include highlighted image showing masked area'
//     },
//     useAutoMask: {
//       type: 'boolean',
//       description: 'Whether to use automatic mask generation instead of OCR-based masking'
//     }
//   },
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
      searchText,
      inpaintPrompt = 'clean background, seamless text removal',
      padding = 5,
      returnOriginal = false,
      returnMask = false,
      returnHighlighted = false,
      useAutoMask = false
    } = req.body;

    const imagePath = req.file.path;
    tempFiles.push(imagePath);

    console.log(`Processing OCR inpainting for image: ${imagePath}`);
    console.log(`Search text: "${searchText}"`);

    // Validate the uploaded image
    const validation = await OCRInpaintingService.validateImage(imagePath);
    if (!validation.valid) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.BAD_REQUEST,
        err: `Invalid image: ${validation.error}`
      });
    }

    // Process the image using OCR and inpainting
    const results = await OCRInpaintingService.processImage(
      imagePath,
      searchText,
      inpaintPrompt,
      parseInt(padding),
      useAutoMask === 'true' || useAutoMask === true,
      returnHighlighted === 'true' || returnHighlighted === true
    );

    // Add generated files to cleanup list
    if (results.maskImage) tempFiles.push(results.maskImage);
    if (results.highlightedImage) tempFiles.push(results.highlightedImage);

    // Read the inpainted image and convert to base64
    const inpaintedImageBuffer = fs.readFileSync(results.inpaintedImage);
    const inpaintedImageBase64 = inpaintedImageBuffer.toString('base64');
    tempFiles.push(results.inpaintedImage);

    // Prepare response data
    const responseData = {
      processedImage: {
        data: inpaintedImageBase64,
        mimeType: 'image/png',
        filename: path.basename(results.inpaintedImage),
        size: inpaintedImageBuffer.length
      },
      foundText: {
        searchText: results.foundText.searchText,
        associatedText: results.foundText.associatedText,
        coordinates: results.foundText.coordinates,
        searchCoordinates: results.foundText.searchCoordinates
      },
      processing: {
        inpaintPrompt: inpaintPrompt,
        padding: parseInt(padding),
        processingTime: results.processingTime,
        method: results.method,
        useAutoMask: useAutoMask === 'true' || useAutoMask === true
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
        success: true
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

    // Optionally include highlighted image
    if (returnHighlighted && results.highlightedImage) {
      const highlightedImageBuffer = fs.readFileSync(results.highlightedImage);
      responseData.highlightedImage = {
        data: highlightedImageBuffer.toString('base64'),
        mimeType: 'image/png',
        filename: path.basename(results.highlightedImage),
        size: highlightedImageBuffer.length
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

    if (err.message?.includes('not found')) {
      errorType = __constants.RESPONSE_MESSAGES.NOT_FOUND;
      errorMessage = `Text "${req.body.searchText}" not found in the image`;
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
        success: false
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