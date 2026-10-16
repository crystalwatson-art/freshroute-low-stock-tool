"use strict";

/*
 * Commercial mode is opt-in. The static classroom app never calls Supabase when
 * /api/config is absent, and it never shares its CSV or localStorage state with
 * this client.
 */
(function createCommercialClient() {
  let supabaseClient = null;
  let session = null;
  let activeBusinessId = null;
  let activeRole = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const api = {
    configured: false,
    ready,
    get session() { return session; },
    get activeBusinessId() { return activeBusinessId; },
    get activeRole() { return activeRole; },
    get isAuthenticated() { return Boolean(session?.access_token); },
    async signIn(email, password) {
      await ready;
      const result = await supabaseClient.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      return result.data;
    },
    async signUp(email, password, displayName) {
      await ready;
      const result = await supabaseClient.auth.signUp({
        email, password, options: { data: { display_name: displayName } }
      });
      if (result.error) throw result.error;
      return result.data;
    },
    async sendRecovery(email) {
      await ready;
      const result = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname + "#settings"
      });
      if (result.error) throw result.error;
    },
    async signOut() {
      await ready;
      const result = await supabaseClient.auth.signOut();
      if (result.error) throw result.error;
    },
    async saveReceiving(record) {
      const result = await request("/api/receiving", {
        method: "POST",
        body: {
          businessId: activeBusinessId,
          idempotencyKey: `receiving-${record.id}`,
          delivery: {
            supplier: record.supplier,
            delivered_on: record.deliveryDate,
            inspection_notes: record.notes || ""
          },
          items: record.items.map((item) => ({
            sku: item.sku,
            product_name: item.productName,
            brand: item.brand,
            total_boxes: item.totalBoxes,
            total_units: item.totalUnits,
            units_per_box: item.unitsPerBox,
            damaged_boxes: item.damagedBoxes,
            damaged_units: item.damagedUnits,
            lot_code: item.lotCode || null,
            expiration_date: item.expirationDate || null
          }))
        }
      });
      return result.result;
    },
    async loadReceivingRecords() {
      const result = await request(`/api/receiving?businessId=${encodeURIComponent(activeBusinessId)}`);
      return result.records || [];
    },
    async loadInventory() {
      const result = await request(`/api/inventory?businessId=${encodeURIComponent(activeBusinessId)}`);
      return result.inventory || [];
    },
    async reviewNewProduct({ reviewId, decision, reason, idempotencyKey }) {
      return request("/api/reconciliation/new-product", {
        method: "POST", body: { reviewId, decision, reason, idempotencyKey }
      });
    },
    async decideDelivery({ deliveryId, decision, reason, idempotencyKey }) {
      return request("/api/reconciliation/delivery", {
        method: "POST", body: { deliveryId, decision, reason, idempotencyKey }
      });
    },
    async updateExpirationWarning({ productId, warningDays }) {
      return request(`/api/inventory?businessId=${encodeURIComponent(activeBusinessId)}`, {
        method: "PATCH", body: { productId, warningDays }
      });
    },
    async invite({ businessId, email, role }) {
      return request("/api/business/invite", {
        method: "POST", body: { businessId, email, role }
      });
    },
    async acceptInvitation({ invitationId, invitationToken, email, displayName }) {
      return request("/api/business/accept-invite", {
        method: "POST", body: { invitationId, invitationToken, email, displayName }
      });
    }
  };

  async function request(path, options = {}) {
    await ready;
    if (!session?.access_token) throw new Error("Sign in to use commercial workspaces.");
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The commercial request could not be completed.");
    return body;
  }

  function dispatch(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The authentication client could not load."));
      document.head.appendChild(script);
    });
  }

  async function initialize() {
    try {
      const configResponse = await fetch("/api/config", { cache: "no-store" });
      if (!configResponse.ok) {
        resolveReady();
        dispatch("freshroute:commercial-ready", { configured: false });
        return;
      }
      const config = await configResponse.json();
      if (!config.commercialConfigured) {
        resolveReady();
        dispatch("freshroute:commercial-ready", { configured: false });
        return;
      }
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js");
      if (!window.supabase?.createClient) throw new Error("Supabase authentication is unavailable.");
      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublicKey);
      api.configured = true;
      const current = await supabaseClient.auth.getSession();
      session = current.data.session;
      await refreshProfile();
      supabaseClient.auth.onAuthStateChange(async (_event, nextSession) => {
        session = nextSession;
        await refreshProfile();
        dispatch("freshroute:commercial-session", { authenticated: Boolean(session) });
      });
      resolveReady();
      dispatch("freshroute:commercial-ready", { configured: true, authenticated: Boolean(session) });
      dispatch("freshroute:commercial-session", { authenticated: Boolean(session) });
    } catch (error) {
      console.warn("Commercial mode is unavailable; retaining classroom demo mode.", error.message);
      resolveReady();
      dispatch("freshroute:commercial-ready", { configured: false, error: error.message });
    }
  }

  async function refreshProfile() {
    if (!session?.access_token) {
      activeBusinessId = null;
      return;
    }
    const response = await fetch("/api/session/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        email: session.user?.email,
        displayName: session.user?.user_metadata?.display_name || session.user?.email
      })
    });
    if (!response.ok) throw new Error("The signed-in profile could not be loaded.");
    const profile = await response.json();
    const membership = profile.memberships?.[0] || null;
    activeBusinessId = membership?.business_id || null;
    activeRole = membership?.role || null;
  }

  window.FreshRouteCommercial = api;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
