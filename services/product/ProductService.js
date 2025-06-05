const axios = require("axios");
const moment = require("moment");
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class ProductService {
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

      console.log({ distance_value, distance_text, duration_value, duration_text });

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
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BHAJANPURA, F-610, KHAJURI KHAS, MAIN WAZIRABAD ROAD, DELHI, DELHI 110094" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BURARI, GROUND FLOOR, KH NO 346, MAIN ROAD 100 FUTA ROAD, NEW DELHI, DELHI 110084" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., JAIL ROAD, C-117, FATEH NAGAR, NEW DELHI, NEW DELHI, DELHI 110018" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., KHANPUR, B-28 DUGGAL COLONY, DEVLI ROAD, NEW DELHI, DELHI 110062" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., NAJAFGARH, KHASRA NO 18/3/2,6/2,7/3 LAXMI GARDEN NAJAFGARH, NEW DELHI, DELHI 110043" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., NANGLOI, KH NO, 43/1 POLE NO 12, NEAR DALVIR SONS, NAJAFGARH ROAD, DELHI, DELHI 110041" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., UTTAM NAGAR, WZ-246-B-6, MAIN NAJAFGARH ROAD UTTAM NAGAR, DELHI, DELHI 110059" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., DURGA PURI, 1449/23-A DURGA PURI, NEW DELHI, DELHI 110093" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., GANDHI NAGAR, IX/6704, NEW DELHI, DELHI 110031" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., JANTA GALI GANDHI NAGAR, IX/6745,6769, 6770, NEW DELHI, DELHI 110027" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., KAMLA NAGAR, GROUND FLOOR, SHOP NO E-169, MAIN MARKET, KAMLA NAGAR, NEW DELHI, DELHI 110007" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., KRISHNA NAGAR, C-4/1 MANDIR MARG, NEW DELHI, DELHI 110051" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., NCJ, BUILDING NO/FLAT NO. IX/6828 JANTA GALI, NEW DELHI, DELHI 110027" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., RANI BAGH, SHOP NO 746, RISHI NAGAR SHAKUR BASTI, DELHI, DELHI 110034" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., ROHINI, SHOP NO 117, PLOT NO 1133, FIRST FLOOR, DELHI, DELHI 110085" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., SHAHEEN BAGH, G-79, SHAHEEN BAGH KALINDI KUNJ MAIN ROAD ABUL FAZAL, NEW DELHI, DELHI 110025" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., V3S MALL, F97, 1ST FLOOR, PLOT NO 12, NEW DELHI, DELHI 110092" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BHIWANI, SHOP NO 213, CRWON PLAZA , RING ROAD, BHIWANI, HARYANA 127021" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., HISAR, SCF 82, FIRST & SECOND FLOOR URBAN ESTATE II, HISAR, HARYANA 125001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., MANESAR, NH-8, MANESAR OPP POWER HOUSE & RED TAPE NATIONAL SECURITY, GURGAON, HARYANA 122050" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., ROHTAK, SHOP NO 4 2/30, DELHI ROAD ADARSH NAGAR, ROHTAK, HARYANA 124001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., KARNAL, SHOP NO 24, MC MARKET, KUNJPURA ROAD, KARNAL, KARNAL, HARYANA 132001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., PANIPAT, SHOP NO 878 R, MODEL TOWN, PANIPAT, HARYANA 132103" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., SONIPAT, 283/20, 283A/20 ATLAS ROAD, INDIRA COLONY, SONIPAT, HARYANA 131001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BHIWADI, PLOT NO. 161, CENTRE MARKET, SAMTAL CHOWK BHIWADI DISTT, BHIWADI, RAJASTHAN 301019" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., AGRA KARGIL, SHOP NO. 1 GROUND FLOOR, PLOT NO 88 DREAM COMPLEX, AGRA, UTTAR PRADESH 282007" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., AGRA SADAR, GROUND FLOOR, D3, D4, SADAR BAZAR AGRA , GWALIOR ROAD, AGRA, UTTAR PRADESH 282001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BARAUT, SHOP NO. 899, NAVYUG COLONY, NAVYUG MARKET, BARAUT, UTTAR PRADESH 250611" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BIJNOR, SAI HOTEL, MAIN CIVIL LINIES MAMCHAND PETROL PUMP, BIJNOR, UTTAR PRADESH 246701" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., KHURJA, GROUND FLOOR GATA NO 2162 RAGHAV BHAVAN OPP VISHAL MEGA, KHURJA, UTTAR PRADESH 203131" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., LONI, SHOP NO 8A AND 9, BALRAM NAGAR,LALBAUG COLONY, LONI, UTTAR PRADESH 201102" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., MAMURA, GROUND & 1 FLOOR, KHASRA NO 42M, MANISH KAJ HOUSE, NOIDA, UTTAR PRADESH 201301" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., MATHURA, SHOP NO-215/64, DIBIL NAGAR KRISHNA NAGAR, MATHURA, UTTAR PRADESH 281004" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., MORADABAD, GROUND FLOOR MANKAMNA COMPLEX NEAR JAIN MANDIR, MORADABAD, UTTAR PRADESH 244001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., MUZAFFARNAGAR, GROUN & 1ST FLOOR, PLOT NO 97B/1/10, MUZAFFARNAGAR, UTTAR PRADESH 251001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., SAHARANPUR, SHOP NO 2C/3593 GILL COLONY, SAHARANPUR, UTTAR PRADESH 247001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., SECTOR 141, SHOP NO 48 OPP BLOSSOM COUNTY SECTOR 141, NOIDA, UTTAR PRADESH 201305" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., BULANDSHAHR, SHOP NO 3 STORY BUILDING AT KALA AAM SE KALI NADI KI OR, BULANDSHAHR, UTTAR PRADESH 203001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., DADRI, RAM SINGH HOTEL, GT ROAD, GHAZIABAD, UTTAR PRADESH 203207" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., GHANDI NAGAR GZB, SHOP NO 1 BUILDING NUMBER -196/424, GANDHI NAGAR PURVA, GHAZIABAD, UTTAR PRADESH 201001" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., LAL KUAN, C-7, PANCHSHEEL COLON, LAL KUAN, GHAZIABAD UP, GHAZIABAD, UTTAR PRADESH 201009" },
      { "address": "JK JAIN GARMENTEX (INDIA) PVT. LTD., ROORKEE, SHOP NO 157/2 11 CIVIL LINES PREM MANDIR ROAD, ROORKEE, UTTARAKHAND 247667" }
    ]  
    // const stores = [{"address": "Beach Apartments, Versova, Andheri (West), Mumbai 400061"}]  
    return this.attachMapsLinks(stores)
  }

  async attachMapsLinks(stores) {
    return stores.map(store => ({
      ...store,
      mapsUrl:
        "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent(store.address)
    }));
  }

  async createFluxKontext(imagePath) {
    const BFL_API_KEY = process.env.BFL_API_KEY;
    try {
      // Read and encode the image in base64
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      const sessionId = uuidv4();
      const outputImageDir = `Output_${sessionId}`;
      fs.mkdirSync(outputImageDir, { recursive: true });
  
      // POST request to the API
      for (let i = 1; i <= 4; i++) {
        console.log(`Processing image run ${i}...`);
  
        const uploadResponse = await axios.post(
          'https://api.us1.bfl.ai/v1/flux-kontext-pro',
          {
            prompt: 'Replace mannequin with a brazillian woman with 5 feet 7 inches height. Make the woman wear heavy necklace and earrings. Make the background an opulent mughal palace. Keep aspect ratio as 9:16. Fashion photography, High fashion pose. Dont change the lehenga details.',
            // prompt: "Full body shot, back facing pose of man wearing tshirt and black jeans and make the background a busy new york street. Aspect ratio of 9:16. Fashion photography, High fashion pose. Make the man look down towards the road on the left.",
            // prompt: "Full body shot of a Brazillian man wearing tshirt, with black shorts and white shoes and make the background a beach woodfront. Aspect ratio of 9:16. Fashion photography, High fashion pose. No sunglasses",
            input_image: base64Image,
            safety_tolerance: 2
          },
          {
            headers: {
              'accept': 'application/json',
              'x-key': BFL_API_KEY,
              'Content-Type': 'application/json',
            },
          }
        );
  
        const requestId = uploadResponse.data.id;
        const resultImageUrl = await this.pollForResult(requestId);
  
        if (resultImageUrl) {
          const outputPath = path.join(outputImageDir, `result-${i}.jpg`);
          await this.downloadImage(resultImageUrl, outputPath);
          console.log(`Saved: result-${i}.jpg`);
        } else {
          console.warn(`Run ${i} failed or returned no image.`);
        }
      }
      console.log(`All results saved in folder: ${outputImageDir}`)
      return `All results saved in folder: ${outputImageDir}`
      
    } catch (error) {
      console.error('Error sending image:', error.response?.data || error.message);
    }
    finally{
      fs.unlinkSync(imagePath);
    }
  }
  async pollForResult(requestId) {
    console.log('Polling for result...');
    const BFL_API_KEY = process.env.BFL_API_KEY;
    while (true) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s delay

        const pollResponse = await axios.get(
          'https://api.us1.bfl.ai/v1/get_result',
          {
            headers: {
              accept: 'application/json',
              'x-key': BFL_API_KEY,
            },
            params: { id: requestId },
          }
        );

        const status = pollResponse.data.status;
        console.log(`Polling [${requestId}] status:`, status);

        if (status === 'Ready') {
          return pollResponse.data.result?.sample;
        }

      } catch (error) {
        console.error('Polling error:', error.response?.data || error.message);
        break;
      }
    }
  }
  async downloadImage(url, filePath) {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading image:', error.response?.data || error.message);
    }
  }
}

module.exports = new ProductService();
