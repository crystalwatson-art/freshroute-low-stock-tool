"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const units = require("../unit-conversion.js");
const dataAccess = require("../commercial-data-access.js");

function conversionProfile(baseUnit, packaging = {}) {
  return units.createConversionProfile({ baseUnit, packaging }).profile;
}

function repository() {
  return dataAccess.createDataAccess(dataAccess.createInMemoryCommercialAdapter({
    businesses: [
      { id: "business-a", name: "Market A" },
      { id: "business-b", name: "Market B" }
    ],
    memberships: [
      {
        businessId: "business-a",
        userId: "worker-a",
        role: "worker",
        status: "active",
        invitationAcceptedAt: "2026-10-11T12:00:00Z"
      },
      {
        businessId: "business-a",
        userId: "supervisor-a",
        role: "supervisor",
        status: "active",
        invitationAcceptedAt: "2026-10-11T12:00:00Z"
      },
      {
        businessId: "business-a",
        userId: "admin-a",
        role: "administrator",
        status: "active",
        invitationAcceptedAt: "2026-10-11T12:00:00Z"
      },
      {
        businessId: "business-b",
        userId: "supervisor-b",
        role: "supervisor",
        status: "active",
        invitationAcceptedAt: "2026-10-11T12:00:00Z"
      },
      {
        businessId: "business-a",
        userId: "pending-a",
        role: "supervisor",
        status: "invited",
        invitationAcceptedAt: null
      }
    ],
    products: [
      {
        id: "product-a",
        businessId: "business-a",
        sku: "MILK-A",
        name: "Milk",
        conversionProfile: conversionProfile("L", { cases: "12" })
      },
      {
        id: "product-b",
        businessId: "business-b",
        sku: "MILK-B",
        name: "Milk",
        conversionProfile: conversionProfile("mL", { cases: "12000" })
      }
    ],
    warehouses: [
      { id: "warehouse-a", businessId: "business-a", code: "A1", name: "Warehouse A", active: true },
      { id: "warehouse-a2", businessId: "business-a", code: "A2", name: "Warehouse A2", active: true },
      { id: "warehouse-b", businessId: "business-b", code: "B1", name: "Warehouse B", active: true }
    ],
    locations: [
      { id: "receiving-a", businessId: "business-a", warehouseId: "warehouse-a", purpose: "receiving", acceptsInventory: true, active: true },
      { id: "staging-a", businessId: "business-a", warehouseId: "warehouse-a", purpose: "staging", acceptsInventory: true, active: true },
      { id: "storage-a", businessId: "business-a", warehouseId: "warehouse-a", purpose: "storage", acceptsInventory: true, active: true },
      { id: "area-a", businessId: "business-a", warehouseId: "warehouse-a", purpose: "storage", acceptsInventory: false, active: true },
      { id: "storage-a2", businessId: "business-a", warehouseId: "warehouse-a2", purpose: "storage", acceptsInventory: true, active: true },
      { id: "storage-b", businessId: "business-b", warehouseId: "warehouse-b", purpose: "storage", acceptsInventory: true, active: true }
    ],
    pallets: [
      { id: "pallet-a", businessId: "business-a", warehouseId: "warehouse-a", lpn: "LPN-A", status: "active" },
      { id: "pallet-b", businessId: "business-b", warehouseId: "warehouse-b", lpn: "LPN-B", status: "active" }
    ]
  }));
}

const workerA = { userId: "worker-a", businessId: "business-a" };
const supervisorA = { userId: "supervisor-a", businessId: "business-a" };
const adminA = { userId: "admin-a", businessId: "business-a" };
const supervisorB = { userId: "supervisor-b", businessId: "business-b" };

function approve(repo, context = supervisorA, overrides = {}) {
  return repo.approveAdjustment(context, {
    idempotencyKey: "delivery-a-1",
    sourceId: "receiving-a-1",
    occurredAt: "2026-10-11T13:00:00Z",
    lines: [{ productId: "product-a", quantity: "2", unit: "cases" }],
    ...overrides
  });
}

