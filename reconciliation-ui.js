"use strict";

const FreshRouteReconciliationUI = (() => {
  const STORAGE_KEY = "freshroute-reconciliation-ledger";
  const MAX_ENTRIES = 100;

  function createController(options) {
    const {
      getRecords,
      getInventory,
      getSourceKey,
      getSourceLabel,
      getStorageStatus = () => ({
        countSuffix: "saved locally",
        description: "Records stay only in this browser. They are not sent to suppliers or a server."
      }),
      setRecords = () => {},
      onInventoryChanged
    } = options;
    const list = document.getElementById("saved-receiving-list");
    const review = document.getElementById("reconciliation-review");
    const content = document.getElementById("reconciliation-content");
    const feedback = document.getElementById("reconciliation-feedback");
    let ledger = loadLedger();
    let selectedRecordId = null;

    list.addEventListener("click", handleListClick);
    content.addEventListener("submit", handleSubmit);
    content.addEventListener("input", updateCorrectionPreview);
    document.getElementById("close-reconciliation").addEventListener("click", closeReview);

    function applyToInventory(baseInventory) {
      return FreshRouteReconciliation.applyLedgerToInventory(
        baseInventory,
        ledger,
        getSourceKey()
      );
    }

    function render() {
      const records = getRecords();
      const storageStatus = getStorageStatus();
      document.getElementById("saved-receiving-count").textContent =
        `${records.length.toLocaleString()} ${storageStatus.countSuffix}`;
      const storageDescription = document.getElementById("saved-receiving-description");
      if (storageDescription) storageDescription.textContent = storageStatus.description;

      if (records.length === 0) {
        list.innerHTML = '<li class="saved-receiving-empty">No receiving records saved yet.</li>';
        closeReview();
        return;
      }

      list.innerHTML = records.slice(0, 25).map((record) => {
        const decision = FreshRouteReconciliation.getDeliveryDecision(ledger, record.id);
        const sourceMatches = record.sourceKey === getSourceKey();
        const decisionLabel = decision?.type === "approval"
          ? "Approved locally"
          : decision?.type === "rejection"
            ? "Rejected"
            : decision?.type === "new_product_review"
              ? decision.decision === "approved"
                ? "New product approved · demo"
                : decision.decision === "rejected"
                  ? "New product rejected"
                  : "Corrections requested"
            : sourceMatches ? "Awaiting review" : "Different inventory source";
        return `
          <li class="saved-record-card">
            <div>
              <strong>${escapeHTML(record.supplier)}</strong>
              <span>${escapeHTML(record.deliveryDate)} · ${record.totals.lineItems.toLocaleString()} line item${record.totals.lineItems === 1 ? "" : "s"}</span>
              <span>${escapeHTML(record.sourceLabel)}</span>
            </div>
            <div class="saved-record-action">
              <strong>${record.totals.usableUnits.toLocaleString()} usable units</strong>
              <span class="record-state ${decision?.type || "pending"}">${decisionLabel}</span>
              <button class="text-button" type="button" data-review-record="${escapeHTML(record.id)}">${decision ? "View decision" : "Review delivery"}</button>
            </div>
          </li>
        `;
      }).join("");

      if (selectedRecordId) renderReview();
    }

    function handleListClick(event) {
      const button = event.target.closest("[data-review-record]");
      if (!button) return;
      selectedRecordId = button.dataset.reviewRecord;
      feedback.hidden = true;
      window.FreshRouteNavigation?.goTo("reconciliation");
      renderReview();
      review.hidden = false;
      review.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      review.focus({ preventScroll: true });
    }

    function closeReview() {
      const closingRecordId = selectedRecordId;
      selectedRecordId = null;
      review.hidden = true;
      content.replaceChildren();
      feedback.hidden = true;
      const returnButton = [...list.querySelectorAll("[data-review-record]")]
        .find((button) => button.dataset.reviewRecord === closingRecordId);
      returnButton?.focus();
    }

    function renderReview() {
      const record = getRecords().find((item) => item.id === selectedRecordId);
      if (!record) {
        closeReview();
        return;
      }

      const decision = FreshRouteReconciliation.getDeliveryDecision(ledger, record.id);
      const prepared = decision?.type === "approval"
        ? { valid: true, errors: [], changes: decision.changes }
        : FreshRouteReconciliation.prepareApproval({
          record,
          inventory: getInventory(),
          sourceKey: getSourceKey(),
          ledger
        });
      const changes = decision?.type === "rejection" ? [] : prepared.changes;
      const rows = changes.length > 0
        ? changes.map((change) => `
          <tr>
            <td><strong>${escapeHTML(change.productName)}</strong><small>SKU ${escapeHTML(change.productId)} · ${escapeHTML(change.brand || "")}</small></td>
            <td>${formatQuantity(change.receivedUnits)}</td>
            <td>${formatQuantity(change.damagedUnits)}</td>
            <td>${formatQuantity(change.usableUnits)}</td>
            <td>${formatQuantity(change.beforeQuantity)}</td>
            <td><strong>${formatQuantity(change.afterQuantity)}</strong></td>
          </tr>
        `).join("")
        : '<tr class="empty-row"><td colspan="6">No inventory quantities will change.</td></tr>';
      const blockers = prepared.errors.length > 0 && !decision
        ? `<div class="approval-blockers" role="alert"><strong>Approval is blocked:</strong><ul>${prepared.errors.map((error) => `<li>${escapeHTML(error)}</li>`).join("")}</ul></div>`
        : "";
      const newProductForms = prepared.unknownItems?.length > 0 &&
        (!decision || decision.type !== "new_product_review" || decision.decision === "correction_requested")
        ? `<section class="new-product-review" aria-labelledby="new-product-review-title">
            <div class="saved-receiving-heading">
              <div>
                <p class="eyebrow">Supervisor path · ${window.FreshRouteCommercial?.configured ? "authenticated" : "demo only"}</p>
                <h4 id="new-product-review-title">New Product Review</h4>
              </div>
              <span class="mode-badge">Unfamiliar SKU</span>
            </div>
            <p>${window.FreshRouteCommercial?.configured
              ? "Verify every product field. The signed-in Supervisor or Administrator session is checked on the server."
              : "Verify the product identity, measurement, accepted quantity, and stock thresholds before posting it. The local demo cannot authenticate this approval."}</p>
            ${prepared.unknownItems.map((item, index) => renderNewProductReviewForm(record, item, index)).join("")}
          </section>`
        : "";

      content.innerHTML = `
        <div class="reconciliation-record-heading">
          <div><strong>${escapeHTML(record.supplier)}</strong><span>Delivery ${escapeHTML(record.deliveryDate)}</span></div>
          <span class="mode-badge ${record.sourceKey === getSourceKey() ? "customer-mode" : ""}">${escapeHTML(record.sourceLabel)}</span>
        </div>
        <div class="reconciliation-totals" aria-label="Delivery quantities">
          <span><small>Received units</small><strong>${record.totals.totalUnits.toLocaleString()}</strong></span>
          <span><small>Damaged units</small><strong>${record.totals.totalDamagedUnits.toLocaleString()}</strong></span>
          <span><small>Accepted usable units</small><strong>${record.totals.usableUnits.toLocaleString()}</strong></span>
        </div>
        <div class="table-wrapper reconciliation-table-wrapper">
          <table class="reconciliation-table">
            <caption>Inventory comparison for this delivery</caption>
            <thead><tr><th scope="col">Product</th><th scope="col">Received</th><th scope="col">Damaged</th><th scope="col">Usable</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${blockers}
        ${newProductForms}
        ${renderDecisionControls(record, decision, prepared)}
      `;
    }

    function renderDecisionControls(record, decision, prepared) {
      if (decision?.type === "new_product_review") {
        const reviewLabel = decision.decision === "approved"
          ? "New product approved in demonstration mode — accepted usable quantity was posted locally."
          : decision.decision === "rejected"
            ? "New product rejected in demonstration mode — no inventory was posted."
            : "Corrections requested for this new product review.";
        return `
          <div class="decision-summary ${decision.decision === "approved" ? "approved-decision" : decision.decision === "rejected" ? "rejected-decision" : "correction-decision"}">
            <strong>${reviewLabel}</strong>
            <span>Typed actor: ${escapeHTML(decision.actedBy)} · ${escapeHTML(formatTimestamp(decision.actedAt))}</span>
            <p>${escapeHTML(decision.reason)}</p>
          </div>
        `;
      }
      if (decision?.type === "rejection") {
        return `
          <div class="decision-summary rejected-decision">
            <strong>Delivery rejected — inventory unchanged</strong>
            <span>Recorded by ${escapeHTML(decision.rejectedBy)} on ${escapeHTML(formatTimestamp(decision.rejectedAt))}</span>
            <p>${escapeHTML(decision.reason)}</p>
          </div>
        `;
      }
      if (decision?.type === "approval") {
        const corrections = ledger.filter((entry) =>
          entry.type === "correction" && entry.parentApprovalId === decision.id
        );
        return `
          <div class="decision-summary approved-decision">
            <strong>Approved and applied locally</strong>
            <span>Approved by ${escapeHTML(decision.approvedBy)} on ${escapeHTML(formatTimestamp(decision.approvedAt))}</span>
            <p>${decision.changes.map((change) => `${escapeHTML(change.productId)}: ${formatQuantity(change.beforeQuantity)} → ${formatQuantity(change.afterQuantity)} (+${formatQuantity(change.deltaUnits)})`).join(" · ")}</p>
          </div>
          ${renderCorrectionHistory(corrections)}
          ${decision.sourceKey === getSourceKey()
            ? renderCorrectionForm(decision)
            : `<p class="approval-blockers">Load ${escapeHTML(record.sourceLabel)} to add a correction.</p>`}
        `;
      }

      return `
        <form id="supervisor-decision-form" class="supervisor-decision-form" novalidate>
          <h4>Supervisor decision</h4>
          <div class="decision-fields">
            ${window.FreshRouteCommercial?.configured
              ? `<p class="authenticated-actor-note">Decision actor: authenticated business session. A typed name is not used for authorization.</p>`
              : `<div class="receiving-field"><label for="decision-supervisor">Supervisor name <span aria-hidden="true">*</span></label><input id="decision-supervisor" name="supervisor" type="text" maxlength="120" autocomplete="name" required></div>`}
            <div class="receiving-field">
              <label for="decision-reason">Reason (required for rejection)</label>
              <textarea id="decision-reason" name="reason" rows="2" maxlength="500"></textarea>
            </div>
          </div>
          <label class="approval-confirmation">
            <input name="confirmation" type="checkbox">
            I reviewed the quantities and approve adding only the accepted usable units shown above.
          </label>
          <div class="decision-actions">
            <button class="secondary-button" type="submit" data-decision="reject">Reject delivery</button>
            <button class="primary-button" type="submit" data-decision="approve" ${prepared.valid ? "" : "disabled"}>Approve and apply locally</button>
          </div>
        </form>
      `;
    }

    function renderNewProductReviewForm(record, item, index) {
      const formId = `new-product-review-form-${index}`;
      const sourceKey = `${String(item.sku || "").trim().toLowerCase()}|${String(item.brand || "").trim().toLowerCase()}`;
      return `
        <form id="${formId}" class="new-product-review-form" data-new-product-review data-source-item-key="${escapeHTML(sourceKey)}" novalidate>
          <h5>${escapeHTML(item.productName || item.sku)} · unfamiliar SKU</h5>
          <div class="new-product-review-fields">
            <div class="receiving-field"><label for="${formId}-sku">SKU</label><input id="${formId}-sku" name="sku" value="${escapeHTML(item.sku)}" maxlength="80" required></div>
            <div class="receiving-field"><label for="${formId}-name">Product name</label><input id="${formId}-name" name="productName" value="${escapeHTML(item.productName)}" maxlength="160" required></div>
            <div class="receiving-field"><label for="${formId}-brand">Brand</label><input id="${formId}-brand" name="brand" value="${escapeHTML(item.brand)}" maxlength="120" required></div>
            <div class="receiving-field"><label for="${formId}-supplier">Supplier</label><input id="${formId}-supplier" name="supplier" value="${escapeHTML(record.supplier)}" readonly></div>
            <div class="receiving-field"><label for="${formId}-unit">Measurement unit</label><select id="${formId}-unit" name="measurementUnit"><option value="each">each</option><option value="kg">kg</option><option value="g">g</option><option value="L">L</option><option value="mL">mL</option></select></div>
            <div class="receiving-field"><label for="${formId}-received">Received quantity</label><input id="${formId}-received" name="receivedQuantity" type="number" min="0" step="any" value="${item.totalUnits}" readonly></div>
            <div class="receiving-field"><label for="${formId}-damaged">Damaged quantity</label><input id="${formId}-damaged" name="damagedQuantity" type="number" min="0" step="any" value="${item.totalDamagedUnits}" readonly></div>
            <div class="receiving-field"><label for="${formId}-accepted">Accepted usable quantity</label><input id="${formId}-accepted" name="acceptedQuantity" type="number" min="0" step="any" value="${item.usableUnits}" required></div>
            <div class="receiving-field"><label for="${formId}-low">Low-stock threshold</label><input id="${formId}-low" name="lowStockThreshold" type="number" min="0" step="any" value="0" required></div>
            <div class="receiving-field"><label for="${formId}-reorder">Reorder threshold</label><input id="${formId}-reorder" name="reorderThreshold" type="number" min="0" step="any" value="0" required></div>
            <div class="receiving-field new-product-review-reason"><label for="${formId}-reason">Decision reason</label><textarea id="${formId}-reason" name="reason" maxlength="1000" required placeholder="Explain what was verified or what must be corrected"></textarea></div>
            ${window.FreshRouteCommercial?.configured
              ? `<p class="authenticated-actor-note">Decision actor: authenticated business session. A typed name is not used for authorization.</p>`
              : `<div class="receiving-field"><label for="${formId}-actor">Supervisor name <span aria-hidden="true">*</span></label><input id="${formId}-actor" name="actedBy" maxlength="120" required placeholder="Demo only — not authentication"></div>`}
          </div>
          <div class="decision-actions">
            <button class="secondary-button" type="submit" data-new-product-decision="reject">Reject product</button>
            <button class="secondary-button" type="submit" data-new-product-decision="request_correction">Request corrections</button>
            <button class="primary-button" type="submit" data-new-product-decision="approve">Approve and post accepted quantity</button>
          </div>
        </form>
      `;
    }

    function renderCorrectionHistory(corrections) {
      if (corrections.length === 0) {
        return '<p class="correction-empty">No corrections recorded for this approval.</p>';
      }
      return `
        <div class="correction-history">
          <h4>Traceable corrections</h4>
          <ul>${corrections.map((entry) => {
            const change = entry.changes[0];
            const sign = change.deltaUnits > 0 ? "+" : "";
            return `<li><strong>${escapeHTML(change.productId)}: ${formatQuantity(change.beforeQuantity)} → ${formatQuantity(change.afterQuantity)} (${sign}${formatQuantity(change.deltaUnits)})</strong><span>${escapeHTML(entry.reason)} · ${escapeHTML(entry.correctedBy)} · ${escapeHTML(formatTimestamp(entry.correctedAt))}</span></li>`;
          }).join("")}</ul>
        </div>
      `;
    }

    function renderCorrectionForm(approval) {
      return `
        <form id="inventory-correction-form" class="inventory-correction-form" novalidate>
          <h4>Add a separate correction</h4>
          <p>The original approval stays unchanged. Use a negative number to remove units or a positive number to add units.</p>
          <div class="correction-fields">
            <div class="receiving-field">
              <label for="correction-product">Product <span aria-hidden="true">*</span></label>
              <select id="correction-product" name="requestKey" required>${approval.changes.map((change) => `<option value="${escapeHTML(change.requestKey)}">${escapeHTML(change.productName)} · SKU ${escapeHTML(change.productId)}</option>`).join("")}</select>
            </div>
            <div class="receiving-field">
              <label for="correction-quantity">Quantity change <span aria-hidden="true">*</span></label>
              <input id="correction-quantity" name="deltaUnits" type="number" step="1" inputmode="numeric" required>
            </div>
            <div class="receiving-field">
              <label for="correction-supervisor">Supervisor name <span aria-hidden="true">*</span></label>
              <input id="correction-supervisor" name="correctedBy" type="text" maxlength="120" autocomplete="name" required>
            </div>
            <div class="receiving-field correction-reason-field">
              <label for="correction-reason">Correction reason <span aria-hidden="true">*</span></label>
              <input id="correction-reason" name="reason" type="text" maxlength="500" required>
            </div>
          </div>
          <p id="correction-preview" class="correction-preview" aria-live="polite">Enter a correction quantity to preview the change.</p>
          <label class="approval-confirmation"><input name="confirmation" type="checkbox"> Record this as a separate local adjustment.</label>
          <button class="secondary-button" type="submit" data-approval-id="${escapeHTML(approval.id)}">Save correction locally</button>
        </form>
      `;
    }

    function handleSubmit(event) {
      event.preventDefault();
      const record = getRecords().find((item) => item.id === selectedRecordId);
      if (!record) return;

      if (event.target.id === "supervisor-decision-form") {
        handleDecision(event, record);
      } else if (event.target.id === "inventory-correction-form") {
        handleCorrection(event);
      } else if (event.target.matches("[data-new-product-review]")) {
        handleNewProductDecision(event, record);
      }
    }

    async function handleNewProductDecision(event, record) {
      const form = event.target;
      const submitter = event.submitter;
      const item = (record.items || []).find((candidate) => {
        const key = `${String(candidate.sku || "").trim().toLowerCase()}|${String(candidate.brand || "").trim().toLowerCase()}`;
        return key === form.dataset.sourceItemKey;
      });
      const fields = Object.fromEntries(new FormData(form).entries());
      const commercial = window.FreshRouteCommercial;
      if (commercial?.configured) {
        if (!commercial.isAuthenticated || !commercial.activeBusinessId) {
          showFeedback("Sign in with an active business membership before reviewing a new product.", "error");
          return;
        }
        if (!item?.newProductReviewId) {
          showFeedback("This commercial record is missing its server review ID. Reload the records and try again.", "error");
          return;
        }
        const secureResult = FreshRouteReconciliation.createNewProductDecision({
          id: item.newProductReviewId,
          record,
          item,
          inventory: getInventory(),
          sourceKey: getSourceKey(),
          decision: submitter?.dataset.newProductDecision,
          actedBy: "authenticated-session",
          fields
        });
        if (!secureResult.valid) {
          showFeedback("This new-product review needs attention.", "error", secureResult.errors);
          return;
        }
        try {
          await commercial.reviewNewProduct({
            reviewId: item.newProductReviewId,
            decision: submitter?.dataset.newProductDecision,
            reason: fields.reason,
            idempotencyKey: `new-product:${item.newProductReviewId}:${submitter?.dataset.newProductDecision}`
          });
          const refreshed = await commercial.loadReceivingRecords();
          setRecords(refreshed);
          render();
          showFeedback("The authenticated server recorded the new-product decision.", "success");
        } catch (error) {
          showFeedback(`The server could not record this decision: ${error.message}`, "error");
        }
        return;
      }
      const result = FreshRouteReconciliation.createNewProductDecision({
        id: createId("new-product-review"),
        record,
        item,
        inventory: getInventory(),
        sourceKey: getSourceKey(),
        decision: submitter?.dataset.newProductDecision,
        actedBy: fields.actedBy,
        fields
      });
      if (!result.valid) {
        showFeedback("This new-product review needs attention.", "error", result.errors);
        return;
      }
      if (!persistEntry(result.entry)) return;
      if (result.entry.decision === "approved") onInventoryChanged();
      render();
      showFeedback(
        result.entry.decision === "approved"
          ? "New product approved in demonstration mode; accepted quantity was posted locally."
          : result.entry.decision === "rejected"
            ? "New product rejected in demonstration mode; no inventory was posted."
            : "Corrections requested; the delivery remains saved for follow-up.",
        result.entry.decision === "approved" ? "success" : "status"
      );
    }

    async function handleDecision(event, record) {
      const decisionType = event.submitter?.dataset.decision;
      const supervisor = event.target.elements.supervisor?.value || "authenticated-session";
      const commercial = window.FreshRouteCommercial;
      if (commercial?.configured) {
        if (!commercial.isAuthenticated || !commercial.activeBusinessId) {
          showFeedback("Sign in with an active business membership before reconciling a delivery.", "error");
          return;
        }
        if (decisionType === "approve" && !event.target.elements.confirmation.checked) {
          showFeedback("Confirm that you reviewed the quantities before approval.", "error");
          return;
        }
        const reason = event.target.elements.reason.value.trim();
        if (!reason) {
          showFeedback("A decision reason is required.", "error");
          return;
        }
        try {
          await commercial.decideDelivery({
            deliveryId: record.id,
            decision: decisionType,
            reason,
            idempotencyKey: `delivery:${record.id}:${decisionType}`
          });
          const refreshed = await commercial.loadReceivingRecords();
          setRecords(refreshed);
          render();
          showFeedback("The authenticated server recorded the delivery decision.", "success");
        } catch (error) {
          showFeedback(`The server could not record this decision: ${error.message}`, "error");
        }
        return;
      }
      if (decisionType === "approve") {
        if (!event.target.elements.confirmation.checked) {
          showFeedback("Confirm that you reviewed the quantities before approval.", "error");
          return;
        }
        const result = FreshRouteReconciliation.createApproval({
          id: createId("approval"),
          record,
          inventory: getInventory(),
          sourceKey: getSourceKey(),
          ledger,
          approvedBy: supervisor
        });
        if (!result.valid) {
          showFeedback("This delivery could not be approved.", "error", result.errors);
          return;
        }
        if (!persistEntry(result.entry)) return;
        onInventoryChanged();
        render();
        showFeedback("Delivery approved locally. Accepted usable units were added once.", "success");
        return;
      }

      const result = FreshRouteReconciliation.createRejection({
        id: createId("rejection"),
        record,
        sourceKey: getSourceKey(),
        ledger,
        rejectedBy: supervisor,
        reason: event.target.elements.reason.value
      });
      if (!result.valid) {
        showFeedback("This rejection could not be recorded.", "error", result.errors);
        return;
      }
      if (!persistEntry(result.entry)) return;
      render();
      showFeedback("Delivery rejected locally. Inventory was not changed.", "success");
    }

    function handleCorrection(event) {
      if (!event.target.elements.confirmation.checked) {
        showFeedback("Confirm that this should be a separate local adjustment.", "error");
        return;
      }
      const approval = ledger.find((entry) => entry.id === event.submitter?.dataset.approvalId);
      const result = FreshRouteReconciliation.createCorrection({
        id: createId("correction"),
        approval,
        inventory: getInventory(),
        sourceKey: getSourceKey(),
        requestKey: event.target.elements.requestKey.value,
        deltaUnits: event.target.elements.deltaUnits.value,
        reason: event.target.elements.reason.value,
        correctedBy: event.target.elements.correctedBy.value
      });
      if (!result.valid) {
        showFeedback("This correction could not be recorded.", "error", result.errors);
        return;
      }
      if (!persistEntry(result.entry)) return;
      onInventoryChanged();
      render();
      showFeedback("Correction saved as a separate local inventory adjustment.", "success");
    }

    function updateCorrectionPreview(event) {
      const form = event.target.closest("#inventory-correction-form");
      if (!form) return;
      const item = getInventory().find((inventoryItem) =>
        inventoryItem.requestKey === form.elements.requestKey.value
      );
      const value = String(form.elements.deltaUnits.value).trim();
      const preview = document.getElementById("correction-preview");
      if (!item || !/^-?\d+$/.test(value)) {
        preview.textContent = "Enter a correction quantity to preview the change.";
        return;
      }
      preview.textContent =
        `Inventory would change from ${formatQuantity(item.currentStock)} to ${formatQuantity(item.currentStock + Number(value))}.`;
    }

    function persistEntry(entry) {
      const nextLedger = [entry, ...ledger].slice(0, MAX_ENTRIES);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextLedger));
        ledger = nextLedger;
        return true;
      } catch (error) {
        console.warn("Reconciliation history could not be saved.", error);
        showFeedback("The decision could not be saved in this browser. Inventory was not changed.", "error");
        return false;
      }
    }

    function showFeedback(message, type, details = []) {
      feedback.replaceChildren();
      feedback.className = `upload-feedback ${type === "error" ? "error-message" : "success-message"}`;
      feedback.setAttribute("role", type === "error" ? "alert" : "status");
      const summary = document.createElement("strong");
      summary.textContent = message;
      feedback.appendChild(summary);
      if (details.length > 0) {
        const errorList = document.createElement("ul");
        details.forEach((detail) => {
          const item = document.createElement("li");
          item.textContent = detail;
          errorList.appendChild(item);
        });
        feedback.appendChild(errorList);
      }
      feedback.hidden = false;
    }

    function loadLedger() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        if (!Array.isArray(saved)) return [];
        return saved.filter((entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.sourceKey === "string" &&
          typeof entry.deliveryRecordId === "string" &&
          ["approval", "rejection", "correction", "new_product_review"].includes(entry.type) &&
          Array.isArray(entry.changes)
        ).slice(0, MAX_ENTRIES);
      } catch (error) {
        console.warn("Saved reconciliation history could not be read.", error);
        return [];
      }
    }

    return { applyToInventory, render, closeReview };
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatQuantity(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "Needs review";
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
  }

  function createId(prefix) {
    return typeof crypto.randomUUID === "function"
      ? `${prefix}-${crypto.randomUUID()}`
      : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  return { createController };
})();

if (typeof window !== "undefined") {
  window.FreshRouteReconciliationUI = FreshRouteReconciliationUI;
}
