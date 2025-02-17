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
  async getNewDrops(pageSize) {
    try {
      let page = 10;
      if (pageSize) {
        page = pageSize;
      }
      const token = await this.getAdminToken();
      // console.log(token)
      const response = await axios.get(
        `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${page}&searchCriteria[sortOrders][0][field]=updated_at&searchCriteria[filterGroups][0][filters][0][field]=status&searchCriteria[filterGroups][0][filters][0][value]=1&searchCriteria[filterGroups][1][filters][0][field]=visibility&searchCriteria[filterGroups][1][filters][0][value]=4
`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const removeItems = [];

      for (const ele of response.data.items) {
        if (
          !ele.extension_attributes.configurable_product_options ||
          ele.extension_attributes.configurable_product_options.length === 0 ||
          ele.extension_attributes.configurable_product_options[0]
            .attribute_id != 144
        ) {
          // remove from response.data.items array
          removeItems.push(ele);
        }

        const response = await axios.get(
          `https://sparkyjeans.in/rest/V1/products?searchCriteria[pageSize]=${100}&searchCriteria[filterGroups][0][filters][0][field]=name&searchCriteria[filterGroups][0][filters][0][value]=${
            ele.name
          }&searchCriteria[filterGroups][1][filters][0][field]=status&searchCriteria[filterGroups][1][filters][0][value]=1`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        const newArray = [];
        response.data.items.filter((item) => {
          if (
            ele.extension_attributes.configurable_product_links.includes(
              item.id
            )
          ) {
            newArray.push(item);
          }
        });
        for (const element of newArray) {
          const customAttributes = element.custom_attributes;
          for (const attribute of customAttributes) {
            if (attribute.attribute_code === "size") {
              const sizeLabels = await axios.get(
                "https://sparkyjeans.in/rest/V1/products/attributes/144",
                {
                  headers: {
                    Authorization: `Bearer ${token}`,
                  },
                }
              );
              const sizeLabel = sizeLabels.data.options.find(
                (size) => size.value == attribute.value
              );
              attribute.label = sizeLabel.label;
              if (
                !(
                  !ele.extension_attributes.configurable_product_options ||
                  ele.extension_attributes.configurable_product_options
                    .length === 0 ||
                  ele.extension_attributes.configurable_product_options[0]
                    .attribute_id != 144
                )
              ) {
                const atrributeValueArray =
                  ele.extension_attributes.configurable_product_options[0].values.map(
                    (value) => value.value_index
                  );
                if (atrributeValueArray.includes(Number(attribute.value))) {
                  ele.extension_attributes.configurable_product_options[0].values.push(
                    {
                      label: sizeLabel.label,
                      sku: element.sku,
                      value_index: attribute.value,
                    }
                  );
                }
              }
            }
          }
        }
        if (
          !(
            !ele.extension_attributes.configurable_product_options ||
            ele.extension_attributes.configurable_product_options.length ===
              0 ||
            ele.extension_attributes.configurable_product_options[0]
              .attribute_id != 144
          )
        ) {
          // remove elements which do not have label and sku in values
          ele.extension_attributes.configurable_product_options[0].values =
            ele.extension_attributes.configurable_product_options[0].values.filter(
              (value) => value.label && value.sku
            );
        }
        const images = ele.media_gallery_entries;
        for (const image of images) {
          image.file = process.env.BASE_URL + `${image.file}`;
        }
        const customAttributes = ele.custom_attributes;
        for (const attribute of customAttributes) {
          if (
            attribute.attribute_code === "image" ||
            attribute.attribute_code === "small_image" ||
            attribute.attribute_code === "thumbnail"
          ) {
            attribute.value = process.env.BASE_URL + `${attribute.value}`;
          }
        }
      }
      for (const item of removeItems) {
        const index = response.data.items.indexOf(item);
        response.data.items.splice(index, 1);
      }
      return response.data;
    } catch (err) {
      console.log("Error in getProduct function :: err", err);
      throw new Error(err);
    }
  }
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
