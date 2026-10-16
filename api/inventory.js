"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("./_lib/supabase.js");

module.exports = async function inventory(request, response) {
  try {
    const token = requireBearer(request);
    if (!["GET", "PATCH"].includes(request.method)) {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const businessId = new URL(request.url, "http://localhost").searchParams.get("businessId");
    if (!businessId) throw Object.assign(new Error("A businessId is required."), { statusCode: 400 });
    if (request.method === "PATCH") {
      const body = await readJson(request);
      if (!body.productId) throw Object.assign(new Error("A productId is required."), { statusCode: 400 });
      const result = await supabaseRequest("/rest/v1/rpc/update_product_expiration_warning", {
        method: "POST", token,
        body: {
          target_product_id: body.productId,
          warning_days: body.warningDays
        }
      });
      sendJson(response, 200, { productId: result });
      return;
    }
    const filter = encodeURIComponent(`eq.${businessId}`);
    const [products, balances, lots] = await Promise.all([
      supabaseRequest(`/rest/v1/products?business_id=${filter}&active=eq.true&select=id,sku,name,brand,base_unit,low_stock_threshold,reorder_threshold,expiration_warning_days`, { token }),
      supabaseRequest(`/rest/v1/inventory_balances?business_id=${filter}&select=product_id,quantity`, { token }),
      supabaseRequest(`/rest/v1/inventory_lot_balances?business_id=${filter}&quantity=gt.0&select=product_id,lot_id,lot_code,expiration_date,quantity,expiration_warning_days`, { token })
    ]);
    const balanceByProduct = new Map((balances || []).map((row) => [row.product_id, row.quantity]));
    const today = new Date().toISOString().slice(0, 10);
    const daysBetween = (expirationDate) => {
      if (!expirationDate) return null;
      const days = (Date.parse(`${expirationDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
      return Number.isFinite(days) ? Math.round(days) : null;
    };
    const lotsByProduct = new Map();
    (lots || []).forEach((lot) => {
      const daysToExpiry = daysBetween(lot.expiration_date);
      const warningDays = Number(lot.expiration_warning_days || 14);
      const entry = {
        lotId: lot.lot_id,
        lotCode: lot.lot_code,
        expirationDate: lot.expiration_date,
        quantity: Number(lot.quantity || 0),
        daysToExpiry,
        expired: daysToExpiry !== null && daysToExpiry < 0,
        expiringSoon: daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= warningDays
      };
      if (!lotsByProduct.has(lot.product_id)) lotsByProduct.set(lot.product_id, []);
      lotsByProduct.get(lot.product_id).push(entry);
    });
    sendJson(response, 200, {
      asOfDate: today,
      inventory: products.map((product) => {
        const productLots = lotsByProduct.get(product.id) || [];
        const datedLots = productLots.filter((lot) => lot.daysToExpiry !== null);
        const earliestLot = datedLots.slice().sort((a, b) => a.daysToExpiry - b.daysToExpiry)[0];
        return {
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        brand: product.brand,
        baseUnit: product.base_unit,
        currentStock: Number(balanceByProduct.get(product.id) || 0),
        restockAt: Number(product.low_stock_threshold || 0),
        reorderQuantity: Number(product.reorder_threshold || 0),
        expirationWarningDays: Number(product.expiration_warning_days || 14),
        daysToExpiry: earliestLot?.daysToExpiry ?? null,
        expirationDate: earliestLot?.expirationDate || null,
        expiredStock: productLots.filter((lot) => lot.expired).reduce((sum, lot) => sum + lot.quantity, 0),
        expiringSoonStock: productLots.filter((lot) => lot.expiringSoon).reduce((sum, lot) => sum + lot.quantity, 0),
        lots: productLots
        };
      })
    });
  } catch (error) {
    handlerErrors(response, error);
  }
};
