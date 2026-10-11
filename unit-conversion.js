"use strict";

const FreshRouteUnits = (() => {
  const SUPPORTED_UNITS = Object.freeze(["each", "boxes", "cases", "kg", "g", "L", "mL"]);
  const BASE_UNITS = Object.freeze(["each", "kg", "g", "L", "mL"]);
  const DISCRETE_UNITS = new Set(["each", "boxes", "cases"]);
  const MAX_INPUT_DECIMALS = 6;
  const MAX_NORMALIZED_DECIMALS = 12;
  const MAX_INTEGER_DIGITS = 18;
  const UNIT_ALIASES = Object.freeze({
    each: "each",
    boxes: "boxes",
    cases: "cases",
    kg: "kg",
    g: "g",
    l: "L",
    ml: "mL"
  });

  function normalizeUnit(value) {
    const text = String(value ?? "").trim();
    return UNIT_ALIASES[text.toLowerCase()] || null;
  }

  function parseDecimal(value, { allowNegative = false } = {}) {
    const entered = String(value ?? "").trim();
    const pattern = allowNegative
      ? /^-?(?:\d+(?:\.\d*)?|\.\d+)$/
      : /^(?:\d+(?:\.\d*)?|\.\d+)$/;

    if (!pattern.test(entered)) {
      return {
        valid: false,
        error: allowNegative
          ? "Quantity must be a plain decimal number."
          : "Quantity must be a plain non-negative decimal number."
      };
    }

    const negative = entered.startsWith("-");
    const unsigned = negative ? entered.slice(1) : entered;
    const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
    const whole = (wholeRaw || "0").replace(/^0+(?=\d)/, "");
    const fraction = fractionRaw.replace(/0+$/, "");

    if (whole.length > MAX_INTEGER_DIGITS) {
      return { valid: false, error: `Quantity cannot exceed ${MAX_INTEGER_DIGITS} whole-number digits.` };
    }
    if (fractionRaw.length > MAX_INPUT_DECIMALS) {
      return { valid: false, error: `Quantity cannot use more than ${MAX_INPUT_DECIMALS} decimal places.` };
    }

    const digits = BigInt(`${whole}${fraction}` || "0");
    const signedDigits = negative ? -digits : digits;
    const canonical = formatDecimal(signedDigits, fraction.length);

    return {
      valid: true,
      entered,
      canonical,
      digits: signedDigits,
      scale: fraction.length,
      isNegative: signedDigits < 0n,
      isZero: signedDigits === 0n
    };
  }

  function formatDecimal(digits, scale) {
    const negative = digits < 0n;
    const absolute = negative ? -digits : digits;
    let text = absolute.toString();

    if (scale > 0) {
      text = text.padStart(scale + 1, "0");
      const splitAt = text.length - scale;
      text = `${text.slice(0, splitAt)}.${text.slice(splitAt)}`.replace(/\.?0+$/, "");
    }

    if (text === "") text = "0";
    return negative && text !== "0" ? `-${text}` : text;
  }

  function multiplyDecimals(first, second) {
    const left = parseDecimal(first, { allowNegative: true });
    const right = parseDecimal(second, { allowNegative: true });
    if (!left.valid || !right.valid) return null;
    return formatDecimal(left.digits * right.digits, left.scale + right.scale);
  }

  function standardRulesFor(baseUnit) {
    const rules = {
      [baseUnit]: { factorToBase: "1", source: "base" }
    };

    if (baseUnit === "kg") rules.g = { factorToBase: "0.001", source: "metric" };
    if (baseUnit === "g") rules.kg = { factorToBase: "1000", source: "metric" };
    if (baseUnit === "L") rules.mL = { factorToBase: "0.001", source: "metric" };
    if (baseUnit === "mL") rules.L = { factorToBase: "1000", source: "metric" };
    return rules;
  }

  function createConversionProfile({ baseUnit, packaging = {} } = {}) {
    const normalizedBaseUnit = normalizeUnit(baseUnit);
    const errors = [];

    if (!normalizedBaseUnit || !BASE_UNITS.includes(normalizedBaseUnit)) {
      errors.push("Base unit must be each, kg, g, L, or mL.");
    }

    const unexpectedRules = Object.keys(packaging || {}).filter(
      (unit) => !["boxes", "cases"].includes(normalizeUnit(unit))
    );
    if (unexpectedRules.length > 0) {
      errors.push("Packaging rules may only define boxes or cases.");
    }

    if (errors.length > 0) return { valid: false, errors, profile: null };

    const rules = standardRulesFor(normalizedBaseUnit);
    for (const [unitValue, factorValue] of Object.entries(packaging || {})) {
      const unit = normalizeUnit(unitValue);
      const factor = parseDecimal(factorValue);
      if (!factor.valid || factor.isZero) {
        errors.push(`${unitValue} must have a positive quantity-to-base conversion factor.`);
        continue;
      }
      rules[unit] = { factorToBase: factor.canonical, source: "packaging" };
    }

    return errors.length > 0
      ? { valid: false, errors, profile: null }
      : {
        valid: true,
        errors: [],
        profile: Object.freeze({
          baseUnit: normalizedBaseUnit,
          rules: Object.freeze(rules)
        })
      };
  }

  function convertQuantity({ quantity, unit, profile, allowNegative = false } = {}) {
    const errors = [];
    const normalizedUnit = normalizeUnit(unit);
    const parsedQuantity = parseDecimal(quantity, { allowNegative });

    if (!normalizedUnit) {
      errors.push(`Unit must be one of: ${SUPPORTED_UNITS.join(", ")}.`);
    }
    if (!parsedQuantity.valid) errors.push(parsedQuantity.error);
    if (!profile || !BASE_UNITS.includes(profile.baseUnit) || !profile.rules) {
      errors.push("A valid SKU conversion profile is required.");
    }
    if (
      normalizedUnit &&
      parsedQuantity.valid &&
      DISCRETE_UNITS.has(normalizedUnit) &&
      parsedQuantity.scale !== 0
    ) {
      errors.push(`${normalizedUnit} must be entered as a whole number.`);
    }

    const rule = normalizedUnit && profile?.rules?.[normalizedUnit];
    if (normalizedUnit && profile?.rules && !rule) {
      errors.push(
        `No explicit conversion from ${normalizedUnit} to ${profile.baseUnit} is configured for this SKU.`
      );
    }

    if (errors.length > 0) return { valid: false, errors, measurement: null };

    const normalizedQuantity = multiplyDecimals(parsedQuantity.canonical, rule.factorToBase);
    if (normalizedQuantity === null) {
      return { valid: false, errors: ["The conversion could not be calculated exactly."], measurement: null };
    }
    const normalizedParts = normalizedQuantity.replace(/^-/, "").split(".");
    if (
      normalizedParts[0].length > MAX_INTEGER_DIGITS ||
      (normalizedParts[1] || "").length > MAX_NORMALIZED_DECIMALS
    ) {
      return {
        valid: false,
        errors: ["The normalized quantity exceeds the supported database precision."],
        measurement: null
      };
    }

    return {
      valid: true,
      errors: [],
      measurement: {
        enteredQuantity: parsedQuantity.entered,
        originalQuantity: parsedQuantity.canonical,
        originalUnit: normalizedUnit,
        normalizedQuantity,
        normalizedUnit: profile.baseUnit,
        factorToBase: rule.factorToBase,
        conversionSource: rule.source
      }
    };
  }

  return {
    SUPPORTED_UNITS,
    BASE_UNITS,
    normalizeUnit,
    parseDecimal,
    multiplyDecimals,
    createConversionProfile,
    convertQuantity
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteUnits;
}

if (typeof window !== "undefined") {
  window.FreshRouteUnits = FreshRouteUnits;
}
