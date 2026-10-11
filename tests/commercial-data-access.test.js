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