function receiveLocated(repo) {
  return approve(repo, supervisorA, {
    idempotencyKey: "located-delivery-a-1",
    sourceId: "located-receiving-a-1",
    lines: [{
      productId: "product-a",
      quantity: "2",
      unit: "cases",
      lotId: "lot-a",
      warehouseId: "warehouse-a",
      locationId: "receiving-a",
      palletId: "pallet-a"
    }]
  });
}

test("data-access interface rejects incomplete adapters", () => {
  assert.throws(
    () => dataAccess.createDataAccess({ listProducts() {} }),
    (error) => error.code === "INVALID_ADAPTER"
  );
});

test("Worker cannot approve inventory adjustments", () => {
  const repo = repository();
  assert.throws(
    () => approve(repo, workerA),
    (error) => error.code === "PERMISSION_DENIED"
  );
  assert.equal(repo.listMovements(workerA).length, 0);
});

test("an invitation must be accepted before any business access", () => {
  const repo = repository();
  assert.throws(
    () => repo.listProducts({ userId: "pending-a", businessId: "business-a" }),
    (error) => error.code === "ACCESS_DENIED"
  );
});

test("Supervisor approval preserves original and normalized measurements", () => {
  const repo = repository();
  const result = approve(repo);
  const movement = result.movements[0];

  assert.equal(movement.originalQuantity, "2");
  assert.equal(movement.originalUnit, "cases");
  assert.equal(movement.normalizedQuantity, "24");
  assert.equal(movement.normalizedUnit, "L");
  assert.equal(movement.conversionFactor, "12");
  assert.deepEqual(repo.getInventoryBalances(supervisorA), [{
    productId: "product-a",
    sku: "MILK-A",
    quantity: "24",
    unit: "L"
  }]);
});

test("duplicate idempotency keys cannot apply inventory twice", () => {
  const repo = repository();
  approve(repo);
  assert.throws(
    () => approve(repo),
    (error) => error.code === "DUPLICATE_TRANSACTION"
  );
  assert.equal(repo.getInventoryBalances(supervisorA)[0].quantity, "24");
});

test("business records remain strictly separated", () => {
  const repo = repository();
  approve(repo);

  assert.equal(repo.listProducts(supervisorA)[0].id, "product-a");
  assert.equal(repo.listProducts(supervisorB)[0].id, "product-b");
  assert.equal(repo.listMovements(supervisorB).length, 0);
  assert.throws(
    () => approve(repo, supervisorA, {
      idempotencyKey: "wrong-business-product",
      lines: [{ productId: "product-b", quantity: "1", unit: "cases" }]
    }),
    (error) => error.code === "PRODUCT_NOT_FOUND"
  );
});

test("warehouse, location, and pallet queries remain business-scoped", () => {
  const repo = repository();
  assert.deepEqual(repo.listWarehouses(workerA).map((item) => item.id), ["warehouse-a", "warehouse-a2"]);
  assert.deepEqual(
    repo.listLocations(workerA, { warehouseId: "warehouse-a" }).map((item) => item.id),
    ["receiving-a", "staging-a", "storage-a", "area-a"]
  );
  assert.deepEqual(repo.listPallets(workerA).map((item) => item.id), ["pallet-a"]);
  assert.deepEqual(repo.listWarehouses(supervisorB).map((item) => item.id), ["warehouse-b"]);
});

test("Administrator manages location hierarchy while workers can register business pallets", () => {
  const repo = repository();
  assert.throws(
    () => repo.createWarehouse(workerA, { code: "A3", name: "Denied" }),
    (error) => error.code === "PERMISSION_DENIED"
  );
  const warehouse = repo.createWarehouse(adminA, { code: "A3", name: "Warehouse A3" });
  const area = repo.createLocation(adminA, {
    warehouseId: warehouse.id,
    code: "STOR",
    name: "Storage",
    kind: "area",
    purpose: "storage",
    acceptsInventory: false
  });
  const bin = repo.createLocation(adminA, {
    warehouseId: warehouse.id,
    parentLocationId: area.id,
    code: "BIN-01",
    name: "Storage Bin 01",
    kind: "bin",
    purpose: "storage",
    acceptsInventory: true
  });
  const pallet = repo.registerPallet(workerA, { warehouseId: "warehouse-a", lpn: "LPN-A-0002" });

  assert.equal(bin.parentLocationId, area.id);
  assert.equal(pallet.createdBy, "worker-a");
  assert.throws(
    () => repo.registerPallet(workerA, { warehouseId: "warehouse-a", lpn: "lpn-a-0002" }),
    (error) => error.code === "DUPLICATE_PALLET"
  );
});

