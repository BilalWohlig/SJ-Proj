const axios = require("axios");
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
  async getNewDrops(pageSize = 10) {
    try {
      const token = await this.getAdminToken();
      const config = { headers: { Authorization: `Bearer ${token}` } };
  
      // Fetch products
      const { data: productsData } = await axios.get(
        `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[sortOrders][0][field]=updated_at&searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=1&searchCriteria[filterGroups][1][filters][0][field]=visibility&searchCriteria[filterGroups][1][filters][0][value]=4`,
        config
      );
      const products = productsData.items;
  
      // Filter products with valid configurable product options (attribute 144)
      const validProducts = products.filter((product) => {
        const options = product.extension_attributes?.configurable_product_options;
        return (
          options &&
          options.length > 0 &&
          options[0].attribute_id == 144
        );
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
            product.extension_attributes.configurable_product_links.includes(item.id)
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
            (val) =>
              val.label &&
              val.sku &&
              val.stock &&
              val.price
          );
  
          // Update image URLs for media and custom attributes. Check if the field disabled is false or not. Return false items only
          const media_gallery_entries = (product.media_gallery_entries || []).map(
            (entry) => {
              if (!entry.disabled) {
                return { ...entry, file: process.env.BASE_URL + entry.file };
              }
            }
          );
  
          const custom_attributes = (product.custom_attributes || []).map((attr) => {
            if (
              ["image", "small_image", "thumbnail"].includes(attr.attribute_code)
            ) {
              return { ...attr, value: process.env.BASE_URL + attr.value };
            }
            return attr;
          });
  
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
      const allCategoryArray = response.data.children_data[0].children_data;
      for (const category of allCategoryArray) {
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
      return response.data;
    } catch (err) {
      console.log("Error in getCustomerOrders function :: err", err);
      throw new Error(err);
    }
  }
  async trackOrder(emailId) {
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
      return response.data;
    } catch (err) {
      console.log("Error in getCategories function :: err", err);
      throw new Error(err);
    }
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
}

module.exports = new ProductService();
