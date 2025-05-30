const axios = require("axios");
const moment = require("moment");

const { execSync, spawnSync } = require("node:child_process");
const { accessSync, unlinkSync, writeFileSync, readFileSync, constants: fsConstants } = require("node:fs");
const { access } = require("node:fs/promises");
const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] })
                    .toString().trim();
const path = require('path'); // <<< Make sure this is at the top of your JS file
const fs = require('fs');  
const __constants = require('../../config/constants');
const { v4: uuidv4 } = require('uuid');
// const fs = require("node:fs");
// const { spawnSync } = require("node:child_process");
// const { SpeechClient } = require("@google-cloud/speech");
// const similarity = require("string-similarity");
// const { writeFileSync, unlinkSync } = require("fs-extra");



// const outputUri = "gs://transcoder-output-v1/";
class ProductService {
  constructor() {
      this.apiKey = process.env.ELEVENLABS_API_KEY;
      this.baseURL = 'https://api.elevenlabs.io/v1';
      
      if (!this.apiKey) {
          throw new Error('ELEVENLABS_API_KEY environment variable is required');
      }
      
      this.downloadFolder = path.join(process.cwd());
      // Default settings
      this.defaultVoiceId = 'pNInz6obpgDQGcFmaJgB'; // Adam voice
      this.defaultModel = 'eleven_multilingual_v2';
      this.defaultVoiceSettings = {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.0,
          use_speaker_boost: true
      };
      
      // Setup axios instance
      this.axiosInstance = axios.create({
          baseURL: this.baseURL,
          headers: {
              'Accept': 'audio/mpeg',
              'Content-Type': 'application/json',
              'xi-api-key': this.apiKey
          },
          timeout: 30000 // 30 seconds timeout
      });
  }
  async getProduct(pageSize, categoryID) {
    try {
      // First, get size data, then check stock for each size and return data. Same for new drops
      let defaultCategoryID = "11";
      if (categoryID) {
        defaultCategoryID = categoryID;
      }
      const token = await this.getAdminToken();
      // console.log(token)
      const response = await axios.get(
        `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[filterGroups][0][filters][0][field]=category_id&searchCriteria[filterGroups][0][filters][0][value]=${defaultCategoryID}&searchCriteria[sortOrders][0][field]=updated_at`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      return response.data;
    } catch (err) {
      console.log("Error in getProduct function :: err", err.response);
      throw new Error(err);
    }
  }
  async placingOrder(number) {
    try {
      const token = await this.getAdminToken();
      // console.log(token)
      const existingCustomer = await this.checkExistingCustomer(number, token);
      // return exisitngCustomer.data
      if (existingCustomer) {
        const createMagentoOrder = await axios.post(
          `https://sparkyjeans.in/rest/default/V1/orders`,
          {
            entity: {
              base_grand_total: 100,
              customer_email: existingCustomer.data.items[0].email,
              grand_total: 100,
              items: [
                {
                  sku: "LWL62-GREEN-XL",
                },
              ],
              payment: {
                account_status: null,
                additional_information: [
                  "Pay Online with UPI | Cards | NetBanking (Additional 5% Off)",
                ],
                cc_last4: null,
                method: "cashfree",
              },
              status_histories: [
                {
                  comment: "Order status updated by Shiprocket",
                  is_customer_notified: null,
                  is_visible_on_front: 0,
                  parent_id: 527,
                },
              ],
              billing_address: {
                address_type: "billing",
                city: "Katihar",
                country_id: "IN",
                firstname: existingCustomer.data.items[0].firstname,
                lastname: existingCustomer.data.items[0].lastname,
                postcode: 854105,
                telephone: number,
              },
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        return createMagentoOrder.data;
        //Send Razorpay link

        //Validate Payment

        //If successful, add record in magento and shiprocket.
      }
      return "No Account";
    } catch (err) {
      console.log("Error in getProduct function :: err", err.response);
      throw new Error(err);
    }
  }
  async getCategoryWiseDrops(pageSize = 10, categoryId, page = 1) {
    try {
      const token = await this.getAdminToken();
      const config = { headers: { Authorization: `Bearer ${token}` } };
      let category_id = "11";
      if (categoryId) {
        category_id = categoryId;
      }
      // Fetch products
      const { data: productsData } = await axios.get(
        `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${page}&searchCriteria[sortOrders][0][field]=updated_at&searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=1&searchCriteria[filterGroups][1][filters][0][field]=visibility&searchCriteria[filterGroups][1][filters][0][value]=4&searchCriteria[filterGroups][2][filters][0][field]=category_id&searchCriteria[filterGroups][2][filters][0][value]=${category_id}`,
        config
      );
      const products = productsData.items;

      // Filter products with valid configurable product options (attribute 144)
      const validProducts = products.filter((product) => {
        const options =
          product.extension_attributes?.configurable_product_options;
        return options && options.length > 0 && options[0].attribute_id == 144;
      });

      // Cache the size attribute labels once
      const { data: sizeLabelsData } = await axios.get(
        "https://sparkyjeans.in/rest/V1/products/attributes/144",
        config
      );
      const sizeOptions = sizeLabelsData.options;

      // Process each valid product concurrently
      const processedProducts = await Promise.all(
        validProducts.map(async (product) => {
          // console.log(product.extension_attributes.configurable_product_options[0].values)
          // Get related products matching the product's name
          const { data: relatedData } = await axios.get(
            `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=100&searchCriteria[filterGroups][0][filters][0][field]=name&searchCriteria[filterGroups][0][filters][0][value]=${encodeURIComponent(
              product.name
            )}&searchCriteria[filterGroups][1][filters][0][field]=status&searchCriteria[filterGroups][1][filters][0][value]=1`,
            config
          );
          const relatedItems = relatedData.items.filter((item) =>
            product.extension_attributes.configurable_product_links.includes(
              item.id
            )
          );

          // Get stock info for each related item concurrently
          const relatedItemsWithStock = await Promise.all(
            relatedItems.map(async (item) => {
              const { data: stockData } = await axios.get(
                `https://sparkyjeans.in/rest/default/V1/stockStatuses/${item.sku}`,
                config
              );
              return { ...item, delhiStock: stockData.qty };
            })
          );

          // Process configurable options for the product
          const configOptions =
            product.extension_attributes.configurable_product_options[0];
          configOptions.values = configOptions.values || [];

          relatedItemsWithStock.forEach((item) => {
            // Find the 'size' attribute for this related item
            const sizeAttr = item.custom_attributes.find(
              (attr) => attr.attribute_code === "size"
            );
            if (sizeAttr) {
              // Lookup the label from the cached size options
              const sizeLabelOption = sizeOptions.find(
                (option) => option.value == sizeAttr.value
              );
              if (sizeLabelOption) {
                // Add value only if it is not already added
                const exists = configOptions.values.some(
                  (val) => Number(val.value_index) === Number(sizeAttr.value)
                );
                if (exists) {
                  configOptions.values.push({
                    label: sizeLabelOption.label,
                    sku: item.sku,
                    value_index: sizeAttr.value,
                    stock: item.delhiStock,
                    price: item.price,
                  });
                }
              }
            }
          });

          // Filter out incomplete option values
          configOptions.values = configOptions.values.filter(
            (val) => val.label && val.sku && val.stock && val.price
          );

          // Update image URLs for media and custom attributes. Check if the field disabled is false or not. Return false items only
          const media_gallery_entries = (
            product.media_gallery_entries || []
          ).map((entry) => {
            if (!entry.disabled) {
              return { ...entry, file: process.env.BASE_URL + entry.file };
            }
          });

          const custom_attributes = (product.custom_attributes || []).map(
            (attr) => {
              if (
                ["image", "small_image", "thumbnail"].includes(
                  attr.attribute_code
                )
              ) {
                return { ...attr, value: process.env.BASE_URL + attr.value };
              }
              return attr;
            }
          );

          // Return the final mapped product object
          return {
            id: product.id,
            sku: product.sku,
            name: product.name,
            created_at: product.created_at,
            updated_at: product.updated_at,
            configurable_product_options: [
              {
                id: configOptions.id,
                values: configOptions.values,
              },
            ],
            media_gallery_entries,
            custom_attributes,
          };
        })
      );

      return processedProducts;
    } catch (err) {
      console.error("Error in getNewDrops function:", err);
      throw new Error(err);
    }
  }
  async getNewDrops(pageSize = 10, page = 1) {
    try {
      const token = await this.getAdminToken();
      const config = { headers: { Authorization: `Bearer ${token}` } };

      // Fetch products
      const { data: productsData } = await axios.get(
        `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${page}&searchCriteria[sortOrders][0][field]=updated_at&searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=1&searchCriteria[filterGroups][1][filters][0][field]=visibility&searchCriteria[filterGroups][1][filters][0][value]=4`,
        config
      );
      const products = productsData.items;

      // Filter products with valid configurable product options (attribute 144)
      const validProducts = products.filter((product) => {
        const options =
          product.extension_attributes?.configurable_product_options;
        return options && options.length > 0 && options[0].attribute_id == 144;
      });

      // Cache the size attribute labels once
      const { data: sizeLabelsData } = await axios.get(
        "https://sparkyjeans.in/rest/V1/products/attributes/144",
        config
      );
      const sizeOptions = sizeLabelsData.options;

      // Process each valid product concurrently
      const processedProducts = await Promise.all(
        validProducts.map(async (product) => {
          // console.log(product.extension_attributes.configurable_product_options[0].values)
          // Get related products matching the product's name
          const { data: relatedData } = await axios.get(
            `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=100&searchCriteria[filterGroups][0][filters][0][field]=name&searchCriteria[filterGroups][0][filters][0][value]=${encodeURIComponent(
              product.name
            )}&searchCriteria[filterGroups][1][filters][0][field]=status&searchCriteria[filterGroups][1][filters][0][value]=1`,
            config
          );
          const relatedItems = relatedData.items.filter((item) =>
            product.extension_attributes.configurable_product_links.includes(
              item.id
            )
          );

          // Get stock info for each related item concurrently
          const relatedItemsWithStock = await Promise.all(
            relatedItems.map(async (item) => {
              const { data: stockData } = await axios.get(
                `https://sparkyjeans.in/rest/default/V1/stockStatuses/${item.sku}`,
                config
              );
              return { ...item, delhiStock: stockData.qty };
            })
          );

          // Process configurable options for the product
          const configOptions =
            product.extension_attributes.configurable_product_options[0];
          configOptions.values = configOptions.values || [];

          relatedItemsWithStock.forEach((item) => {
            // Find the 'size' attribute for this related item
            const sizeAttr = item.custom_attributes.find(
              (attr) => attr.attribute_code === "size"
            );
            if (sizeAttr) {
              // Lookup the label from the cached size options
              const sizeLabelOption = sizeOptions.find(
                (option) => option.value == sizeAttr.value
              );
              if (sizeLabelOption) {
                // Add value only if it is not already added
                const exists = configOptions.values.some(
                  (val) => Number(val.value_index) === Number(sizeAttr.value)
                );
                if (exists) {
                  configOptions.values.push({
                    label: sizeLabelOption.label,
                    sku: item.sku,
                    value_index: sizeAttr.value,
                    stock: item.delhiStock,
                    price: item.price,
                  });
                }
              }
            }
          });

          // Filter out incomplete option values
          configOptions.values = configOptions.values.filter(
            (val) => val.label && val.sku && val.stock && val.price
          );

          // Update image URLs for media and custom attributes. Check if the field disabled is false or not. Return false items only
          const media_gallery_entries = (
            product.media_gallery_entries || []
          ).map((entry) => {
            if (!entry.disabled) {
              return { ...entry, file: process.env.BASE_URL + entry.file };
            }
          });

          const custom_attributes = (product.custom_attributes || []).map(
            (attr) => {
              if (
                ["image", "small_image", "thumbnail"].includes(
                  attr.attribute_code
                )
              ) {
                return { ...attr, value: process.env.BASE_URL + attr.value };
              }
              return attr;
            }
          );

          // Return the final mapped product object
          return {
            id: product.id,
            sku: product.sku,
            name: product.name,
            created_at: product.created_at,
            updated_at: product.updated_at,
            configurable_product_options: [
              {
                id: configOptions.id,
                values: configOptions.values,
              },
            ],
            media_gallery_entries,
            custom_attributes,
          };
        })
      );
      return processedProducts;
    } catch (err) {
      console.error("Error in getNewDrops function:", err);
      throw new Error(err);
    }
  }

  // async getNewDrops(pageSize) {
  //   try {
  //     let page = 10;
  //     if (pageSize) {
  //       page = pageSize;
  //     }
  //     const token = await this.getAdminToken();
  //     // console.log(token)
  //     const response = await axios.get(
  //       `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${page}&searchCriteria[sortOrders][0][field]=updated_at&searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=1&searchCriteria[filterGroups][1][filters][0][field]=visibility&searchCriteria[filterGroups][1][filters][0][value]=4`,
  //       {
  //         headers: {
  //           Authorization: `Bearer ${token}`,
  //         },
  //       }
  //     );
  //     const removeItems = [];

  //     for (const ele of response.data.items) {
  //       if (
  //         !ele.extension_attributes.configurable_product_options ||
  //         ele.extension_attributes.configurable_product_options.length === 0 ||
  //         ele.extension_attributes.configurable_product_options[0]
  //           .attribute_id != 144
  //       ) {
  //         // remove from response.data.items array
  //         removeItems.push(ele);
  //       }

  //       const response = await axios.get(
  //         `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${100}&searchCriteria[filterGroups][0][filters][0][field]=name&searchCriteria[filterGroups][0][filters][0][value]=${
  //           ele.name
  //         }&searchCriteria[filterGroups][1][filters][0][field]=status&searchCriteria[filterGroups][1][filters][0][value]=1`,
  //         {
  //           headers: {
  //             Authorization: `Bearer ${token}`,
  //           },
  //         }
  //       );
  //       let newArray = [];
  //       response.data.items.filter((item) => {
  //         if (
  //           ele.extension_attributes.configurable_product_links.includes(
  //             item.id
  //           )
  //         ) {
  //           newArray.push(item);
  //         }
  //       });
  //       for (const element of newArray) {
  //         // return element
  //         const stock = await axios.get(`https://sparkyjeans.in/rest/default/V1/stockStatuses/${element.sku}`,
  //         {
  //           headers: {
  //             Authorization: `Bearer ${token}`,
  //           },
  //         })
  //         const delhiStock = stock.data.qty
  //         // console.log("delhiStock", delhiStock)
  //         const customAttributes = element.custom_attributes;
  //         for (const attribute of customAttributes) {
  //           if (attribute.attribute_code === "size") {
  //             const sizeLabels = await axios.get(
  //               "https://sparkyjeans.in/rest/V1/products/attributes/144",
  //               {
  //                 headers: {
  //                   Authorization: `Bearer ${token}`,
  //                 },
  //               }
  //             );
  //             const sizeLabel = sizeLabels.data.options.find(
  //               (size) => size.value == attribute.value
  //             );
  //             attribute.label = sizeLabel.label;
  //             if (
  //               !(
  //                 !ele.extension_attributes.configurable_product_options ||
  //                 ele.extension_attributes.configurable_product_options
  //                   .length === 0 ||
  //                 ele.extension_attributes.configurable_product_options[0]
  //                   .attribute_id != 144
  //               )
  //             ) {
  //               const atrributeValueArray =
  //                 ele.extension_attributes.configurable_product_options[0].values.map(
  //                   (value) => value.value_index
  //                 );
  //               if (atrributeValueArray.includes(Number(attribute.value))) {
  //                 ele.extension_attributes.configurable_product_options[0].values.push(
  //                   {
  //                     label: sizeLabel.label,
  //                     sku: element.sku,
  //                     value_index: attribute.value,
  //                     stock: delhiStock,
  //                     price: element.price
  //                   }
  //                 );
  //               }
  //             }
  //           }
  //         }
  //       }
  //       if (
  //         !(
  //           !ele.extension_attributes.configurable_product_options ||
  //           ele.extension_attributes.configurable_product_options.length ===
  //             0 ||
  //           ele.extension_attributes.configurable_product_options[0]
  //             .attribute_id != 144
  //         )
  //       ) {
  //         // remove elements which do not have label and sku in values
  //         ele.extension_attributes.configurable_product_options[0].values =
  //           ele.extension_attributes.configurable_product_options[0].values.filter(
  //             (value) => value.label && value.sku && value.stock && value.price
  //           );
  //       }
  //       const images = ele.media_gallery_entries;
  //       for (const image of images) {
  //         image.file = process.env.BASE_URL + `${image.file}`;
  //       }
  //       const customAttributes = ele.custom_attributes;
  //       for (const attribute of customAttributes) {
  //         if (
  //           attribute.attribute_code === "image" ||
  //           attribute.attribute_code === "small_image" ||
  //           attribute.attribute_code === "thumbnail"
  //         ) {
  //           attribute.value = process.env.BASE_URL + `${attribute.value}`;
  //         }
  //       }
  //     }
  //     for (const item of removeItems) {
  //       const index = response.data.items.indexOf(item);
  //       response.data.items.splice(index, 1);
  //     }
  //     //remove elemnts from response.data.items.extension_attributes.configurable_product_options has values array length as 0
  //     response.data.items = response.data.items.filter(
  //       (item) =>
  //         item.extension_attributes.configurable_product_options[0].values
  //           .length > 0
  //     );
  //     // from response.data.items return the id, sku, name, created_at, updated_at, from configurable_product_options return the values array entirely and the id, the media_gallery_entries array entirely and custom_attributes array entirely
  //     const finalResponse = response.data.items.map((item) => {
  //       return {
  //         id: item.id,
  //         sku: item.sku,
  //         name: item.name,
  //         created_at: item.created_at,
  //         updated_at: item.updated_at,
  //         configurable_product_options:[{
  //           id: item.extension_attributes.configurable_product_options[0].id,
  //           values: item.extension_attributes.configurable_product_options[0].values
  //         }],
  //         media_gallery_entries: item.media_gallery_entries,
  //         custom_attributes: item.custom_attributes,
  //       };
  //     })
  //     return finalResponse;
  //   } catch (err) {
  //     console.log("Error in getProduct function :: err", err);
  //     throw new Error(err);
  //   }
  // }
  async getCategories() {
    try {
      const token = await this.getAdminToken();
      const response = await axios.get(
        "https://sparkyjeans.in/rest/V1/categories",
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const finalObj = [];
      // return response.data
      const allCategoryArray = response.data.children_data[0].children_data;
      for (const category of allCategoryArray) {
        console.log("Category", category);
        if (category.is_active && category.children_data.length > 0) {
          const tempCategoryArray = category.children_data;
          for (const temp of tempCategoryArray) {
            if (temp.is_active) {
              finalObj.push({
                name: temp.name,
                id: temp.id,
              });
            }
          }
        } else {
          if (category.is_active) {
            finalObj.push({
              name: category.name,
              id: category.id,
            });
          }
        }
      }
      return finalObj;
      // return response.data
    } catch (err) {
      console.log("Error in getCategories function :: err", err);
      throw new Error(err);
    }
  }
  async getCustomerOrders(emailId) {
    try {
      const token = await this.getAdminToken();
      const customerData = await axios.get(
        `https://sparkyjeans.in/rest/V1/customers/search?searchCriteria[filterGroups][0][filters][0][field]=email&searchCriteria[filterGroups][0][filters][0][value]=${emailId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const customerId = customerData.data.items[0].id;
      const response = await axios.get(
        `https://sparkyjeans.in/rest/V1/orders?searchCriteria[filterGroups][0][filters][0][field]=customer_id&searchCriteria[filterGroups][0][filters][0][value]=${customerId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      // Filter out the orders which are already completed or cancelled before returning

      return response.data;
    } catch (err) {
      console.log("Error in getCustomerOrders function :: err", err);
      throw new Error(err);
    }
  }
  async trackOrder(orderId) {
    try {
      const token = await this.getAdminToken();
      const response = await axios.get(
        `https://sparkyjeans.in/rest/V1/shipments?searchCriteria[filterGroups][0][filters][0][field]=order_id&searchCriteria[filterGroups][0][filters][0][value]=${orderId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      // return response.data
      const tracking_number = response.data.items[0].tracks[0].track_number;
      // const shipmentId = response.data.items[0].increment_id
      // Call shiprocket API for status
      const shiprocketToken = await this.getShiprocketToken();
      const status = await axios.get(
        `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${tracking_number}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${shiprocketToken}`,
          },
        }
      );
      return status.data;
    } catch (err) {
      console.log("Error in trackOrder function :: err", err);
      throw new Error(err);
    }
  }
  async cancelOrder(orderId) {
    const cancel = await axios.post(
      `https://sparkyjeans.in/rest/default/V1/orders/${orderId}/cancel`
    );
    return cancel.data;
  }
  async checkExistingCustomer(number, token) {
    const existingCustomer = await axios.get(
      `https://sparkyjeans.in/rest/V1/customers/search?searchCriteria[filterGroups][0][filters][0][field]=mobile_number&searchCriteria[filterGroups][0][filters][0][value]=${number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (existingCustomer.data.items && existingCustomer.data.items.length > 0) {
      return true;
    }
    return false;
  }
  async getAdminToken() {
    try {
      const response = await axios.post(
        "https://sparkyjeans.in/rest/V1/integration/admin/token",
        {
          username: process.env.MAGENTO_USERNAME,
          password: process.env.MAGENTO_PASSWORD,
        }
      );
      return response.data;
    } catch (err) {
      console.log("Error in getAdminToken function :: err", err);
      throw new Error(err);
    }
  }
  async getShiprocketToken() {
    const token = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }
    );
    return token.data.token;
  }

  // Done
  async createPaymentLink(
    linkId,
    amount,
    name,
    purpose,
    expiry_time,
    whatsappNumber
  ) {
    const apiBase =
      process.env.CF_ENV === "prod"
        ? "https://api.cashfree.com"
        : "https://sandbox.cashfree.com";
    const clientId = process.env.CF_CLIENT_ID;
    const clientSecret = process.env.CF_CLIENT_SECRET;
    const apiVersion = "2023-08-01";
    const returnUrl = `https://wa.me/${whatsappNumber}`;
    const expiryTime = moment()
      .add(expiry_time, "m")
      .format("YYYY-MM-DDTHH:mm:ssZ");
    console.log("Whatsapp Number", whatsappNumber);
    try {
      const url = `${apiBase}/pg/links`;
      const payload = {
        link_id: linkId,
        link_amount: amount,
        link_currency: "INR",
        link_purpose: purpose,
        link_expiry_time: expiryTime,
        customer_details: {
          // customer_id: customerId,
          customer_name: name,
          // customer_email: customer.email,
          customer_phone: whatsappNumber,
        },
        link_notify: {
          send_sms: true,
          send_email: false,
        },
        link_meta: {
          return_url: returnUrl,
        },
      };
      const headers = {
        "Content-Type": "application/json",
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
        "x-api-version": apiVersion,
      };
      const { data } = await axios.post(url, payload, { headers });
      return data;
    } catch (err) {
      console.error(
        "Cashfree createPaymentLink error:",
        err.response?.data || err.message
      );
      throw new Error(err.response?.data?.message || err.message);
    }
  }

  async getDistanceBetweenPlaces(origin, destination, mode = "driving") {
    console.log(origin, destination);
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");

    const url = "https://maps.googleapis.com/maps/api/distancematrix/json";
    const params = {
      origins: origin,
      destinations: destination,
      mode,
      key: apiKey,
    };

    const { data } = await axios.get(url, { params });

    if (data.status !== "OK") {
      throw new Error(
        `Distance Matrix error: ${data.status} – ${
          data.error_message || "no details"
        }`
      );
    }

    const element = data.rows[0]?.elements[0];
    if (!element || element.status !== "OK") {
      throw new Error(`No route found: ${element?.status || "unknown"}`);
    }

    return {
      distance_text: element.distance.text, // e.g. "12.3 km"
      distance_value: element.distance.value, // in meters (e.g. 12345)
      duration_text: element.duration.text, // e.g. "18 mins"
      duration_value: element.duration.value, // in seconds (e.g. 1080)
    };
  }
  async geocodePincode(pincode) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");

    const url = `https://maps.googleapis.com/maps/api/geocode/json`;
    const { data } = await axios.get(url, {
      params: {
        // only look for this postal code in India
        components: `postal_code:${pincode}|country:IN`,
        key: apiKey,
      },
    });

    if (data.status !== "OK" || !data.results.length) {
      throw new Error(
        `Geocoding failed: ${data.status} – ${
          data.error_message || "no details"
        }`
      );
    }

    const { lat, lng } = data.results[0].geometry.location;
    console.log(`Geocoded pincode ${pincode} → lat:${lat}, lng:${lng}`);
    return { lat, lng };
  }

  // Done
  async getClosestStore(userPincode) {
    const stores = [{ pincode: "400022" }, { pincode: "400706" }];
    // 1) geocode the user's pincode
    const { lat: userLat, lng: userLng } = await this.geocodePincode(
      userPincode
    );

    // 2) geocode the stores' pincodes
    for (const store of stores) {
      const { lat, lng } = await this.geocodePincode(store.pincode);
      store.lat = lat;
      store.lng = lng;
    }

    // 3) compute distances
    let nearestStore = null;
    let bestDistance = Infinity; // meters
    let bestDuration = Infinity; // seconds

    for (const store of stores) {
      // call your Google API
      const { distance_value, duration_value, distance_text, duration_text } =
        await this.getDistanceBetweenPlaces(
          `${userLat},${userLng}`,
          `${store.lat},${store.lng}`
        );

      console.log({
        distance_value,
        distance_text,
        duration_value,
        duration_text,
      });

      // if strictly closer, or same distance but faster
      if (
        distance_value < bestDistance ||
        (distance_value === bestDistance && duration_value < bestDuration)
      ) {
        bestDistance = distance_value;
        bestDuration = duration_value;
        nearestStore = {
          ...store,
          distance_text,
          duration_text,
        };
      }
    }

    // after loop, `nearestStore` is the store object + the two text fields
    return nearestStore;
  }

  async storeAddresses() {
    const stores = [
      {
        address:
          "Gr Flr, Sion Garage Building, PN 112, Road, near Cinemax, Koliwada, Sion, Mumbai, Maharashtra 400022",
      },
    ];
    return this.attachMapsLinks(stores);
  }

  async attachMapsLinks(stores) {
    return stores.map((store) => ({
      ...store,
      mapsUrl:
        "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent(store.address),
    }));
  }



  async trimAndMux({ video, audio, subtitleText, out, idx, totalClips, fadeTime = 0.5 }) {
    // 1. make sure inputs exist
    await access(video); await access(audio);
  
    // 2. get duration of MP3 (in seconds, may be fractional)
    const durOutput = sh(`ffprobe -v error -show_entries format=duration \
                     -of default=noprint_wrappers=1:nokey=1 "${audio}"`);
    const dur = parseFloat(durOutput);
    if (isNaN(dur)) {
        console.error(`[Debug ${idx+1}] Failed to get duration for ${audio}. ffprobe output: "${durOutput}"`);
        throw new Error(`Failed to parse duration for ${audio}`);
    }
    console.log(`→ duration of ${audio}: ${dur}s`);
    // console.log(`${Number(dur) + 0.3}` + "s")

    const srtPath = `subtitle${idx + 1}.srt`;
    // const srtPath = path.resolve(baseSrtPath)
    const formatTime = (totalSeconds) => {
      if (isNaN(totalSeconds) || totalSeconds < 0) {
        console.warn(`[Debug ${idx+1}] Invalid totalSeconds for formatTime: ${totalSeconds}. Defaulting to 0.`);
        totalSeconds = 0;
      }
      const date = new Date(Math.round(totalSeconds * 1000));
      const timeStr = date.toISOString().slice(11, 23); 
      return timeStr.replace('.', ',');
    };
    const srtContent = `1\n00:00:00,000 --> ${formatTime(Number(dur) + 0.35)}\n${subtitleText}\n\n`;
    writeFileSync(srtPath, srtContent, "utf8");

    console.log(`[Debug ${idx+1}] CWD: ${process.cwd()}`);
    console.log(`[Debug ${idx+1}] Wrote SRT to: ${srtPath}`);
    let srtFileExistsAfterWrite = false;
    try {
      accessSync(srtPath, fsConstants.F_OK);
      srtFileExistsAfterWrite = true;
    } catch (e) {
      // File does not exist or is not accessible
      srtFileExistsAfterWrite = false;
    }
    console.log(`[Debug ${idx+1}] SRT Exists? ${srtFileExistsAfterWrite}`);
    if (!srtFileExistsAfterWrite) {
      throw new Error(`CRITICAL: SRT file ${srtPath} was NOT found immediately after writing!`);
    }

    let srtPathForFilter = srtPath.replace(/\\/g, '/');
    srtPathForFilter = srtPathForFilter.replace(/:/g, '\\:');
    srtPathForFilter = srtPathForFilter.replace(/'/g, "'\\''");

    let fadeEffects = "";
    let audioFadeEffects = "";
    const isFirstClip = idx === 0;
    const isLastClip = idx === totalClips - 1;
    
    if (isFirstClip && isLastClip) {
        // Single clip - fade in and out
        fadeEffects = `,fade=t=in:st=0:d=${fadeTime},fade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
        audioFadeEffects = `afade=t=in:st=0:d=${fadeTime},afade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
    } else if (isFirstClip) {
        // First clip - only fade in
        fadeEffects = `,fade=t=in:st=0:d=${fadeTime}`;
        audioFadeEffects = `afade=t=in:st=0:d=${fadeTime}`;
    } else if (isLastClip) {
        // Last clip - only fade out
        fadeEffects = `,fade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
        audioFadeEffects = `afade=t=out:st=${dur - fadeTime}:d=${fadeTime}`;
    }
    
    const ffArgs = [
      "-ss", "0", "-t", (Number(dur) + 0.3).toString(), "-i", video,
      "-i", audio,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-crf", "20", "-preset", "fast",
      "-c:a", "aac", "-ac", "2",
      "-vf", `fps=30,format=yuv420p,subtitles='${srtPathForFilter}':force_style='FontName=Arial,FontSize=16,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=1,Outline=1,Shadow=0,MarginV=30'${fadeEffects}`,
      ...(audioFadeEffects ? ["-af", audioFadeEffects] : []),
      "-shortest", out
    ];

    console.log(`[Debug ${idx+1}] Running ffmpeg with args: ffmpeg ${ffArgs.join(' ')}`);

    const { status, error } = spawnSync("ffmpeg", ffArgs, { stdio: "inherit" });
    if (status !== 0) {
      console.error(`[Debug ${idx+1}] ffmpeg failed for ${video}. Status: ${status}`, error);
      throw new Error(`ffmpeg failed on ${video}. Status: ${status}`);
    }
    let srtFileExistsBeforeUnlink = false;
    try {
      accessSync(srtPath, fsConstants.F_OK);
      srtFileExistsBeforeUnlink = true;
    } catch (e) {
      srtFileExistsBeforeUnlink = false;
    }
    if (srtFileExistsBeforeUnlink) {
        unlinkSync(srtPath); 
    }
  }
  async generateSourcesArray() {
    try {
      const videoFolder = 'Videos/Scenes/Vadilal';
      const audioFolder = 'Videos/Audio/Vadilal';
      
      // Read both directories
      const [videoFiles, audioFiles] = await Promise.all([
        fs.promises.readdir(videoFolder),
        fs.promises.readdir(audioFolder)
      ]);
      
      // Filter for video files (mp4, mov, avi, etc.)
      const videoClips = videoFiles
        .filter(file => /\.(mp4|mov|avi|mkv|webm)$/i.test(file))
        .sort((a, b) => {
          // Extract numbers from filenames for proper sorting
          const numA = parseInt(a.match(/\d+/) || 0);
          const numB = parseInt(b.match(/\d+/) || 0);
          return numA - numB;
        });
      
      // Filter for audio files (mp3, wav, aac, etc.)
      const audioClips = audioFiles
        .filter(file => /\.(mp3|wav|aac|ogg|flac)$/i.test(file))
        .sort((a, b) => {
          // Extract numbers from filenames for proper sorting
          const numA = parseInt(a.match(/\d+/) || 0);
          const numB = parseInt(b.match(/\d+/) || 0);
          return numA - numB;
        });
      
      // Generate sources array
      const maxLength = Math.max(videoClips.length, audioClips.length);
      const sources = [];
      
      for (let i = 0; i < maxLength; i++) {
        const source = {};
        
        if (videoClips[i]) {
          source.video = path.join(videoFolder, videoClips[i]);
        }
        
        if (audioClips[i]) {
          source.audio = path.join(audioFolder, audioClips[i]);
        }
        
        sources.push(source);
      }
      
      console.log(`Found ${videoClips.length} video files and ${audioClips.length} audio files`);
      console.log('Generated sources array:');
      // console.log(JSON.stringify(sources, null, 2));
      
      return sources;
      
    } catch (error) {
      console.error('Error reading directories:', error.message);
      return [];
    }
  }
  async createVideo() {
    const narrationLines = readFileSync("narrations.txt", "utf8").split("\n").filter(Boolean);
    console.log(narrationLines)
    const sources = await this.generateSourcesArray()
    console.log(sources)
    const trimmedFiles = [];
    // --- parallel version ---
    const trimJobs = sources.map(({ video, audio }, idx) => {
      const out = `clip${idx + 1}_done.mp4`;
      const subtitleText = narrationLines[idx] || "";
      trimmedFiles.push(out);
      return this.trimAndMux({ video, audio, subtitleText, out, idx, totalClips: sources.length, fadeTime: 0.5  });
    });

    try {
      await Promise.all(trimJobs);
      console.log("All trimAndMux jobs completed. Trimmed files:", trimmedFiles);
    } catch (error) {
      console.error("Error during trimAndMux process:", error);
      trimmedFiles.forEach((f) => {
        try {
          accessSync(f, fsConstants.F_OK); // Check if file exists before unlinking
          unlinkSync(f); 
        } catch (e) { 
          console.warn(`Could not delete temp file ${f} on error: ${e.message}`);
        }
      });
      throw error; 
    }

    const listText = trimmedFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
    writeFileSync("list.txt", listText);
    console.log("Generated list.txt for concatenation:", listText);

    // console.log("Running concatenation command: ffmpeg -y -f concat -safe 0 -i list.txt -c copy final.mp4");
    
    try {
      const concatResult = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "final.mp4"], { stdio: "inherit" });
      if (concatResult.status !== 0) {
        console.error("ffmpeg concatenation failed.", concatResult.error);
        throw new Error("ffmpeg failed while concatenating clips. Status: " + concatResult.status);
      }
    } catch (error) {
        console.error("Error during concatenation:", error);
        try {
            accessSync("list.txt", fsConstants.F_OK);
            unlinkSync("list.txt");
        } catch (e) { /* ignore */ }
        throw error;
    }

    console.log("Cleaning up temporary files...");
    [...trimmedFiles, "list.txt"].forEach((f) => {
      try {
        accessSync(f, fsConstants.F_OK); // Check if file exists
        unlinkSync(f); 
        console.log(`Deleted: ${f}`);
      } catch (e) { 
        // console.warn(`Could not delete temporary file ${f}: ${e.message}`);
      }
    });
    
    return "✅ final.mp4 ready";

    /** 4️⃣  concat all videos + overlay background music */
    // const concatArgs = [
    //   "-f", "concat", "-safe", "0", "-i", "list.txt",
    //   "-i", "music.mp3",
    //   "-map", "0:v:0", "-map", "1:a:0",
    //   "-c:v", "copy",
    //   "-c:a", "aac", "-ac", "2",
    //   "-shortest", "final.mp4",
    // ];
    // const { status } = spawnSync("ffmpeg", concatArgs, { stdio: "inherit" });
    // if (status !== 0) throw new Error("ffmpeg failed while concatenating clips");
    // sh(`printf "file 'clip1_done.mp4'\\nfile 'clip2_done.mp4'\\n" > list.txt`);
    sh(`ffmpeg -f concat -safe 0 -i list.txt -c copy final.mp4`);
    /** 5️⃣  tidy up */
    [...trimmedFiles, "list.txt"].forEach((f) => {
      try { unlinkSync(f); } catch { /* ignore if already gone */ }
    });
    return "✅  final.mp4 ready";
  }
  async getAvailableVoices() {
      try {
          console.log('Fetching available voices from ElevenLabs...');
          
          const response = await this.axiosInstance.get('/voices', {
              headers: {
                  'Accept': 'application/json'
              }
          });

          if (response.status !== 200) {
              throw {
                  type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                  err: `Failed to fetch voices. Status: ${response.status}`
              };
          }

          const voices = response.data.voices || [];
          console.log(`Retrieved ${voices.length} voices`);
          
          // Return simplified voice information
          return voices.map(voice => ({
              voice_id: voice.voice_id,
              name: voice.name,
              category: voice.category,
              description: voice.description,
              preview_url: voice.preview_url,
              available_for_tiers: voice.available_for_tiers,
              settings: voice.settings
          }));

      } catch (error) {
          console.error('Error in getAvailableVoices:', error);
          
          if (error.response) {
              const status = error.response.status;
              if (status === 401) {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.UNAUTHORIZED,
                      err: 'Invalid ElevenLabs API key'
                  };
              } else {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                      err: `Failed to fetch voices from ElevenLabs API (${status})`
                  };
              }
          } else if (error.type) {
              throw error;
          } else {
              throw {
                  type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                  err: error.message || 'Unknown error occurred while fetching voices'
              };
          }
      }
  }
  async convertTextToVoice({ text, voiceId }) {
      try {
          if (!text || text.trim().length === 0) {
              throw {
                  type: __constants.RESPONSE_MESSAGES.VALIDATION_ERROR,
                  err: 'Text is required and cannot be empty'
              };
          }

          const selectedVoiceId = voiceId
          const selectedModel = this.defaultModel;
          const selectedVoiceSettings = { ...this.defaultVoiceSettings };

          console.log(`Converting text to speech: ${text.substring(0, 50)}...`);
          console.log(`Using voice ID: ${selectedVoiceId}, Model: ${selectedModel}`);

          const requestBody = {
              text: text,
              model_id: selectedModel,
              voice_settings: selectedVoiceSettings
          };

          const response = await this.axiosInstance.post(
              `/text-to-speech/${selectedVoiceId}`,
              requestBody,
              {
                  responseType: 'arraybuffer'
              }
          );

          if (response.status !== 200) {
              throw {
                  type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                  err: `ElevenLabs API returned status: ${response.status}`
              };
          }

          console.log('Text-to-speech conversion successful');
          const audioFilename = this.generateFilename();
          const filePath = path.join(this.downloadFolder, audioFilename);
          
          // Save audio buffer to file
          const audioBuffer = Buffer.from(response.data);
          await fs.promises.writeFile(filePath, audioBuffer);
          
          console.log(`Audio file saved successfully: ${filePath}`);
          return {
            success: true,
            message: 'Audio file generated and saved successfully',
            filename: audioFilename,
            path: filePath
        };

      } catch (error) {
          console.error('Error in convertTextToVoice:', error);
          
          if (error.response) {
              // ElevenLabs API error
              const status = error.response.status;
              const errorData = error.response.data;
              
              let errorMessage = 'ElevenLabs API error';
              if (errorData && errorData.detail) {
                  errorMessage = errorData.detail.message || errorData.detail;
              } else if (errorData) {
                  errorMessage = errorData.toString();
              }

              if (status === 401) {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.UNAUTHORIZED,
                      err: 'Invalid ElevenLabs API key'
                  };
              } else if (status === 422) {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.VALIDATION_ERROR,
                      err: `Validation error: ${errorMessage}`
                  };
              } else if (status === 429) {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                      err: 'Rate limit exceeded. Please try again later.'
                  };
              } else {
                  throw {
                      type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                      err: `ElevenLabs API error (${status}): ${errorMessage}`
                  };
              }
          } else if (error.request) {
              // Network error
              throw {
                  type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                  err: 'Failed to connect to ElevenLabs API. Please check your internet connection.'
              };
          } else if (error.type) {
              // Custom error from our validation
              throw error;
          } else {
              // Other errors
              throw {
                  type: __constants.RESPONSE_MESSAGES.SERVER_ERROR,
                  err: error.message || 'Unknown error occurred during text-to-speech conversion'
              };
          }
      }
  }
  generateFilename(extension = 'mp3') {
      // Create a safe filename from text (first 30 chars)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      const uniqueId = uuidv4().substring(0, 8);
      
      return `converted_audio_${timestamp}_${uniqueId}.${extension}`;
  }
}

module.exports = new ProductService();