test("put-away records paired movements and conserves product inventory", () => {
  const repo = repository();
  receiveLocated(repo);
  const before = repo.getInventoryBalances(workerA)[0].quantity;
  const result = repo.transferInventory(workerA, {
    idempotencyKey: "putaway-a-0001",
    warehouseId: "warehouse-a",
    sourceLocationId: "receiving-a",
    destinationLocationId: "storage-a",
    palletId: "pallet-a",
    type: "putaway",
    note: "Move inspected pallet to storage",
    lines: [{ productId: "product-a", lotId: "lot-a", quantity: "1", unit: "cases" }]
  });

  assert.equal(result.movements.length, 2);
  assert.deepEqual(result.movements.map((movement) => movement.movementRole), [
    "transfer_source", "transfer_destination"
  ]);
  assert.deepEqual(result.movements.map((movement) => movement.normalizedQuantity), ["-12", "12"]);
  assert.ok(result.movements.every((movement) => movement.lotId === "lot-a"));
  assert.ok(result.movements.every((movement) => movement.palletId === "pallet-a"));
  assert.deepEqual(
    repo.getLocationBalances(workerA, { warehouseId: "warehouse-a" })
      .map((balance) => [balance.locationId, balance.quantity]),
    [["receiving-a", "12"], ["storage-a", "12"]]
  );
  assert.equal(repo.getInventoryBalances(workerA)[0].quantity, before);
});

test("relocation moves an existing lot and pallet without changing total stock", () => {
  const repo = repository();
  receiveLocated(repo);
  repo.transferInventory(workerA, {
    idempotencyKey: "putaway-before-relocation",
    warehouseId: "warehouse-a",
    sourceLocationId: "receiving-a",
    destinationLocationId: "storage-a",
    palletId: "pallet-a",
    type: "putaway",
    lines: [{ productId: "product-a", lotId: "lot-a", quantity: "1", unit: "cases" }]
  });
  repo.transferInventory(workerA, {
    idempotencyKey: "relocation-a-0001",
    warehouseId: "warehouse-a",
    sourceLocationId: "storage-a",
    destinationLocationId: "staging-a",
    palletId: "pallet-a",
    type: "relocation",
    lines: [{ productId: "product-a", lotId: "lot-a", quantity: "6", unit: "L" }]
  });

  assert.deepEqual(
    repo.getLocationBalances(workerA).map((balance) => [balance.locationId, balance.quantity]),
    [["receiving-a", "12"], ["storage-a", "6"], ["staging-a", "6"]]
  );
  assert.equal(repo.getInventoryBalances(workerA)[0].quantity, "24");
});

test("invalid, cross-warehouse, and cross-business transfer destinations are rejected atomically", () => {
  const repo = repository();
  receiveLocated(repo);
  const initialMovements = repo.listMovements(workerA).length;
  const base = {
    warehouseId: "warehouse-a",
    sourceLocationId: "receiving-a",
    palletId: "pallet-a",
    type: "putaway",
    lines: [{ productId: "product-a", lotId: "lot-a", quantity: "1", unit: "cases" }]
  };

  assert.throws(
    () => repo.transferInventory(workerA, { ...base, idempotencyKey: "invalid-area-0001", destinationLocationId: "area-a" }),
    (error) => error.code === "INVALID_DESTINATION"
  );
  assert.throws(
    () => repo.transferInventory(workerA, { ...base, idempotencyKey: "wrong-warehouse-1", destinationLocationId: "storage-a2" }),
    (error) => error.code === "INVALID_DESTINATION"
  );
  assert.throws(
    () => repo.transferInventory(workerA, { ...base, idempotencyKey: "wrong-business-01", destinationLocationId: "storage-b" }),
    (error) => error.code === "INVALID_DESTINATION"
  );
  assert.equal(repo.listMovements(workerA).length, initialMovements);
});

