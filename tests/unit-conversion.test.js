"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const units = require("../unit-conversion.js");

function profile(baseUnit, packaging = {}) {
  const result = units.createConversionProfile({ baseUnit, packaging });
  assert.equal(result.valid, true, result.errors.join(" "));
  return result.profile;
}

test("normalizes each, boxes, and cases using explicit SKU packaging rules", () => {
  const itemProfile = profile("each", { boxes: "12", cases: "48" });

  const each = units.convertQuantity({ quantity: "7", unit: "each", profile: itemProfile });
  const boxes = units.convertQuantity({ quantity: "3", unit: "boxes", profile: itemProfile });
  const cases = units.convertQuantity({ quantity: "2", unit: "cases", profile: itemProfile });

  assert.equal(each.measurement.normalizedQuantity, "7");
  assert.equal(boxes.measurement.normalizedQuantity, "36");
  assert.equal(cases.measurement.normalizedQuantity, "96");
  assert.equal(cases.measurement.originalQuantity, "2");
  assert.equal(cases.measurement.originalUnit, "cases");
  assert.equal(cases.measurement.normalizedUnit, "each");
});

test("converts kg and g exactly without floating-point drift", () => {
  const massProfile = profile("kg", { boxes: "2.5" });
  const grams = units.convertQuantity({ quantity: "1250", unit: "g", profile: massProfile });
  const boxes = units.convertQuantity({ quantity: "3", unit: "boxes", profile: massProfile });

  assert.equal(grams.valid, true);
  assert.equal(grams.measurement.normalizedQuantity, "1.25");
  assert.equal(boxes.measurement.normalizedQuantity, "7.5");
  assert.equal(boxes.measurement.conversionSource, "packaging");
});

test("converts L and mL in both normalized base directions", () => {
  const literProfile = profile("L");
  const milliliterProfile = profile("mL");

  assert.equal(
    units.convertQuantity({ quantity: "750", unit: "mL", profile: literProfile }).measurement.normalizedQuantity,
    "0.75"
  );
  assert.equal(
    units.convertQuantity({ quantity: "1.5", unit: "L", profile: milliliterProfile }).measurement.normalizedQuantity,
    "1500"
  );
});

test("rejects incompatible measurements rather than guessing", () => {
  const massProfile = profile("kg");
  const result = units.convertQuantity({ quantity: "2", unit: "L", profile: massProfile });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /No explicit conversion from L to kg/);
});

test("rejects packages without an explicit conversion rule", () => {
  const result = units.convertQuantity({
    quantity: "2",
    unit: "cases",
    profile: profile("each", { boxes: "12" })
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /No explicit conversion from cases/);
});

test("rejects invalid quantities and fractional discrete units", () => {
  const itemProfile = profile("each", { boxes: "12" });

  assert.equal(units.convertQuantity({ quantity: "unknown", unit: "each", profile: itemProfile }).valid, false);
  assert.equal(units.convertQuantity({ quantity: "-1", unit: "each", profile: itemProfile }).valid, false);
  const fractional = units.convertQuantity({ quantity: "1.5", unit: "boxes", profile: itemProfile });
  assert.equal(fractional.valid, false);
  assert.match(fractional.errors.join(" "), /whole number/);
});

test("allows signed correction quantities only when explicitly requested", () => {
  const itemProfile = profile("each");
  const correction = units.convertQuantity({
    quantity: "-3",
    unit: "each",
    profile: itemProfile,
    allowNegative: true
  });

  assert.equal(correction.valid, true);
  assert.equal(correction.measurement.originalQuantity, "-3");
  assert.equal(correction.measurement.normalizedQuantity, "-3");
});

test("rejects normalized values that exceed database precision", () => {
  const result = units.convertQuantity({
    quantity: "2",
    unit: "cases",
    profile: profile("each", { cases: "999999999999999999" })
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /database precision/);
});

test("validates base units and positive packaging factors", () => {
  assert.equal(units.createConversionProfile({ baseUnit: "boxes" }).valid, false);
  assert.equal(units.createConversionProfile({ baseUnit: "kg", packaging: { cases: "0" } }).valid, false);
  assert.equal(units.createConversionProfile({ baseUnit: "L", packaging: { each: "1" } }).valid, false);
});
