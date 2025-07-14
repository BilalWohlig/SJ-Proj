const express = require('express');
const router = express.Router();
const __constants = require('../../config/constants');
const OCRInpaintingService = require('../../services/ocr/OCRInpaintingService');
const validationOfAPI = require('../../middlewares/validation');

/**
 * @namespace -OCR-Inpainting-GCS-
 * @description API for OCR text detection and inpainting operations with GCS integration and detail restoration.
 */

/**
 * @memberof -OCR-Inpainting-GCS-
 * @name processImageFromGCS
 * @path {POST} /api/ocr/processImageFromGCS
 * @description Complete GCS workflow: Download from input bucket -> OCR -> Inpaint -> Upload to output bucket with detail restoration
 * @body {string} inputFileName - Name of the image file in the input GCS bucket (required)
 * @body {string} inputBucket - Name of the input GCS bucket (required)
 * @body {string} outputBucket - Name of the output GCS bucket (required)
 * @body {string} inpaintPrompt - Custom prompt for inpainting (optional)
 * @body {number} padding - Extra padding around text for mask (optional, default: 5)
 * @body {boolean} returnOriginal - Whether to include original image in output bucket (optional, default: false)
 * @body {boolean} returnMask - Whether to include mask image in output bucket (optional, default: false)
 * @body {boolean} returnHighlighted - Whether to include highlighted image in output bucket (optional, default: true)
 * @body {string} maskChannel - Channel to use for mask processing ('red', 'green', 'blue', 'alpha', 'auto') (optional, default: 'red')
 * @body {number} detailFeatherRadius - Feathering radius for detail restoration (optional, default: 1)
 * @body {boolean} skipDetailRestoration - Skip detail restoration step (optional, default: false)
 * @body {boolean} returnRawInpainted - Return raw inpainted images without detail restoration (optional, default: false)
 * @response {string} ContentType=application/json - Response with GCS URLs and processing metadata
 * @code {200} If successful, returns GCS URLs and processing results
 * @code {400} If validation fails or required parameters are missing
 * @code {404} If input file not found in GCS bucket
 * @code {500} If there is a server error during processing
 * *** Last-Updated :- 15th July 2025 ***
 */