test("insufficient and duplicate transfers cannot change stock twice", () => {
  const repo = repository();
  receiveLocated(repo);
  const command = {
    idempotencyKey: "putaway-once-01",
    warehouseId: "warehouse-a",
    sourceLocationId: "receiving-a",
    destinationLocationId: "storage-a",
    palletId: "pallet-a",
    type: "putaway",
    lines: [{ productId: "product-a", lotId: "lot-a", quantity: "1", unit: "cases" }]
  };
  repo.transferInventory(workerA, command);
  const afterFirst = repo.listMovements(workerA).length;

  assert.throws(
    () => repo.transferInventory(workerA, command),
    (error) => error.code === "DUPLICATE_TRANSACTION"
  );
  assert.throws(
    () => repo.transferInventory(workerA, {
      ...command,
      idempotencyKey: "putaway-too-much",
      lines: [{ productId: "product-a", lotId: "lot-a", quantity: "2", unit: "cases" }]
    }),
    (error) => error.code === "INSUFFICIENT_INVENTORY"
  );
  assert.equal(repo.listMovements(workerA).length, afterFirst);
  assert.equal(repo.getInventoryBalances(workerA)[0].quantity, "24");
});

test("the same idempotency value is scoped independently per business", () => {
  const repo = repository();
  approve(repo);
  const result = approve(repo, supervisorB, {
    sourceId: "receiving-b-1",
    lines: [{ productId: "product-b", quantity: "1", unit: "cases" }]
  });

  assert.equal(result.movements[0].normalizedQuantity, "12000");
  assert.equal(repo.listMovements(supervisorB).length, 1);
});

test("corrections append traceable movements instead of overwriting approvals", () => {
  const repo = repository();
  const approved = approve(repo);
  const corrected = repo.createCorrection(adminA, {
    idempotencyKey: "correction-a-1",
    sourceId: "count-a-1",
    correctsTransactionId: approved.transaction.id,
    reason: "One liter was damaged after receiving",
    occurredAt: "2026-10-11T14:00:00Z",
    lines: [{ productId: "product-a", quantity: "-1000", unit: "mL" }]
  });

  assert.equal(corrected.transaction.type, "correction");
  assert.equal(corrected.transaction.correctsTransactionId, approved.transaction.id);
  assert.equal(repo.listMovements(adminA).length, 2);
  assert.equal(repo.getInventoryBalances(adminA)[0].quantity, "23");
});

test("corrections cannot make stock negative or reference another business", () => {
  const repo = repository();
  const approved = approve(repo);
  assert.throws(
    () => repo.createCorrection(supervisorA, {
      idempotencyKey: "correction-too-large",
      sourceId: "count-a-2",
      correctsTransactionId: approved.transaction.id,
      reason: "Invalid count",
      lines: [{ productId: "product-a", quantity: "-25", unit: "L" }]
    }),
    (error) => error.code === "NEGATIVE_INVENTORY"
  );
  assert.throws(
    () => repo.createCorrection(supervisorB, {
      idempotencyKey: "cross-business-correction",
      sourceId: "count-b-1",
      correctsTransactionId: approved.transaction.id,
      reason: "Should not be visible",
      lines: [{ productId: "product-b", quantity: "-1", unit: "mL" }]
    }),
    (error) => error.code === "REFERENCE_NOT_FOUND"
  );
});

test("classroom demo adapter is separate and read-only", () => {
  const demo = dataAccess.createDataAccess(dataAccess.createClassroomDemoAdapter(() => [
    { productId: "DEMO-1", currentStock: 10 }
  ]));

  assert.equal(demo.mode, "classroom-demo");
  assert.equal(demo.listProducts().length, 1);
  assert.throws(
    () => demo.approveAdjustment({}, {}),
    (error) => error.code === "DEMO_READ_ONLY"
  );
});
