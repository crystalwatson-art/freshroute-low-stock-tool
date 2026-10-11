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
      document.getElementById("saved-receiving-count").textContent =
        `${records.length.toLocaleString()} saved locally`;

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
        ${renderDecisionControls(record, decision, prepared)}
      `;
    }

    function renderDecisionControls(record, decision, prepared) {
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
            <div class="receiving-field">
              <label for="decision-supervisor">Supervisor name <span aria-hidden="true">*</span></label>
              <input id="decision-supervisor" name="supervisor" type="text" maxlength="120" autocomplete="name" required>
            </div>
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
      }
    }

    function handleDecision(event, record) {
      const decisionType = event.submitter?.dataset.decision;
      const supervisor = event.target.elements.supervisor.value;
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
          ["approval", "rejection", "correction"].includes(entry.type) &&
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
