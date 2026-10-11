"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const receiving = require("../receiving-core.js");

test("calculates boxes and units from rows, layers, and units per box", () => {
  const result = receiving.calculateReceivingItem({
    sku: "MILK-01",
    productName: "Whole Milk",
    boxesPerRow: "4",
    layers: "3",
    unitsPerBox: "10",
    damagedBoxes: "0",
    damagedUnits: "0"
  });

  assert.equal(result.valid, true);
  assert.equal(result.item.totalBoxes, 12);
  assert.equal(result.item.totalUnits, 120);
  assert.equal(result.item.usableUnits, 120);
});

test("subtracts damaged boxes and individual units exactly once", () => {
  const result = receiving.calculateReceivingItem({
    sku: "YOG-02",
    productName: "Greek Yogurt",
    boxesPerRow: 4,
    layers: 3,
    unitsPerBox: 10,
    damagedBoxes: 2,
    damagedUnits: 5
  });

  assert.equal(result.valid, true);
  assert.equal(result.item.unitsInDamagedBoxes, 20);
  assert.equal(result.item.damagedUnits, 5);
  assert.equal(result.item.totalDamagedUnits, 25);
  assert.equal(result.item.usableUnits, 95);
});

test("allows all boxes to be damaged when no extra individual damage is entered", () => {
  const result = receiving.calculateReceivingItem({
    sku: "CREAM-03",
    productName: "Cream",
    boxesPerRow: 2,
    layers: 2,
    unitsPerBox: 6,
    damagedBoxes: 4,
    damagedUnits: 0
  });

  assert.equal(result.valid, true);
  assert.equal(result.item.totalUnits, 24);
  assert.equal(result.item.usableUnits, 0);
});

test("rejects individual damage that exceeds units outside damaged boxes", () => {
  const result = receiving.calculateReceivingItem({
    sku: "CHEESE-04",
    productName: "Cheddar",
    boxesPerRow: 2,
    layers: 2,
    unitsPerBox: 5,
    damagedBoxes: 3,
    damagedUnits: 6
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /outside damaged boxes/);
});

test("rejects damaged boxes greater than the received box count", () => {
  const result = receiving.calculateReceivingItem({
    sku: "BUTTER-05",
    productName: "Butter",
    boxesPerRow: 2,
    layers: 2,
    unitsPerBox: 8,
    damagedBoxes: 5,
    damagedUnits: 0
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /cannot exceed total boxes/);
});

test("rejects negative, fractional, non-numeric, and zero required counts", () => {
  const result = receiving.calculateReceivingItem({
    sku: "EGG-06",
    productName: "Eggs",
    boxesPerRow: "-1",
    layers: "2.5",
    unitsPerBox: "many",
    damagedBoxes: "none",
    damagedUnits: ""
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4);

  const zero = receiving.calculateReceivingItem({
    sku: "EGG-06",
    productName: "Eggs",
    boxesPerRow: "0",
    layers: "1",
    unitsPerBox: "12"
  });
  assert.equal(zero.valid, false);
  assert.match(zero.errors.join(" "), /at least 1/);
});

test("requires both a SKU and product name", () => {
  const result = receiving.calculateReceivingItem({
    boxesPerRow: 1,
    layers: 1,
    unitsPerBox: 1
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /Product \/ SKU is required/);
  assert.match(result.errors.join(" "), /Product name is required/);
});

test("rejects product identifiers that exceed the field limits", () => {
  const result = receiving.calculateReceivingItem({
    sku: "S".repeat(81),
    productName: "P".repeat(121),
    boxesPerRow: 1,
    layers: 1,
    unitsPerBox: 1
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /80 characters or fewer/);
  assert.match(result.errors.join(" "), /120 characters or fewer/);
});

test("summarizes multiple received items for supervisor review", () => {
  const first = receiving.calculateReceivingItem({
    sku: "A",
    productName: "Milk",
    boxesPerRow: 2,
    layers: 2,
    unitsPerBox: 10,
    damagedBoxes: 1,
    damagedUnits: 2
  }).item;
  const second = receiving.calculateReceivingItem({
    sku: "B",
    productName: "Yogurt",
    boxesPerRow: 3,
    layers: 1,
    unitsPerBox: 8,
    damagedBoxes: 0,
    damagedUnits: 4
  }).item;
  const summary = receiving.summarizeReceiving([first, second]);

  assert.deepEqual(summary, {
    lineItems: 2,
    totalBoxes: 7,
    totalUnits: 64,
    damagedBoxes: 1,
    damagedIndividualUnits: 6,
    unitsInDamagedBoxes: 10,
    totalDamagedUnits: 16,
    usableUnits: 48
  });
});

test("validates delivery date, supplier, and note length", () => {
  const invalid = receiving.validateDeliveryDetails({
    deliveryDate: "2026-02-30",
    supplier: "",
    notes: "x".repeat(2001)
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 3);

  const valid = receiving.validateDeliveryDetails({
    deliveryDate: "2026-10-11",
    supplier: "North Farm",
    notes: "Temperature checked at receiving."
  });
  assert.equal(valid.valid, true);
});
