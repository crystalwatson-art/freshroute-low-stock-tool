"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("./_lib/supabase.js");

module.exports = async function receiving(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method === "GET") {
      const businessId = new URL(request.url, "http://localhost").searchParams.get("businessId");
      if (!businessId) throw Object.assign(new Error("A businessId is required."), { statusCode: 400 });
      const records = await supabaseRequest("/rest/v1/rpc/list_receiving_records", {
        method: "POST", token, body: { target_business_id: businessId }
      });
      sendJson(response, 200, { records: records || [] });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const body = await readJson(request);
    if (!body.businessId || !body.idempotencyKey) {
      throw Object.assign(new Error("A businessId and idempotencyKey are required."), { statusCode: 400 });
    }
    const result = await supabaseRequest("/rest/v1/rpc/record_receiving_delivery", {
      method: "POST", token,
      body: {
        target_business_id: body.businessId,
        client_key: body.idempotencyKey,
        delivery_payload: body.delivery,
        item_payload: body.items
      }
    });
    sendJson(response, 200, { result });
  } catch (error) {
    handlerErrors(response, error);
  }
};
