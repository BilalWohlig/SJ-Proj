const express = require('express');
const router = express.Router();
const __constants = require('../../config/constants');
const OCRInpaintingService = require('../../services/ocr/OCRInpaintingService');
const validationOfAPI = require('../../middlewares/validation');

/**
 * @namespace -OCR-Inpainting-GCS-
 * @description API for OCR text detection and inpainting operations with GCS integration.
 */

/**
 * @memberof -OCR-Inpainting-GCS-
 * @name processImageFromGCS
 * @path {POST} /api/ocr/processImageFromGCS
 * @description Complete GCS workflow: Download from input bucket -> OCR -> Inpaint -> Upload to output bucket
 * @body {string} inputFileName - Name of the image file in the input GCS bucket (required)
 * @body {string} inputBucket - Name of the input GCS bucket (required)
 * @body {string} outputBucket - Name of the output GCS bucket (required)
 * @body {string} inpaintPrompt - Custom prompt for inpainting (optional)
 * @body {number} padding - Extra padding around text for mask (optional, default: 5)
 * @body {boolean} returnOriginal - Whether to include original image in output bucket (optional, default: false)
 * @body {boolean} returnMask - Whether to include mask image in output bucket (optional, default: false)
 * @body {boolean} returnHighlighted - Whether to include highlighted image in output bucket (optional, default: true)
 * @response {string} ContentType=application/json - Response with GCS URLs and processing metadata
 * @code {200} If successful, returns GCS URLs and processing results
 * @code {400} If validation fails or required parameters are missing
 * @code {404} If input file not found in GCS bucket
 * @code {500} If there is a server error during processing
 * *** Last-Updated :- 11th July 2025 ***
 */

const validationSchema = {
  type: 'object',
  required: ['inputFileName'],
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

router.post('/processImageFromGCS', validation, async (req, res) => {
  try {
    const {
      inputFileName,
      inpaintPrompt = 'clean background, seamless text removal',
      padding = 5,
      returnOriginal = false,
      returnMask = false,
      returnHighlighted = false
    } = req.body;

    console.log(`Starting GCS OCR inpainting workflow:`);
    console.log(`- Input: ${inputFileName}`);
    // console.log(`- Output: ${outputBucket}`);
    console.log(`- Auto-detecting standard fields: Manufacturing Date, Expiry Date, Batch Number, MRP`);
    console.log(`- Will generate 4 inpainted samples with automatic field detection`);

    // Call the service function with all parameters
    const results = await OCRInpaintingService.processImageWithAutoFieldDetection(
      inputFileName,
      {
        inpaintPrompt,
        padding: parseInt(padding),
        returnOriginal,
        returnMask,
        returnHighlighted
      }
    );

    // Prepare response data
    const responseData = {
      inputFile: {
        fileName: inputFileName
      },
      outputFiles: results.gcsResults.outputFiles,
      gcsUrls: results.gcsResults.gcsUrls,
      samplesCount: results.gcsResults.outputFiles.filter(f => f.type === 'inpainted').length,
      searchMode: 'auto_field_detection',
      autoDetectedFields: results.autoDetectedFields || [],
      foundFields: results.foundText?.foundFields || [],
      processing: {
        inpaintPrompt: inpaintPrompt,
        padding: parseInt(padding),
        processingTime: results.processingTime,
        method: results.method,
        autoFieldDetection: true,
        detectedFieldsCount: results.foundText?.foundFields?.length || 0,
        workflowSteps: results.workflowSteps || [
          'gcs_download',
          'gemini_field_detection',
          'google_vision_ocr',
          'gemini_ocr_selection',
          'mask_creation',
          'highlight_creation',
          'imagen_inpainting',
          'gcs_upload'
        ]
      },
      metadata: {
        processedAt: new Date().toISOString(),
        success: true,
        note: `Auto-detected ${results.foundText?.foundFields?.length || 0} fields and generated ${results.gcsResults.outputFiles.filter(f => f.type === 'inpainted').length} inpainted variations`,
        workflowComplete: true,
        bucketAccess: 'private'
      }
    };

    // Include analysis results if available
    if (results.geminiAnalysis) {
      responseData.geminiAnalysis = {
        found: results.geminiAnalysis.found,
        autoDetectedFields: results.geminiAnalysis.autoDetectedFields,
        detectionConfidence: results.geminiAnalysis.detectionConfidence,
        context: results.geminiAnalysis.context
      };
    }

    if (results.geminiOCRSelection) {
      responseData.geminiOCRSelection = {
        success: results.geminiOCRSelection.success,
        selectedFields: results.geminiOCRSelection.selectedFields,
        totalSelectedTexts: results.geminiOCRSelection.totalSelectedTexts,
        confidence: results.geminiOCRSelection.confidence,
        method: results.geminiOCRSelection.method
      };
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: responseData,
    });

  } catch (err) {
    console.error('Error in GCS OCR inpainting process:', err);
    
    // Determine error type and message
    let errorType = __constants.RESPONSE_MESSAGES.SERVER_ERROR;
    let errorMessage = err.message || err;

    if (err.code === 404 || err.message?.includes('not found') || err.message?.includes('does not exist')) {
      errorType = __constants.RESPONSE_MESSAGES.NOT_FOUND;
      errorMessage = `Input file not found in GCS bucket: ${req.body.inputBucket}/${req.body.inputFileName}`;
    } else if (err.code === 403 || err.message?.includes('access denied') || err.message?.includes('permission')) {
      errorType = __constants.RESPONSE_MESSAGES.FORBIDDEN;
      errorMessage = `Access denied to GCS bucket. Check service account permissions for private buckets.`;
    } else if (err.message?.includes('No standard fields found')) {
      errorType = __constants.RESPONSE_MESSAGES.NOT_FOUND;
      errorMessage = 'No standard fields (Manufacturing Date, Expiry Date, Batch Number, MRP) were found in the image';
    } else if (err.message?.includes('Invalid') || err.message?.includes('validation')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
    } else if (err.message?.includes('API') || err.message?.includes('quota')) {
      errorType = __constants.RESPONSE_MESSAGES.SERVICE_UNAVAILABLE;
      errorMessage = 'External service temporarily unavailable. Please try again later.';
    } else if (err.message?.includes('bucket') || err.message?.includes('storage')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
      errorMessage = `GCS bucket error: ${err.message}`;
    }

    res.sendJson({
      type: errorType,
      err: errorMessage,
      metadata: {
        processedAt: new Date().toISOString(),
        success: false,
        note: "GCS OCR inpainting workflow failed",
        searchMode: 'auto_field_detection',
        workflowComplete: false,
        bucketAccess: 'private',
        inputFile: req.body.inputFileName ? {
          fileName: req.body.inputFileName
        } : null
      }
    });
  }
});

module.exports = router;