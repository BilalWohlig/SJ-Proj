const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const __constants = require('../../config/constants');
const ProductService = require('../../services/product/ProductService');
const validationOfAPI = require('../../middlewares/validation');

/**
 * @namespace -ProductService-
 * @description API related to Product operations including background removal.
 */

/**
 * @memberof -ProductService-
 * @name changeBackground
 * @path {POST} /api/product/changeBackground
 * @description Changes image background from black to white using hybrid approach (Sharp.js + AI fallback).
 * @body {file} image - Image file to process (jpg, jpeg, png, webp)
 * @body {string} [targetColor=white] - Target background color (default: white)
 * @body {boolean} [useAI=false] - Force AI processing instead of Sharp.js
 * @response {string} ContentType=application/json - Response content type.
 * @response {string} metadata.msg=Success - Background changed successfully.
 * @response {object} metadata.data - Processing result with file paths and metadata.
 * @code {200} If the msg is 'Success', background removal completed.
 * @code {400} If file validation fails or unsupported format.
 * @code {500} If there is a server error during processing.
 * *** Last-Updated :- 4th July 2025 ***
 */

// Ensure directories exist function
async function ensureDirectories() {
  const dirs = ['uploads', 'uploads/original', 'uploads/processed', 'uploads/metadata'];
  
  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  }
}

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Ensure directories exist before upload
      await ensureDirectories();
      cb(null, 'uploads/original/');
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'jewelry-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  // Check file type
  const allowedTypes = /jpeg|jpg|png|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files (JPEG, JPG, PNG, WebP) are allowed!'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 12 * 1024 * 1024, // 12MB limit (same as remove.bg)
  },
  fileFilter: fileFilter
});

const validationSchema = {
  type: 'object',
  required: [],
//   properties: {
//     targetColor: {
//       type: 'string',
//       enum: ['white', 'transparent', 'black', 'red', 'green', 'blue'],
//       default: 'white'
//     },
//     useAI: {
//       type: 'boolean',
//       default: false
//     }
//   },
};

const validation = (req, res, next) => {
  return validationOfAPI(req, res, next, validationSchema, 'body');
};

router.post('/changeBackground', upload.single('image'), validation, async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).sendJson({
        type: __constants.RESPONSE_MESSAGES.VALIDATION_ERROR,
        err: 'No image file provided. Please upload an image.',
      });
    }

    const { targetColor = 'white', useAI = false } = req.body;
    const startTime = Date.now();

    console.log(`Processing image: ${req.file.filename}, Target: ${targetColor}, Force AI: ${useAI}`);

    // Call the service to process the image
    const result = await ProductService.changeImageBackground({
      inputPath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      targetColor: targetColor,
      forceAI: useAI === 'true' || useAI === true
    });

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: {
        ...result,
        processingTime: `${processingTime}s`,
        originalFile: {
          name: req.file.originalname,
          size: `${(req.file.size / 1024).toFixed(2)} KB`,
          path: req.file.path
        }
      },
    });

  } catch (err) {
    console.error('Error in changeBackground route:', err);
    
    // Clean up uploaded file if processing failed
    if (req.file) {
      const fs = require('fs').promises;
      try {
        await fs.unlink(req.file.path);
        console.log('Cleaned up failed upload:', req.file.path);
      } catch (cleanupErr) {
        console.error('Failed to cleanup file:', cleanupErr);
      }
    }

    res.status(500).sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.message || err,
    });
  }
});

module.exports = router;