"use strict";

const FreshRouteReceiving = (() => {
  function parseInteger(value, label, { required = true } = {}) {
    const text = String(value ?? "").trim();
    if (text === "" && !required) return { value: 0, error: null };
    if (text === "") return { value: null, error: `${label} is required.` };
    if (!/^\d+$/.test(text)) {
      return { value: null, error: `${label} must be a whole number of zero or more.` };
    }

    const number = Number(text);
    if (!Number.isSafeInteger(number)) {
      return { value: null, error: `${label} is too large.` };
    }
    return { value: number, error: null };
  }

  function calculateReceivingItem(input = {}) {
    const sku = String(input.sku || "").trim();
    const productName = String(input.productName || "").trim();
    const fields = {
      boxesPerRow: parseInteger(input.boxesPerRow, "Boxes per row"),
      layers: parseInteger(input.layers, "Number of layers"),
      unitsPerBox: parseInteger(input.unitsPerBox, "Units per box"),
      damagedBoxes: parseInteger(input.damagedBoxes, "Damaged boxes", { required: false }),
      damagedUnits: parseInteger(input.damagedUnits, "Damaged individual units", { required: false })
    };
    const errors = Object.values(fields).flatMap((field) => field.error ? [field.error] : []);

    if (!sku) {
      errors.push("Product / SKU is required.");
    } else if (sku.length > 80) {
      errors.push("Product / SKU must be 80 characters or fewer.");
    }
    if (!productName) {
      errors.push("Product name is required.");
    } else if (productName.length > 120) {
      errors.push("Product name must be 120 characters or fewer.");
    }

    if (errors.length > 0) return { valid: false, errors, item: null };

    const boxesPerRow = fields.boxesPerRow.value;
    const layers = fields.layers.value;
    const unitsPerBox = fields.unitsPerBox.value;
    const damagedBoxes = fields.damagedBoxes.value;
    const damagedUnits = fields.damagedUnits.value;

    if (boxesPerRow < 1) errors.push("Boxes per row must be at least 1.");
    if (layers < 1) errors.push("Number of layers must be at least 1.");
    if (unitsPerBox < 1) errors.push("Units per box must be at least 1.");

    const totalBoxes = boxesPerRow * layers;
    const totalUnits = totalBoxes * unitsPerBox;
    if (!Number.isSafeInteger(totalBoxes) || !Number.isSafeInteger(totalUnits)) {
      errors.push("The calculated inventory count is too large.");
    }

    if (damagedBoxes > totalBoxes) {
      errors.push("Damaged boxes cannot exceed total boxes.");
    }

    const unitsInDamagedBoxes = damagedBoxes * unitsPerBox;
    const intactUnitsBeforeIndividualDamage = totalUnits - unitsInDamagedBoxes;
    if (damagedUnits > intactUnitsBeforeIndividualDamage) {
      errors.push(
        "Damaged individual units cannot exceed the units remaining outside damaged boxes."
      );
    }

    if (errors.length > 0) return { valid: false, errors, item: null };

    const totalDamagedUnits = unitsInDamagedBoxes + damagedUnits;
    const usableUnits = totalUnits - totalDamagedUnits;

    return {
      valid: true,
      errors: [],
      item: {
        sku,
        productName,
        boxesPerRow,
        layers,
        unitsPerBox,
        totalBoxes,
        totalUnits,
        damagedBoxes,
        damagedUnits,
        unitsInDamagedBoxes,
        totalDamagedUnits,
        usableUnits
      }
    };
  }

  function summarizeReceiving(items = []) {
    return items.reduce((summary, item) => ({
      lineItems: summary.lineItems + 1,
      totalBoxes: summary.totalBoxes + item.totalBoxes,
      totalUnits: summary.totalUnits + item.totalUnits,
      damagedBoxes: summary.damagedBoxes + item.damagedBoxes,
      damagedIndividualUnits: summary.damagedIndividualUnits + item.damagedUnits,
      unitsInDamagedBoxes: summary.unitsInDamagedBoxes + item.unitsInDamagedBoxes,
      totalDamagedUnits: summary.totalDamagedUnits + item.totalDamagedUnits,
      usableUnits: summary.usableUnits + item.usableUnits
    }), {
      lineItems: 0,
      totalBoxes: 0,
      totalUnits: 0,
      damagedBoxes: 0,
      damagedIndividualUnits: 0,
      unitsInDamagedBoxes: 0,
      totalDamagedUnits: 0,
      usableUnits: 0
    });
  }

  function validateDeliveryDetails(details = {}) {
    const deliveryDate = String(details.deliveryDate || "").trim();
    const supplier = String(details.supplier || "").trim();
    const notes = String(details.notes || "").trim();
    const errors = [];

    if (!isValidISODate(deliveryDate)) {
      errors.push("Delivery date must be a valid date.");
    }
    if (!supplier) {
      errors.push("Supplier is required.");
    } else if (supplier.length > 120) {
      errors.push("Supplier must be 120 characters or fewer.");
    }
    if (notes.length > 2000) {
      errors.push("Inspection notes must be 2,000 characters or fewer.");
    }

    return {
      valid: errors.length === 0,
      errors,
      details: errors.length === 0 ? { deliveryDate, supplier, notes } : null
    };
  }

  function isValidISODate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }

  return {
    parseInteger,
    calculateReceivingItem,
    summarizeReceiving,
    validateDeliveryDetails,
    isValidISODate
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteReceiving;
}

if (typeof window !== "undefined") {
  window.FreshRouteReceiving = FreshRouteReceiving;
}
