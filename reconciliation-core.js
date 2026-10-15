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
      ["approval", "rejection", "new_product_review"].includes(entry?.type) &&
      entry.deliveryRecordId === deliveryRecordId
    ) || null;
  }

  function newProductItemKey(item = {}) {
    return `${cleanText(item.sku).toLowerCase()}|${cleanText(item.brand).toLowerCase()}`;
  }

  function groupReceivingItems(record, inventory) {
    const errors = [];
    const grouped = new Map();
    const unknownItems = [];

    (record.items || []).forEach((receivedItem) => {
      const sku = cleanText(receivedItem.sku).toLowerCase();
      const brand = cleanText(receivedItem.brand).toLowerCase();
      const matches = inventory.filter((item) =>
        cleanText(item.productId).toLowerCase() === sku &&
        (!brand || cleanText(item.brand).toLowerCase() === brand)
      );

      if (matches.length === 0) {
        if (unknownItems.some((item) => newProductItemKey(item) === newProductItemKey(receivedItem))) {
          errors.push(`SKU ${receivedItem.sku} appears more than once and needs one product identity.`);
          return;
        }
        unknownItems.push({
          ...receivedItem,
          sourceItemKey: newProductItemKey(receivedItem)
        });
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
      })),
      unknownItems
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
      : { errors: ["The receiving record has no valid line items."], changes: [], unknownItems: [] };
    errors.push(...grouped.errors);
    grouped.unknownItems.forEach((item) => {
      errors.push(`SKU ${item.sku} requires New Product Review before inventory can be posted.`);
    });
    if (grouped.changes.length === 0 && grouped.errors.length === 0) {
      errors.push("The receiving record has no line items to approve.");
    }

    return {
      valid: errors.length === 0,
      errors,
      changes: grouped.changes,
      unknownItems: grouped.unknownItems
    };
  }

  function parseNonNegativeNumber(value, label) {
    const text = cleanText(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) {
      return { value: null, error: `${label} must be a non-negative number.` };
    }
    const number = Number(text);
    if (!Number.isFinite(number)) return { value: null, error: `${label} is too large.` };
    return { value: number, error: null };
  }

  function createNewProductDecision({
    id,
    record,
    item,
    inventory = [],
    sourceKey,
    decision,
    fields = {},
    actedBy,
    actedAt = new Date().toISOString()
  } = {}) {
    const errors = [];
    const action = cleanText(decision).toLowerCase();
    const supervisor = cleanText(actedBy);
    const sku = cleanText(fields.sku || item?.sku);
    const productName = cleanText(fields.productName || item?.productName);
    const brand = cleanText(fields.brand || item?.brand);
    const supplier = cleanText(fields.supplier || record?.supplier);
    const measurementUnit = cleanText(fields.measurementUnit || "each");
    const accepted = parseNonNegativeNumber(fields.acceptedQuantity ?? item?.usableUnits, "Accepted usable quantity");
    const received = parseNonNegativeNumber(fields.receivedQuantity ?? item?.totalUnits, "Received quantity");
    const damaged = parseNonNegativeNumber(fields.damagedQuantity ?? item?.totalDamagedUnits, "Damaged quantity");
    const lowStock = parseNonNegativeNumber(fields.lowStockThreshold ?? 0, "Low-stock threshold");
    const reorder = parseNonNegativeNumber(fields.reorderThreshold ?? 0, "Reorder threshold");
    const reason = cleanText(fields.reason);

    if (!record?.id) errors.push("A saved receiving record is required.");
    if (!cleanText(sourceKey)) errors.push("An inventory source is required.");
    if (record && record.sourceKey !== sourceKey) errors.push("This delivery belongs to a different inventory source.");
    if (!item) errors.push("An unfamiliar delivery item is required.");
    if (!sku) errors.push("SKU is required.");
    if (!productName) errors.push("Product name is required.");
    if (!brand) errors.push("Brand is required.");
    if (!supplier) errors.push("Supplier is required.");
    if (!["each", "kg", "g", "L", "mL"].includes(measurementUnit)) {
      errors.push("Measurement unit must be a supported base unit.");
    }
    [received, damaged, accepted, lowStock, reorder].forEach((result) => {
      if (result.error) errors.push(result.error);
    });
    if (received.value !== null && damaged.value !== null && accepted.value !== null && damaged.value + accepted.value > received.value) {
      errors.push("Accepted quantity plus damaged quantity cannot exceed received quantity.");
    }
    if (measurementUnit === "each" && [received, damaged, accepted].some((result) => result.value !== null && !Number.isInteger(result.value))) {
      errors.push("Quantities measured in each must be whole numbers.");
    }
    if (lowStock.value !== null && reorder.value !== null && reorder.value < lowStock.value) {
      errors.push("Reorder threshold cannot be lower than the low-stock threshold.");
    }
    if (action === "approve" && accepted.value !== null && accepted.value <= 0) {
      errors.push("Accepted usable quantity must be greater than zero.");
    }
    if (!["approve", "reject", "request_correction"].includes(action)) {
      errors.push("Choose approve, reject, or request corrections.");
    }
    if (!supervisor) errors.push("Supervisor name is required in demonstration mode.");
    if (supervisor.length > 120) errors.push("Supervisor name must be 120 characters or fewer.");
    if (!reason) errors.push("A clear decision reason is required.");
    if (reason.length > 1000) errors.push("Decision reason must be 1,000 characters or fewer.");

    const duplicate = inventory.find((inventoryItem) =>
      cleanText(inventoryItem.productId).toLowerCase() === sku.toLowerCase() &&
      cleanText(inventoryItem.brand).toLowerCase() === brand.toLowerCase()
    );
    if (duplicate) errors.push("A product with this SKU and brand already exists.");

    if (errors.length > 0) return { valid: false, errors, entry: null };

    const reviewId = id || `new-product-review-${Date.now()}`;
    const requestKey = `${sourceKey}:new-product:${reviewId}`;
    const product = {
      requestKey,
      productId: sku,
      productName,
      brand,
      currentStock: action === "approve" ? accepted.value : 0,
      restockAt: lowStock.value,
      reorderQuantity: reorder.value,
      daysToExpiry: null,
      snapshotDate: record.deliveryDate || "Unknown date",
      measurementUnit
    };
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "correction_requested";

    return {
      valid: true,
      errors: [],
      entry: {
        id: reviewId,
        type: "new_product_review",
        decision: status,
        sourceKey,
        deliveryRecordId: record.id,
        sourceItemKey: newProductItemKey(item),
        actedBy: supervisor,
        actedAt,
        reason,
        changes: action === "approve" ? [{
          requestKey,
          productId: sku,
          productName,
          brand,
          receivedUnits: received.value,
          damagedUnits: damaged.value,
          usableUnits: accepted.value,
          beforeQuantity: 0,
          deltaUnits: accepted.value,
          afterQuantity: accepted.value,
          newProduct: product
        }] : [],
        review: {
          sku,
          productName,
          brand,
          supplier,
          measurementUnit,
          receivedQuantity: received.value,
          damagedQuantity: damaged.value,
          acceptedQuantity: accepted.value,
          lowStockThreshold: lowStock.value,
          reorderThreshold: reorder.value
        }
      }
    };
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
    const additions = new Map();
    const appliedDeliveryIds = new Set();
    const appliedNewProductReviewIds = new Set();
    const appliedEntryIds = new Set();
    ledger.forEach((entry) => {
      if (entry?.sourceKey !== sourceKey || !["approval", "correction", "new_product_review"].includes(entry.type)) return;
      if (appliedEntryIds.has(entry.id)) return;
      appliedEntryIds.add(entry.id);
      if (entry.type === "new_product_review") {
        if (entry.decision !== "approved" || appliedNewProductReviewIds.has(entry.id)) return;
        appliedNewProductReviewIds.add(entry.id);
        entry.changes?.forEach((change) => {
          if (change.newProduct) additions.set(change.requestKey, change.newProduct);
        });
        return;
      }
      if (entry.type === "approval") {
        if (appliedDeliveryIds.has(entry.deliveryRecordId)) return;
        appliedDeliveryIds.add(entry.deliveryRecordId);
      }
      (entry.changes || []).forEach((change) => {
        if (!Number.isSafeInteger(change.deltaUnits)) return;
        deltas.set(change.requestKey, (deltas.get(change.requestKey) || 0) + change.deltaUnits);
      });
    });

    const updated = inventory.map((item) => ({
      ...item,
      currentStock: Number.isFinite(item.currentStock)
        ? item.currentStock + (deltas.get(item.requestKey) || 0)
        : item.currentStock
    }));
    additions.forEach((item, requestKey) => {
      if (!updated.some((existing) => existing.requestKey === requestKey)) updated.push(item);
    });
    return updated;
  }

  return {
    parseSignedInteger,
    getDeliveryDecision,
    prepareApproval,
    createApproval,
    createRejection,
    createCorrection,
    createNewProductDecision,
    applyLedgerToInventory
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteReconciliation;
}

if (typeof window !== "undefined") {
  window.FreshRouteReconciliation = FreshRouteReconciliation;
}
