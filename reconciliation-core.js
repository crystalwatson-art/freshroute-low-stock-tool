"use strict";

const FreshRouteReconciliation = (() => {
  function cleanText(value) {
    return String(value ?? "").trim();
  }

  function parseSignedInteger(value, label = "Adjustment") {
    const text = cleanText(value);
    if (!/^-?\d+$/.test(text)) {
      return { value: null, error: `${label} must be a whole number.` };
    }
    const number = Number(text);
    if (!Number.isSafeInteger(number)) {
      return { value: null, error: `${label} is too large.` };
    }
    return { value: number, error: null };
  }

  function getDeliveryDecision(ledger = [], deliveryRecordId) {
    return ledger.find((entry) =>
      ["approval", "rejection"].includes(entry?.type) &&
      entry.deliveryRecordId === deliveryRecordId
    ) || null;
  }

  function groupReceivingItems(record, inventory) {
    const errors = [];
    const grouped = new Map();

    (record.items || []).forEach((receivedItem) => {
      const sku = cleanText(receivedItem.sku).toLowerCase();
      const brand = cleanText(receivedItem.brand).toLowerCase();
      const matches = inventory.filter((item) =>
        cleanText(item.productId).toLowerCase() === sku &&
        (!brand || cleanText(item.brand).toLowerCase() === brand)
      );

      if (matches.length === 0) {
        errors.push(`SKU ${receivedItem.sku} was not found in the current inventory.`);
        return;
      }
      if (matches.length > 1) {
        errors.push(`SKU ${receivedItem.sku} matches more than one inventory item.`);
        return;
      }

      const inventoryItem = matches[0];
      const numericFields = ["totalUnits", "totalDamagedUnits", "usableUnits"];
      if (numericFields.some((field) => !Number.isSafeInteger(receivedItem[field]) || receivedItem[field] < 0)) {
        errors.push(`SKU ${receivedItem.sku} has invalid receiving quantities.`);
        return;
      }
      if (receivedItem.totalUnits - receivedItem.totalDamagedUnits !== receivedItem.usableUnits) {
        errors.push(`SKU ${receivedItem.sku} has inconsistent damaged and usable quantities.`);
        return;
      }
      if (!Number.isFinite(inventoryItem.currentStock) || inventoryItem.currentStock < 0) {
        errors.push(`SKU ${receivedItem.sku} does not have a valid current quantity.`);
        return;
      }

      const existing = grouped.get(inventoryItem.requestKey) || {
        requestKey: inventoryItem.requestKey,
        productId: inventoryItem.productId,
        productName: inventoryItem.productName,
        brand: inventoryItem.brand,
        receivedUnits: 0,
        damagedUnits: 0,
        usableUnits: 0,
        beforeQuantity: inventoryItem.currentStock
      };
      existing.receivedUnits += receivedItem.totalUnits;
      existing.damagedUnits += receivedItem.totalDamagedUnits;
      existing.usableUnits += receivedItem.usableUnits;
      grouped.set(inventoryItem.requestKey, existing);
    });

    return {
      errors,
      changes: [...grouped.values()].map((change) => ({
        ...change,
        deltaUnits: change.usableUnits,
        afterQuantity: change.beforeQuantity + change.usableUnits
      }))
    };
  }

  function prepareApproval({ record, inventory = [], sourceKey, ledger = [] } = {}) {
    const errors = [];
    if (!record || !record.id) errors.push("A saved receiving record is required.");
    if (!cleanText(sourceKey)) errors.push("An inventory source is required.");
    if (record && record.sourceKey !== sourceKey) {
      errors.push("This delivery belongs to a different inventory source.");
    }
    if (record && getDeliveryDecision(ledger, record.id)) {
      errors.push("This delivery already has a supervisor decision.");
    }

    const grouped = record && Array.isArray(record.items)
      ? groupReceivingItems(record, inventory)
      : { errors: ["The receiving record has no valid line items."], changes: [] };
    errors.push(...grouped.errors);
    if (grouped.changes.length === 0 && grouped.errors.length === 0) {
      errors.push("The receiving record has no line items to approve.");
    }

    return { valid: errors.length === 0, errors, changes: grouped.changes };
  }

  function createApproval({
    id,
    record,
    inventory,
    sourceKey,
    ledger = [],
    approvedBy,
    approvedAt = new Date().toISOString()
  } = {}) {
    const supervisor = cleanText(approvedBy);
    const prepared = prepareApproval({ record, inventory, sourceKey, ledger });
    const errors = [...prepared.errors];
    if (!supervisor) errors.push("Supervisor name is required.");
    if (supervisor.length > 120) errors.push("Supervisor name must be 120 characters or fewer.");
    if (errors.length > 0) return { valid: false, errors, entry: null };

    return {
      valid: true,
      errors: [],
      entry: {
        id: id || `approval-${Date.now()}`,
        type: "approval",
        sourceKey,
        deliveryRecordId: record.id,
        approvedBy: supervisor,
        approvedAt,
        changes: prepared.changes
      }
    };
  }

  function createRejection({
    id,
    record,
    sourceKey,
    ledger = [],
    rejectedBy,
    reason,
    rejectedAt = new Date().toISOString()
  } = {}) {
    const supervisor = cleanText(rejectedBy);
    const rejectionReason = cleanText(reason);
    const errors = [];
    if (!record || !record.id) errors.push("A saved receiving record is required.");
    if (record && record.sourceKey !== sourceKey) {
      errors.push("This delivery belongs to a different inventory source.");
    }
    if (record && getDeliveryDecision(ledger, record.id)) {
      errors.push("This delivery already has a supervisor decision.");
    }
    if (!supervisor) errors.push("Supervisor name is required.");
    if (supervisor.length > 120) errors.push("Supervisor name must be 120 characters or fewer.");
    if (!rejectionReason) errors.push("A rejection reason is required.");
    if (rejectionReason.length > 500) errors.push("Rejection reason must be 500 characters or fewer.");
    if (errors.length > 0) return { valid: false, errors, entry: null };

    return {
      valid: true,
      errors: [],
      entry: {
        id: id || `rejection-${Date.now()}`,
        type: "rejection",
        sourceKey,
        deliveryRecordId: record.id,
        rejectedBy: supervisor,
        rejectedAt,
        reason: rejectionReason,
        changes: []
      }
    };
  }

  function createCorrection({
    id,
    approval,
    inventory = [],
    sourceKey,
    requestKey,
    deltaUnits,
    reason,
    correctedBy,
    correctedAt = new Date().toISOString()
  } = {}) {
    const supervisor = cleanText(correctedBy);
    const correctionReason = cleanText(reason);
    const parsedDelta = parseSignedInteger(deltaUnits, "Correction quantity");
    const errors = [];

    if (!approval || approval.type !== "approval") {
      errors.push("An approved delivery is required for a correction.");
    } else if (approval.sourceKey !== sourceKey) {
      errors.push("This approval belongs to a different inventory source.");
    }
    if (!supervisor) errors.push("Supervisor name is required.");
    if (supervisor.length > 120) errors.push("Supervisor name must be 120 characters or fewer.");
    if (!correctionReason) errors.push("A correction reason is required.");
    if (correctionReason.length > 500) errors.push("Correction reason must be 500 characters or fewer.");
    if (parsedDelta.error) errors.push(parsedDelta.error);
    if (parsedDelta.value === 0) errors.push("Correction quantity cannot be zero.");

    const approvedChange = approval?.changes?.find((change) => change.requestKey === requestKey);
    if (!approvedChange) errors.push("Choose a product from the approved delivery.");
    const inventoryItem = inventory.find((item) => item.requestKey === requestKey);
    if (!inventoryItem) errors.push("The selected product is not in the current inventory.");
    if (inventoryItem && parsedDelta.value !== null && inventoryItem.currentStock + parsedDelta.value < 0) {
      errors.push("This correction would make inventory negative.");
    }
    if (errors.length > 0) return { valid: false, errors, entry: null };

    return {
      valid: true,
      errors: [],
      entry: {
        id: id || `correction-${Date.now()}`,
        type: "correction",
        sourceKey,
        deliveryRecordId: approval.deliveryRecordId,
        parentApprovalId: approval.id,
        correctedBy: supervisor,
        correctedAt,
        reason: correctionReason,
        changes: [{
          requestKey,
          productId: inventoryItem.productId,
          productName: inventoryItem.productName,
          brand: inventoryItem.brand,
          beforeQuantity: inventoryItem.currentStock,
          deltaUnits: parsedDelta.value,
          afterQuantity: inventoryItem.currentStock + parsedDelta.value
        }]
      }
    };
  }

  function applyLedgerToInventory(inventory = [], ledger = [], sourceKey) {
    const deltas = new Map();
    const appliedDeliveryIds = new Set();
    const appliedEntryIds = new Set();
    ledger.forEach((entry) => {
      if (entry?.sourceKey !== sourceKey || !["approval", "correction"].includes(entry.type)) return;
      if (appliedEntryIds.has(entry.id)) return;
      appliedEntryIds.add(entry.id);
      if (entry.type === "approval") {
        if (appliedDeliveryIds.has(entry.deliveryRecordId)) return;
        appliedDeliveryIds.add(entry.deliveryRecordId);
      }
      (entry.changes || []).forEach((change) => {
        if (!Number.isSafeInteger(change.deltaUnits)) return;
        deltas.set(change.requestKey, (deltas.get(change.requestKey) || 0) + change.deltaUnits);
      });
    });

    return inventory.map((item) => ({
      ...item,
      currentStock: Number.isFinite(item.currentStock)
        ? item.currentStock + (deltas.get(item.requestKey) || 0)
        : item.currentStock
    }));
  }

  return {
    parseSignedInteger,
    getDeliveryDecision,
    prepareApproval,
    createApproval,
    createRejection,
    createCorrection,
    applyLedgerToInventory
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteReconciliation;
}

if (typeof window !== "undefined") {
  window.FreshRouteReconciliation = FreshRouteReconciliation;
}
