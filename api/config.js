"use strict";

const { getSupabaseUrl, getPublicKey, sendJson } = require("./_lib/supabase.js");

module.exports = function config(_request, response) {
  const url = getSupabaseUrl();
  const publicKey = getPublicKey();
  if (!url || !publicKey) {
    sendJson(response, 404, { commercialConfigured: false });
    return;
  }
  sendJson(response, 200, {
    commercialConfigured: true,
    supabaseUrl: url,
    supabasePublicKey: publicKey
  });
};
