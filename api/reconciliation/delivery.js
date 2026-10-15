"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("../_lib/supabase.js");

module.exports = async function deliveryDecision(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const body = await readJson(request);
    const transaction = await supabaseRequest("/rest/v1/rpc/decide_receiving_delivery", {
      method: "POST", token,
      body: {
        target_delivery_id: body.deliveryId,
        delivery_decision: body.decision,
        decision_reason: body.reason,
        request_idempotency_key: body.idempotencyKey
      }
    });
    sendJson(response, 200, { transactionId: transaction });
  } catch (error) {
    handlerErrors(response, error);
  }
};
