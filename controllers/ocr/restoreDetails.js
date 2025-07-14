const express = require('express');
const router = express.Router();
const __constants = require('../../config/constants');
const SimpleDetailRestoreService = require('../../services/ocr/restoreDetailsService');
const validationOfAPI = require('../../middlewares/validation');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './temp/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const fieldName = file.fieldname; // 'original', 'mask', or 'inpainted'
    cb(null, `${fieldName}_${timestamp}_${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

/**
 * @namespace -Simple-Detail-Restore-
 * @description Simple API to test detail restoration overlay functionality
 */

/**
 * @memberof -Simple-Detail-Restore-
 * @name restoreDetails
 * @path {POST} /api/ocr/restoreDetails
 * @description Test detail restoration with uploaded files
 * @consumes multipart/form-data
 * @param {file} original - Original undistorted image file (required)
 * @param {file} mask - Binary mask image file (required)
 * @param {file} inpainted - Inpainted image with distorted text (required)
 * @param {number} featherRadius - Edge feathering radius (optional, default: 1)
 * @param {string} blendMode - Blending mode (optional, default: 'normal')
 * @param {string} maskChannel - Channel to use for mask ('red', 'green', 'blue', 'alpha', 'auto') (optional, default: 'red')
 * @response {file} - Returns the detail-restored image file
 * @code {200} Returns restored image file
 * @code {400} If files are missing or invalid
 * @code {500} If processing fails
 */

const validationSchema = {
  type: 'object',
  required: [],
  // properties: {
  //   inputFileName: { type: 'string', minLength: 1 },
  //   inputBucket: { type: 'string', minLength: 1 },
  //   outputBucket: { type: 'string', minLength: 1 },
  //   inpaintPrompt: { type: 'string' },
  //   padding: { type: 'number', minimum: 0, maximum: 50 },
  //   returnOriginal: { type: 'boolean' },
  //   returnMask: { type: 'boolean' },
  //   returnHighlighted: { type: 'boolean' }
  // }
};

const validation = (req, res, next) => {
  return validationOfAPI(req, res, next, validationSchema, 'body');
};


router.post('/restoreDetails', 
  upload.fields([
    { name: 'original', maxCount: 1 },
    { name: 'mask', maxCount: 1 },
    { name: 'inpainted', maxCount: 1 }
  ]), validation,
  async (req, res) => {
    let tempFiles = [];
    
    try {
      console.log('=== Simple Detail Restore Test ===');
      
      // Validate uploaded files
      if (!req.files || !req.files.original || !req.files.mask || !req.files.inpainted) {
        return res.status(400).json({
          error: 'Missing required files. Need: original, mask, inpainted'
        });
      }
      
      const originalPath = req.files.original[0].path;
      const maskPath = req.files.mask[0].path;
      const inpaintedPath = req.files.inpainted[0].path;
      
      tempFiles.push(originalPath, maskPath, inpaintedPath);
      
      console.log(`Original: ${originalPath}`);
      console.log(`Mask: ${maskPath}`);
      console.log(`Inpainted: ${inpaintedPath}`);
      
      const featherRadius = parseFloat(req.body.featherRadius) || 1;
      const blendMode = req.body.blendMode || 'normal';
      const maskChannel = req.body.maskChannel || 'red';
      
      console.log(`Using mask channel: ${maskChannel.toUpperCase()}`);
      
      // Generate output path
      const outputPath = originalPath.replace(path.extname(originalPath), '_detail_restored.png');
      tempFiles.push(outputPath);
      
      // Perform detail restoration
      const result = await SimpleDetailRestoreService.restoreDetails(
        originalPath,
        maskPath,
        inpaintedPath,
        {
          outputPath,
          featherRadius,
          blendMode,
          maskChannel
        }
      );
      
      if (result.success && fs.existsSync(outputPath)) {
        console.log('✅ Detail restoration successful, sending file...');
        
        // Send the restored image file
        res.download(outputPath, 'detail_restored.png', (err) => {
          if (err) {
            console.error('Error sending file:', err);
          }
          
          // Clean up temp files after download
        //   setTimeout(() => {
        //     tempFiles.forEach(file => {
        //       try {
        //         if (fs.existsSync(file)) {
        //           fs.unlinkSync(file);
        //           console.log(`Cleaned up: ${file}`);
        //         }
        //       } catch (cleanupErr) {
        //         console.error(`Error cleaning up ${file}:`, cleanupErr.message);
        //       }
        //     });
        //   }, 5000); // 5 second delay
        });
        
      } else {
        throw new Error('Detail restoration failed or output file not generated');
      }
      
    } catch (err) {
      console.error('Error in detail restoration:', err);
      
      // Clean up temp files on error
    //   tempFiles.forEach(file => {
    //     try {
    //       if (fs.existsSync(file)) {
    //         fs.unlinkSync(file);
    //       }
    //     } catch (cleanupErr) {
    //       console.error(`Error cleaning up ${file}:`, cleanupErr.message);
    //     }
    //   });
      
      res.status(500).json({
        error: err.message || 'Detail restoration failed',
        details: 'Check that all uploaded images are valid and the mask is properly binary (black/white)'
      });
    }
  }
);

module.exports = router;