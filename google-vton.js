/**
 * This Node.js script sends a request to the Google Cloud AI Platform Virtual Try-On API.
 *
 * It authenticates using Google Cloud's Application Default Credentials (ADC),
 * reads a person's image and a product image, encodes them to base64,
 * and sends them in a POST request.
 *
 * Make sure you have the required packages installed:
 * npm install axios google-auth-library
 *
 * Also, ensure you have authenticated with gcloud:
 * gcloud auth application-default login
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

// --- Configuration ---
// TODO: Replace with your Google Cloud Project ID
const PROJECT_ID = 'proj-newsshield-prod-infra';
// TODO: Update with the correct paths to your images
const PERSON_IMAGE_PATH = path.join(__dirname, 'person.png');
const PRODUCT_IMAGE_PATH = path.join(__dirname, 'product.png');
// The number of generated images to return
const IMAGE_COUNT = 1;

// The API endpoint URL
// const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/virtual-try-on-exp-05-31:predict`;
const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-product-recontext-preview-06-30:predict`;

/**
 * Gets an OAuth2 access token for authenticating with Google Cloud APIs.
 * @returns {Promise<string>} A promise that resolves with the access token.
 */
async function getAccessToken() {
  console.log('Getting access token...');
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform'
    });
    const client = await auth.getClient();
    const accessToken = (await client.getAccessToken()).token;
    console.log('Access token retrieved successfully.');
    return accessToken;
  } catch (error) {
    console.error('Error getting access token:', error.message);
    throw new Error('Could not get access token. Ensure you have configured Application Default Credentials.');
  }
}


/**
 * Encodes an image file to a base64 string.
 * @param {string} filePath - The path to the image file.
 * @returns {string|null} The base64 encoded string or null if an error occurs.
 */
function encodeImageToBase64(filePath) {
  try {
    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      console.error(`Error: Image file not found at ${filePath}`);
      return null;
    }
    // Read the file and convert it to a base64 string
    const imageBuffer = fs.readFileSync(filePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    console.error(`Error reading or encoding file at ${filePath}:`, error);
    return null;
  }
}

/**
 * Main function to make the API request.
 * @param {string} accessToken - The OAuth2 access token for authorization.
 */
async function makeVirtualTryOnRequest(accessToken) {
  console.log('Encoding images...');

  // Encode the person and product images
  const personImageBase64 = encodeImageToBase64(PERSON_IMAGE_PATH);
  const productImageBase64 = encodeImageToBase64(PRODUCT_IMAGE_PATH);

  // Exit if image encoding failed
  if (!personImageBase64 || !productImageBase64) {
    console.error('Failed to encode one or more images. Aborting API request.');
    return;
  }

  console.log('Images encoded successfully.');

  // Construct the request payload as per the API documentation
  const requestPayload = {
    instances: [{
      prompt: "Make the woman wear this tshirt and make her stand in a busy new york street. Maintain all details of the tshirt.",
      // personImage: {
      //   image: {
      //     bytesBase64Encoded: personImageBase64,
      //   },
      // },
      productImages: [{
        image: {
          bytesBase64Encoded: productImageBase64,
        },
      }, 
      {
        image: {
          bytesBase64Encoded: personImageBase64,
        },
      }],
    }, ],
    parameters: {
      sampleCount: IMAGE_COUNT,
      enhancePrompt: true
    },
  };

  // Set up the request headers, including the Authorization token
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  };

  try {
    console.log('Sending request to Virtual Try-On API...');
    const response = await axios.post(apiUrl, requestPayload, { headers });

    console.log('API Response Received:');
    // The response contains the generated images, also in base64 format.
    // You would typically save these to a file or display them.
    console.log(response.data.predictions);

    // Example of how to save the first generated image
    if (response.data.predictions && response.data.predictions.length > 0) {
        const firstPrediction = response.data.predictions[0];
        if(firstPrediction && firstPrediction.bytesBase64Encoded) {
            const generatedImageBase64 = firstPrediction.bytesBase64Encoded;
            const outputFilePath = path.join(__dirname, 'generated_image.png');
            fs.writeFileSync(outputFilePath, generatedImageBase64, 'base64');
            console.log(`Successfully saved generated image to ${outputFilePath}`);
        }
    }

  } catch (error) {
    console.error('Error making API request:');
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Data:', error.response.data);
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('Request:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Error Message:', error.message);
    }
  }
}

// Main execution block
(async () => {
  try {
    const accessToken = await getAccessToken();
    await makeVirtualTryOnRequest(accessToken);
  } catch (error) {
    console.error('Operation failed:', error.message);
    process.exit(1);
  }
})();
