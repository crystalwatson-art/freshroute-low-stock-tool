"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const reconciliation = require("../reconciliation-core.js");

const inventory = [{
  requestKey: "demo-milk",
  productId: "MILK-1",
  productName: "Whole Milk",
  brand: "Fresh Farm",
  currentStock: 20
}];

function delivery(overrides = {}) {
  return {
    id: "delivery-1",
    sourceKey: "demo",
    items: [{
      sku: "MILK-1",
      productName: "Whole Milk",
      brand: "Fresh Farm",
      totalUnits: 24,
      totalDamagedUnits: 8,
      usableUnits: 16
    }],
    ...overrides
  };
}

function approval(overrides = {}) {
  const result = reconciliation.createApproval({
    id: "approval-1",
    record: delivery(),
    inventory,
    sourceKey: "demo",
    ledger: [],
    approvedBy: "Jordan Lee",
    approvedAt: "2026-10-11T14:00:00.000Z",
    ...overrides
  });
  assert.equal(result.valid, true);
  return result.entry;
}

test("approval adds only accepted usable units and records before and after quantities", () => {
  const entry = approval();
  assert.deepEqual(entry.changes[0], {
    requestKey: "demo-milk",
    productId: "MILK-1",
    productName: "Whole Milk",
    brand: "Fresh Farm",
    receivedUnits: 24,
    damagedUnits: 8,
    usableUnits: 16,
    beforeQuantity: 20,
    deltaUnits: 16,
    afterQuantity: 36
  });
  const updated = reconciliation.applyLedgerToInventory(inventory, [entry], "demo");
  assert.equal(updated[0].currentStock, 36);
});

