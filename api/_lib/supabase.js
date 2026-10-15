"use strict";

function getSupabaseUrl() {
  return String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
}

function getPublicKey() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
}

function getBearer(request) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  return /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, "") : "";
}

function requireBearer(request) {
  const token = getBearer(request);
  if (!token) {
    const error = new Error("A signed-in session is required.");
    error.statusCode = 401;
    throw error;
  }
  return token;
}

async function supabaseRequest(path, { method = "GET", body, token, service = false } = {}) {
  const url = getSupabaseUrl();
  const key = service ? process.env.SUPABASE_SERVICE_ROLE_KEY : getPublicKey();
  if (!url || !key) {
    const error = new Error("Supabase is not configured for this environment.");
    error.statusCode = 503;
    throw error;
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${token || key}`,
    "Content-Type": "application/json"
  };
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error_description || "Supabase request failed.");
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    error.detail = data;
    throw error;
  }
  return data;
}

async function readJson(request) {
  if (request.body && typeof request.body === "object") return request.body;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function handlerErrors(response, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  sendJson(response, status, { error: error?.message || "Request failed." });
}

module.exports = {
  getSupabaseUrl,
  getPublicKey,
  getBearer,
  requireBearer,
  supabaseRequest,
  readJson,
  sendJson,
  handlerErrors
};
