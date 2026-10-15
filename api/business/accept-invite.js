"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("../_lib/supabase.js");

module.exports = async function acceptInvite(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const body = await readJson(request);
    const result = await supabaseRequest("/rest/v1/rpc/accept_business_invitation", {
      method: "POST", token,
      body: {
        target_invitation_id: body.invitationId,
        invitation_token: body.invitationToken,
        profile_email: body.email,
        profile_display_name: body.displayName
      }
    });
    sendJson(response, 200, { businessId: result });
  } catch (error) {
    handlerErrors(response, error);
  }
};
