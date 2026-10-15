"use strict";

const crypto = require("node:crypto");
const {
  requireBearer, readJson, supabaseRequest, sendJson, handlerErrors
} = require("../_lib/supabase.js");

module.exports = async function invite(request, response) {
  try {
    const token = requireBearer(request);
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw Object.assign(
        new Error("Invitation email delivery is not configured. Add the server-only Supabase service key before creating invitations."),
        { statusCode: 503 }
      );
    }
    const body = await readJson(request);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const invitationId = await supabaseRequest("/rest/v1/rpc/create_business_invitation", {
      method: "POST", token,
      body: {
        target_business_id: body.businessId,
        invite_email: body.email,
        invite_role: body.role,
        invite_token_hash: crypto.createHash("sha256").update(rawToken).digest("hex")
      }
    });
    await supabaseRequest("/auth/v1/admin/invite", {
      method: "POST", service: true,
      body: {
        email: String(body.email).trim().toLowerCase(),
        data: { freshroute_invitation_id: invitationId, freshroute_invitation_token: rawToken }
      }
    });
    sendJson(response, 200, { invitationId, emailSent: true });
  } catch (error) {
    handlerErrors(response, error);
  }
};
