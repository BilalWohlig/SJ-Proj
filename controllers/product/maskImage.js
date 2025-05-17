const express = require('express');
const router = express.Router();
const __constants = require('../../config/constants');
const ProductService = require('../../services/product/ProductService');
const validationOfAPI = require('../../middlewares/validation');
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require('path');

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

/**
 * @namespace -KnowledgeBase-
 * @description API related to Knowledge Base operations.
 */

/**
 * @memberof -ProductService-
 * @name getProduct
 * @path {GET} /api/product/getProduct
 * @description Retrieves all getProduct with status 'Active' from the database.
 * @response {string} ContentType=application/json - Response content type.
 * @response {string} metadata.msg=Success - Documents retrieved successfully.
 * @response {object} metadata.data - Array of active documents.
 * @code {200} If the msg is 'Success', the API returns the documents.
 * @code {500} If there is a server error during the retrieval process.
 * *** Last-Updated :- 22nd September 2024 ***
 */

const validationSchema = {
    type: 'object',
    required: [
    ],
    properties: {
      prompt: { type: 'string' },
    },
  };
  
  const validation = (req, res, next) => {
    return validationOfAPI(req, res, next, validationSchema, 'body');
  };

router.post('/maskImage', validation, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'mask', maxCount: 1 },
]), async (req, res) => {
  try {
    if (!req.files?.image || !req.files?.mask) {
      return res.sendJson({
        type: __constants.RESPONSE_MESSAGES.PROVIDE_FILE,
        err: "'image' and 'mask' images are required.",
      });
    }
    const imagePath = req.files.image[0].path
    const maskPath = req.files.mask[0].path
    const userPrompt = req.body.prompt || '';
    
    const image = await ProductService.maskImage({ imagePath, maskPath, prompt: userPrompt });

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: image,
    });
  } catch (err) {
    console.error('Error generating mask image:', err);
    res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.err || err.message || err,
    });
  }
});

module.exports = router;
