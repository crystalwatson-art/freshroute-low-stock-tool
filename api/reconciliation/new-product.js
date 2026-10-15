"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("../_lib/supabase.js");

module.exports = async function newProduct(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const body = await readJson(request);
    if (!body.reviewId || !body.decision || !body.reason) {
      throw Object.assign(new Error("Review, decision, and reason are required."), { statusCode: 400 });
    }
    const transaction = await supabaseRequest("/rest/v1/rpc/review_new_product", {
      method: "POST", token,
      body: {
        target_review_id: body.reviewId,
        decision: body.decision,
        decision_reason: body.reason,
        request_idempotency_key: body.idempotencyKey || null
      }
    });
    sendJson(response, 200, { transactionId: transaction });
  } catch (error) {
    handlerErrors(response, error);
  }
};
