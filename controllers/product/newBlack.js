const express      = require('express');
const router       = express.Router();
const path         = require('path');
const multer       = require('multer');
const { v4: uuidv4 } = require('uuid');
const ProductService = require('../../services/product/ProductService');
const validationOfAPI = require('../../middlewares/validation');
const __constants  = require('../../config/constants');

/* ---------- multer config ---------- */
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename  : (_req, file, cb) =>
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

/* ---------- JSON-schema validation ---------- */
const validationSchema = {
  type: 'object',
  required: [
  ],
  properties: {
  }
};
const validation = (req, res, next) =>
  validationOfAPI(req, res, next, validationSchema, 'body');

/**
 * @memberof -ProductService-
 * @name generateTNBImage
 * @path {POST} /api/product/generateTNBImage
 * @description Generates an outfit image via The New Black.
 */
router.post(
  '/generateTNBImage',
  validation,
  upload.single('clothing_photo'),          // optional image file
  async (req, res) => {
    try {
      /* ----- obtain a public URL for clothing_photo ----- */
      let clothingPhotoUrl = req.body.clothing_photo; // if user sent a URL
      if (!clothingPhotoUrl && req.file) {
        // serve /uploads statically or upload to S3, etc.
        clothingPhotoUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      }
      if (!clothingPhotoUrl) {
        return res.sendJson({
          type: __constants.RESPONSE_MESSAGES.PROVIDE_FILE,
          err : "'clothing_photo' (file or URL) is required."
        });
      }

      const { id, filePath } = await ProductService.generateTNBImage({
        clothingPhotoUrl,
        ...req.body          // clothing_type, gender, country, …
      });
    //   const test = await ProductService.generateTNBImage({
    //     clothingPhotoUrl,
    //     ...req.body          // clothing_type, gender, country, …
    //   });

      res.sendJson({
        type: __constants.RESPONSE_MESSAGES.SUCCESS,
        data: { id, filePath }
      });
    //   res.sendJson({
    //     type: __constants.RESPONSE_MESSAGES.SUCCESS,
    //     data: test
    //   });
    } catch (err) {
      console.error('Error in generateTNBImage:', err);
      res.sendJson({
        type: err.type || __constants.RESPONSE_MESSAGES.SERVER_ERROR,
        err : err.err || err.message || err
      });
    }
  }
);

module.exports = router;