const validationSchema = {
  type: 'object',
  required: ['inputFileName'],
  properties: {
    inputFileName: { type: 'string', minLength: 1 },
    inpaintPrompt: { type: 'string' },
    padding: { type: 'number', minimum: 0, maximum: 50 },
    returnOriginal: { type: 'boolean' },
    returnMask: { type: 'boolean' },
    returnHighlighted: { type: 'boolean' },
    maskChannel: { type: 'string', enum: ['red', 'green', 'blue', 'alpha', 'auto'] },
    detailFeatherRadius: { type: 'number', minimum: 0, maximum: 10 },
    skipDetailRestoration: { type: 'boolean' },
    returnRawInpainted: { type: 'boolean' }
  }
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
      returnHighlighted = false,
      maskChannel = 'red',
      detailFeatherRadius = 1,
      skipDetailRestoration = false,
      returnRawInpainted = false
    } = req.body;

    console.log(`Starting GCS OCR inpainting workflow with detail restoration:`);
    console.log(`- Input: ${inputFileName}`);
    console.log(`- Auto-detecting enhanced fields: Manufacturing Date, Expiry Date, Batch Number, MRP, Pack Size, Inclusive of All Taxes (IOAT only if low distance)`);
    console.log(`- Including Hindi text detection for all fields`);
    console.log(`- Using unified distance-based masking strategy (pack size always included, IOAT only if low distance)`);
    console.log(`- Will generate 4 inpainted samples with automatic field detection`);
    console.log(`- Detail restoration: ${skipDetailRestoration ? 'DISABLED' : 'ENABLED'} (maskChannel: ${maskChannel}, featherRadius: ${detailFeatherRadius})`);
    console.log(`- Text distortion prevention: ${skipDetailRestoration ? 'DISABLED' : 'ENABLED'}`);

    // Call the service function with all parameters
    const results = await OCRInpaintingService.processImageWithAutoFieldDetection(
      inputFileName,
      {
        inpaintPrompt,
        padding: parseInt(padding),
        returnOriginal,
        returnMask,
        returnHighlighted,
        maskChannel,
        detailFeatherRadius: parseFloat(detailFeatherRadius),
        skipDetailRestoration,
        returnRawInpainted
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
      rawSamplesCount: results.gcsResults.outputFiles.filter(f => f.type === 'raw_inpainted').length,
      searchMode: 'enhanced_unified_distance_field_detection',
      autoDetectedFields: results.autoDetectedFields || [],
      foundFields: results.foundText?.foundFields || [],
      processing: {
        inpaintPrompt: inpaintPrompt,
        padding: parseInt(padding),
        processingTime: results.processingTime,
        method: results.method,
        autoFieldDetection: true,
        hindiTextSupport: true,
        unifiedDistanceMasking: true,
        detectedFieldsCount: results.foundText?.foundFields?.length || 0,
        selectedOCRTextsCount: results.geminiOCRSelection?.totalSelectedTexts || 0,
        workflowSteps: results.workflowSteps || [
          'gcs_download',
          'gemini_field_detection_with_distance',
          'google_vision_ocr',
          'gemini_ocr_selection_distance_based',
          'distance_based_mask_creation',
          'highlight_creation',
          'imagen_inpainting',
          ...(skipDetailRestoration ? [] : ['detail_restoration']),
          'gcs_upload'
        ]
      },
      detailRestoration: {
        enabled: !skipDetailRestoration,
        maskChannel: maskChannel,
        featherRadius: parseFloat(detailFeatherRadius),
        textDistortionPrevention: !skipDetailRestoration,
        pixelLevelBlending: !skipDetailRestoration,
        method: skipDetailRestoration ? 'none' : 'pixel_level_blending'
      },
      distanceAnalysis: {
        unifiedMaskingStrategy: results.geminiAnalysis?.unifiedMaskingStrategy || 'values_only',
        distanceResults: results.autoDetectedFields?.map(field => ({
          fieldType: field.fieldType,
          fieldName: field.fieldName,
          distance: field.distance,
          distanceReason: field.distanceReason,
          maskingStrategy: field.maskingStrategy,
          textToMask: field.textToMask
        })) || []
      },
      fieldTypes: {
        manufacturing_date: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'manufacturing_date') || false,
          hindiSupport: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'manufacturing_date')?.distance || 'not_detected'
        },
        expiry_date: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'expiry_date') || false,
          hindiSupport: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'expiry_date')?.distance || 'not_detected'
        },
        batch_number: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'batch_number') || false,
          hindiSupport: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'batch_number')?.distance || 'not_detected'
        },
        mrp: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'mrp') || false,
          hindiSupport: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'mrp')?.distance || 'not_detected'
        },
        pack_size: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'pack_size') || false,
          hindiSupport: true,
          canExistWithoutFieldLabel: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'pack_size')?.distance || 'not_detected',
          alwaysIncludedInMasking: true
        },
        inclusive_of_taxes: {
          detected: results.autoDetectedFields?.some(f => f.fieldType === 'inclusive_of_taxes') || false,
          hindiSupport: true,
          canExistWithoutValue: true,
          distance: results.autoDetectedFields?.find(f => f.fieldType === 'inclusive_of_taxes')?.distance || 'not_detected',
          onlyIncludedInLowDistance: true
        }
      },
      maskingStrategy: {
        type: 'unified_distance_based',
        strategy: results.geminiAnalysis?.unifiedMaskingStrategy || 'values_only',
        explanation: results.geminiAnalysis?.unifiedMaskingStrategy === 'unified_all_fields_and_values' 
          ? 'Low distance detected - masking ALL fields and their values + pack size values + IOAT'
          : 'High distance detected - masking only VALUES + pack size values (NO IOAT)',
        packSizeHandling: 'always_included',
        ioatHandling: 'only_included_in_low_distance',
        hindiTextHandling: 'included_with_fields'
      },
      metadata: {
        processedAt: new Date().toISOString(),
        success: true,
        note: `Enhanced unified distance-based detection with ${skipDetailRestoration ? 'standard' : 'detail-preserved'} inpainting: ${results.foundText?.foundFields?.length || 0} fields found, ${results.geminiOCRSelection?.totalSelectedTexts || 0} OCR texts selected for masking (IOAT only if low distance), ${results.gcsResults.outputFiles.filter(f => f.type === 'inpainted').length} ${skipDetailRestoration ? 'standard' : 'detail-preserved'} variations generated`,
        workflowComplete: true,
        bucketAccess: 'private',
        textDistortionPrevented: !skipDetailRestoration,
        enhancedFeatures: [
          'hindi_text_detection',
          'pack_size_detection',
          'inclusive_of_taxes_detection',
          'unified_distance_based_masking',
          'visual_context_analysis',
          'ocr_error_handling',
          ...(skipDetailRestoration ? [] : ['detail_restoration', 'text_distortion_prevention', 'pixel_level_blending'])
        ]
      }
    };

    // Include enhanced analysis results if available
    if (results.geminiAnalysis) {
      responseData.geminiAnalysis = {
        found: results.geminiAnalysis.found,
        autoDetectedFields: results.geminiAnalysis.autoDetectedFields,
        unifiedMaskingStrategy: results.geminiAnalysis.unifiedMaskingStrategy,
        detectionConfidence: results.geminiAnalysis.detectionConfidence,
        context: results.geminiAnalysis.context,
        totalFound: results.geminiAnalysis.totalFound
      };
    }

    if (results.geminiOCRSelection) {
      responseData.geminiOCRSelection = {
        success: results.geminiOCRSelection.success,
        unifiedStrategy: results.geminiOCRSelection.unifiedStrategy,
        selectedFields: results.geminiOCRSelection.selectedFields,
        totalSelectedTexts: results.geminiOCRSelection.totalSelectedTexts,
        confidence: results.geminiOCRSelection.confidence,
        method: results.geminiOCRSelection.method,
        visualContextUsed: results.geminiOCRSelection.visualContextUsed,
        ocrErrorHandling: results.geminiOCRSelection.ocrErrorHandling,
        unifiedMaskingApplied: results.geminiOCRSelection.unifiedMaskingApplied
      };
    }

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: responseData,
    });

  } catch (err) {
    console.error('Error in enhanced unified distance-based GCS OCR inpainting process:', err);
    
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
      errorMessage = 'No standard fields (Manufacturing Date, Expiry Date, Batch Number, MRP, Pack Size, Inclusive of All Taxes) were found in the image';
    } else if (err.message?.includes('Invalid') || err.message?.includes('validation')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
    } else if (err.message?.includes('API') || err.message?.includes('quota')) {
      errorType = __constants.RESPONSE_MESSAGES.SERVICE_UNAVAILABLE;
      errorMessage = 'External service temporarily unavailable. Please try again later.';
    } else if (err.message?.includes('bucket') || err.message?.includes('storage')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
      errorMessage = `GCS bucket error: ${err.message}`;
    } else if (err.message?.includes('could not select appropriate OCR texts')) {
      errorType = __constants.RESPONSE_MESSAGES.BAD_REQUEST;
      errorMessage = 'Could not properly select OCR texts based on distance analysis. Please check image quality and text clarity.';
    } else if (err.message?.includes('Gemini')) {
      errorType = __constants.RESPONSE_MESSAGES.SERVICE_UNAVAILABLE;
      errorMessage = 'AI analysis service temporarily unavailable. Please try again later.';
    } else if (err.message?.includes('detail restoration') || err.message?.includes('pixel blend')) {
      errorType = __constants.RESPONSE_MESSAGES.SERVER_ERROR;
      errorMessage = 'Detail restoration failed. Try setting skipDetailRestoration=true for standard inpainting.';
    }

    res.sendJson({
      type: errorType,
      err: errorMessage,
      metadata: {
        processedAt: new Date().toISOString(),
        success: false,
        note: "Enhanced unified distance-based GCS OCR inpainting workflow with detail restoration failed (IOAT only selected if low distance detected)",
        searchMode: 'enhanced_unified_distance_field_detection',
        workflowComplete: false,
        bucketAccess: 'private',
        textDistortionPrevented: false,
        enhancedFeatures: [
          'hindi_text_detection',
          'pack_size_detection',
          'inclusive_of_taxes_detection',
          'unified_distance_based_masking',
          'visual_context_analysis',
          'ocr_error_handling',
          'detail_restoration_option',
          'text_distortion_prevention_option',
          'pixel_level_blending_option'
        ],
        inputFile: req.body.inputFileName ? {
          fileName: req.body.inputFileName
        } : null,
        supportedFields: [
          'manufacturing_date',
          'expiry_date',
          'batch_number',
          'mrp',
          'pack_size',
          'inclusive_of_taxes'
        ],
        maskingStrategies: [
          'unified_all_fields_and_values', // Low distance
          'values_only' // High distance
        ],
        distanceAnalysis: {
          lowDistance: 'Field and value directly connected - mask ALL fields and values + pack size + IOAT',
          highDistance: 'Field and value separated - mask only VALUES + pack size values (NO IOAT)',
          packSizeHandling: 'Always included in masking regardless of distance',
          ioatHandling: 'Only included when LOW distance is detected'
        },
        detailRestoration: {
          purpose: 'Prevents text distortion outside masked areas',
          method: 'Pixel-level blending with channel-based mask processing',
          maskChannels: ['red', 'green', 'blue', 'alpha', 'auto'],
          featheringRange: '0-10 pixels',
          canBeDisabled: 'Set skipDetailRestoration=true'
        },
        troubleshooting: {
          commonIssues: [
            'If text appears distorted outside mask areas, ensure detail restoration is enabled (skipDetailRestoration=false)',
            'If mask is not working properly, try different maskChannel values (red/green/blue/alpha/auto)',
            'For edge blending issues, adjust detailFeatherRadius (0-10)',
            'Check image quality and ensure clear text for better OCR results'
          ]
        }
      }
    });
  }
});

module.exports = router;