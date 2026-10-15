"use strict";

const {
  requireBearer, supabaseRequest, sendJson, handlerErrors
} = require("./_lib/supabase.js");

module.exports = async function inventory(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const businessId = new URL(request.url, "http://localhost").searchParams.get("businessId");
    if (!businessId) throw Object.assign(new Error("A businessId is required."), { statusCode: 400 });
    const filter = encodeURIComponent(`eq.${businessId}`);
    const [products, balances] = await Promise.all([
      supabaseRequest(`/rest/v1/products?business_id=${filter}&active=eq.true&select=id,sku,name,brand,base_unit,low_stock_threshold,reorder_threshold`, { token }),
      supabaseRequest(`/rest/v1/inventory_balances?business_id=${filter}&select=product_id,quantity`, { token })
    ]);
    const balanceByProduct = new Map((balances || []).map((row) => [row.product_id, row.quantity]));
    sendJson(response, 200, {
      inventory: (products || []).map((product) => ({
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        brand: product.brand,
        baseUnit: product.base_unit,
        currentStock: Number(balanceByProduct.get(product.id) || 0),
        restockAt: Number(product.low_stock_threshold || 0),
        reorderQuantity: Number(product.reorder_threshold || 0)
      }))
    });
  } catch (error) {
    handlerErrors(response, error);
  }
};