test("approval requires a supervisor name", () => {
  const result = reconciliation.createApproval({
    record: delivery(),
    inventory,
    sourceKey: "demo",
    ledger: [],
    approvedBy: ""
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /Supervisor name is required/);
});

test("a delivery cannot receive a second decision", () => {
  const existing = approval();
  const result = reconciliation.createApproval({
    record: delivery(),
    inventory,
    sourceKey: "demo",
    ledger: [existing],
    approvedBy: "Alex Kim"
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /already has a supervisor decision/);
});

test("rejected deliveries do not change inventory", () => {
  const result = reconciliation.createRejection({
    id: "rejection-1",
    record: delivery(),
    sourceKey: "demo",
    ledger: [],
    rejectedBy: "Jordan Lee",
    reason: "Seal was broken",
    rejectedAt: "2026-10-11T14:00:00.000Z"
  });
  assert.equal(result.valid, true);
  assert.equal(result.entry.changes.length, 0);
  assert.equal(
    reconciliation.applyLedgerToInventory(inventory, [result.entry], "demo")[0].currentStock,
    20
  );
});

test("rejection requires a traceable reason", () => {
  const result = reconciliation.createRejection({
    record: delivery(),
    sourceKey: "demo",
    ledger: [],
    rejectedBy: "Jordan Lee",
    reason: ""
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /rejection reason is required/i);
});

test("inconsistent damaged quantities block approval", () => {
  const record = delivery({
    items: [{
      sku: "MILK-1",
      totalUnits: 24,
      totalDamagedUnits: 8,
      usableUnits: 20
    }]
  });
  const result = reconciliation.prepareApproval({
    record,
    inventory,
    sourceKey: "demo",
    ledger: []
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /inconsistent/);
});

test("separate receiving lines for one SKU are combined once", () => {
  const record = delivery({
    items: [
      { sku: "MILK-1", totalUnits: 12, totalDamagedUnits: 2, usableUnits: 10 },
      { sku: "milk-1", totalUnits: 12, totalDamagedUnits: 1, usableUnits: 11 }
    ]
  });
  const result = reconciliation.prepareApproval({
    record,
    inventory,
    sourceKey: "demo",
    ledger: []
  });
  assert.equal(result.valid, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].receivedUnits, 24);
  assert.equal(result.changes[0].damagedUnits, 3);
  assert.equal(result.changes[0].usableUnits, 21);
  assert.equal(result.changes[0].afterQuantity, 41);
});

test("corrections are separate traceable entries", () => {
  const approved = approval();
  const afterApproval = reconciliation.applyLedgerToInventory(inventory, [approved], "demo");
  const result = reconciliation.createCorrection({
    id: "correction-1",
    approval: approved,
    inventory: afterApproval,
    sourceKey: "demo",
    requestKey: "demo-milk",
    deltaUnits: "-2",
    reason: "Two units were later found damaged",
    correctedBy: "Sam Rivera",
    correctedAt: "2026-10-11T15:00:00.000Z"
  });
  assert.equal(result.valid, true);
  assert.equal(result.entry.parentApprovalId, "approval-1");
  assert.equal(result.entry.changes[0].beforeQuantity, 36);
  assert.equal(result.entry.changes[0].afterQuantity, 34);
  assert.equal(
    reconciliation.applyLedgerToInventory(inventory, [approved, result.entry], "demo")[0].currentStock,
    34
  );
});

test("corrections cannot make inventory negative", () => {
  const approved = approval();
  const afterApproval = reconciliation.applyLedgerToInventory(inventory, [approved], "demo");
  const result = reconciliation.createCorrection({
    approval: approved,
    inventory: afterApproval,
    sourceKey: "demo",
    requestKey: "demo-milk",
    deltaUnits: "-37",
    reason: "Count correction",
    correctedBy: "Sam Rivera"
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /inventory negative/);
});

test("ledger entries apply only to their matching inventory source", () => {
  const demoApproval = approval();
  const customerApproval = {
    ...demoApproval,
    id: "approval-customer",
    sourceKey: "customer:abc"
  };
  assert.equal(
    reconciliation.applyLedgerToInventory(inventory, [demoApproval, customerApproval], "demo")[0].currentStock,
    36
  );
  assert.equal(
    reconciliation.applyLedgerToInventory(inventory, [demoApproval, customerApproval], "customer:abc")[0].currentStock,
    36
  );
  assert.equal(
    reconciliation.applyLedgerToInventory(inventory, [demoApproval], "customer:abc")[0].currentStock,
    20
  );
});

test("a duplicated approval ledger entry is applied only once", () => {
  const approved = approval();
  const duplicate = { ...approved, id: "approval-duplicate" };
  const updated = reconciliation.applyLedgerToInventory(
    inventory,
    [approved, duplicate],
    "demo"
  );
  assert.equal(updated[0].currentStock, 36);
});

test("brand disambiguates product IDs reused across inventory items", () => {
  const repeatedSkuInventory = [
    ...inventory,
    { ...inventory[0], requestKey: "demo-other", brand: "Other Brand", currentStock: 50 }
  ];
  const exact = reconciliation.prepareApproval({
    record: delivery(),
    inventory: repeatedSkuInventory,
    sourceKey: "demo",
    ledger: []
  });
  assert.equal(exact.valid, true);
  assert.equal(exact.changes[0].requestKey, "demo-milk");

  const ambiguous = reconciliation.prepareApproval({
    record: delivery({ items: [{ ...delivery().items[0], brand: "" }] }),
    inventory: repeatedSkuInventory,
    sourceKey: "demo",
    ledger: []
  });
  assert.equal(ambiguous.valid, false);
  assert.match(ambiguous.errors.join(" "), /matches more than one inventory item/);
});

test("approval is blocked when the delivery belongs to another source", () => {
  const result = reconciliation.prepareApproval({
    record: delivery({ sourceKey: "customer:abc" }),
    inventory,
    sourceKey: "demo",
    ledger: []
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /different inventory source/);
});

test("unknown SKUs are routed to new-product review and duplicate unknown lines are blocked", () => {
  const record = delivery({
    items: [
      { sku: "NEW-1", productName: "New Product", brand: "New Brand", totalUnits: 10, totalDamagedUnits: 2, usableUnits: 8 },
      { sku: "new-1", productName: "New Product", brand: "New Brand", totalUnits: 4, totalDamagedUnits: 0, usableUnits: 4 }
    ]
  });
  const result = reconciliation.prepareApproval({ record, inventory, sourceKey: "demo", ledger: [] });
  assert.equal(result.valid, false);
  assert.equal(result.unknownItems.length, 1);
  assert.match(result.errors.join(" "), /appears more than once/);
});

test("new-product approval validates thresholds and posts accepted usable quantity once", () => {
  const record = delivery({
    supplier: "New Supplier",
    items: [{ sku: "NEW-1", productName: "New Product", brand: "New Brand", totalUnits: 10, totalDamagedUnits: 2, usableUnits: 8 }]
  });
  const invalid = reconciliation.createNewProductDecision({
    record,
    item: record.items[0],
    inventory,
    sourceKey: "demo",
    decision: "approve",
    actedBy: "Supervisor",
    fields: { lowStockThreshold: "10", reorderThreshold: "5", reason: "Reviewed" }
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /Reorder threshold/);

  const result = reconciliation.createNewProductDecision({
    id: "new-product-review-1",
    record,
    item: record.items[0],
    inventory,
    sourceKey: "demo",
    decision: "approve",
    actedBy: "Supervisor",
    fields: { lowStockThreshold: "3", reorderThreshold: "5", reason: "SKU, brand, and quantity verified." }
  });
  assert.equal(result.valid, true);
  const updated = reconciliation.applyLedgerToInventory(inventory, [result.entry, result.entry], "demo");
  assert.equal(updated.length, 2);
  assert.equal(updated[1].productId, "NEW-1");
  assert.equal(updated[1].currentStock, 8);
});

test("new-product rejection records a reason without inventory changes", () => {
  const record = delivery({
    supplier: "Unknown Supplier",
    items: [{ sku: "NEW-REJECT", productName: "Rejected Product", brand: "Unknown", totalUnits: 5, totalDamagedUnits: 0, usableUnits: 5 }]
  });
  const result = reconciliation.createNewProductDecision({
    record,
    item: record.items[0],
    inventory,
    sourceKey: "demo",
    decision: "reject",
    actedBy: "Supervisor",
    fields: { reason: "Duplicate supplier catalog entry." }
  });
  assert.equal(result.valid, true);
  assert.equal(result.entry.decision, "rejected");
  assert.equal(reconciliation.applyLedgerToInventory(inventory, [result.entry], "demo").length, 1);
});
