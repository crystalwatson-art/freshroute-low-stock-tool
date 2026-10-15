"use strict";

const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("../_lib/supabase.js");

module.exports = async function profile(request, response) {
  try {
    const token = requireBearer(request);
    const body = request.method === "POST" ? await readJson(request) : {};
    await supabaseRequest("/rest/v1/rpc/sync_current_app_user", {
      method: "POST", token,
      body: {
        profile_email: String(body.email || "").trim(),
        profile_display_name: String(body.displayName || body.email || "FreshRoute user").trim()
      }
    });
    const memberships = await supabaseRequest(
      "/rest/v1/business_memberships?select=business_id,role,status,invitation_accepted_at&status=eq.active&order=created_at.asc",
      { token }
    );
    sendJson(response, 200, { memberships });
  } catch (error) {
    handlerErrors(response, error);
  }
};
