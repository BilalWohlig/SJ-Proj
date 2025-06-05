const express = require('express');
const router = express.Router();
const __constants = require('../../config/constants');
const ProductService = require('../../services/product/ProductService');
const validationOfAPI = require('../../middlewares/validation');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
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
    required: [],
    properties: {
    },
  };
  
  const validation = (req, res, next) => {
    return validationOfAPI(req, res, next, validationSchema, 'body');
  };

router.post('/fluxKontext', upload.single('input_garment'), validation, async (req, res) => {
  try {
    const imagePath = req.file.path;

    const fluxResponse = await ProductService.createFluxKontext(imagePath);

    res.sendJson({
      type: __constants.RESPONSE_MESSAGES.SUCCESS,
      data: fluxResponse,
    });
  } catch (err) {
    console.error('Error retrieving documents from knowledge base:', err);
    res.sendJson({
      type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
      err: err.err || err.message || err,
    });
  }
});

module.exports = router;
