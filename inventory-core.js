"use strict";

const FreshRouteCore = (() => {
  const EXPIRY_WARNING_DAYS = 14;

  const FIELD_DEFINITIONS = [
    {
      key: "product_id",
      label: "Product ID / SKU",
      required: true,
      aliases: ["product id", "product_id", "sku", "sku id", "item id", "item number"]
    },
    {
      key: "product_name",
      label: "Product name",
      required: true,
      aliases: ["product name", "product_name", "item name", "item", "name", "description"]
    },
    {
      key: "brand",
      label: "Brand",
      required: true,
      aliases: ["brand", "manufacturer", "vendor brand"]
    },
    {
      key: "quantity_in_stock_literskg",
      label: "Current stock",
      required: true,
      aliases: [
        "quantity in stock literskg",
        "quantity_in_stock_literskg",
        "current stock",
        "stock on hand",
        "on hand",
        "inventory quantity",
        "quantity"
      ]
    },
    {
      key: "minimum_stock_threshold_literskg",
      label: "Restock threshold",
      required: true,
      aliases: [
        "minimum stock threshold literskg",
        "minimum_stock_threshold_literskg",
        "minimum stock",
        "min stock",
        "restock at",
        "restock threshold",
        "reorder point",
        "low stock threshold"
      ]
    },
    {
      key: "expiration_date",
      label: "Expiration date",
      required: true,
      aliases: ["expiration date", "expiration_date", "expiry date", "expires", "expiration", "best before", "use by"]
    },
    {
      key: "date",
      label: "Inventory snapshot date",
      required: false,
      aliases: ["date", "snapshot date", "inventory date", "as of date", "last updated", "recorded date"]
    },
    {
      key: "reorder_quantity_literskg",
      label: "Suggested reorder quantity",
      required: false,
      aliases: [
        "reorder quantity literskg",
        "reorder_quantity_literskg",
        "reorder quantity",
        "restock quantity",
        "order quantity"
      ]
    }
  ];

  function parseCSV(csvText) {
    const text = String(csvText || "").replace(/^\uFEFF/, "");
    const parsedRows = [];
    const errors = [];
    let values = [];
    let field = "";
    let insideQuotes = false;
    let justClosedQuote = false;
    let lineNumber = 1;
    let rowStartLine = 1;

    function finishField() {
      values.push(field);
      field = "";
      justClosedQuote = false;
    }

    function finishRow() {
      finishField();
      const isBlank = values.every((value) => value.trim() === "");
      if (!isBlank) {
        parsedRows.push({ lineNumber: rowStartLine, values });
      }
      values = [];
      rowStartLine = lineNumber + 1;
    }

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const nextCharacter = text[index + 1];

      if (character === '"') {
        if (insideQuotes && nextCharacter === '"') {
          field += '"';
          index += 1;
        } else if (insideQuotes) {
          insideQuotes = false;
          justClosedQuote = true;
        } else if (field === "") {
          insideQuotes = true;
        } else {
          errors.push(`Line ${lineNumber}: unexpected quote in an unquoted value.`);
          field += character;
        }
        continue;
      }

      if (insideQuotes) {
        if (character === "\r" && nextCharacter === "\n") {
          field += "\n";
          index += 1;
          lineNumber += 1;
        } else {
          field += character;
          if (character === "\n" || character === "\r") lineNumber += 1;
        }
        continue;
      }

      if (justClosedQuote && character !== "," && character !== "\n" && character !== "\r" && !/\s/.test(character)) {
        errors.push(`Line ${lineNumber}: unexpected text after a closing quote.`);
      }

      if (character === ",") {
        finishField();
      } else if (character === "\n") {
        finishRow();
        lineNumber += 1;
        rowStartLine = lineNumber;
      } else if (character === "\r") {
        finishRow();
        if (nextCharacter === "\n") index += 1;
        lineNumber += 1;
        rowStartLine = lineNumber;
      } else if (!justClosedQuote || !/\s/.test(character)) {
        field += character;
      }
    }

    if (insideQuotes) {
      errors.push(`Line ${rowStartLine}: quoted value is not closed.`);
    }

    if (field !== "" || values.length > 0) {
      finishRow();
    }

    if (parsedRows.length === 0) {
      return { headers: [], records: [], errors: ["The CSV file is empty."] };
    }

    const headers = parsedRows[0].values.map((header) => header.trim());
    if (headers.every((header) => header === "")) {
      errors.push("The CSV header row is empty.");
    }

    headers.forEach((header, index) => {
      if (header === "") errors.push(`Column ${index + 1} is missing a heading.`);
    });

    const records = parsedRows.slice(1);
    records.forEach((record) => {
      if (record.values.length !== headers.length) {
        errors.push(
          `Line ${record.lineNumber}: found ${record.values.length} columns; expected ${headers.length}.`
        );
      }
    });

    return { headers, records, errors };
  }

  function parsedRecordsToObjects(parsedCSV) {
    return parsedCSV.records.map((record) => Object.fromEntries(
      parsedCSV.headers.map((header, index) => [header, (record.values[index] || "").trim()])
    ));
  }

  function normalizeHeading(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function suggestColumnMappings(headers) {
    const normalizedHeaders = headers.map(normalizeHeading);
    const usedIndexes = new Set();
    const mappings = {};

    FIELD_DEFINITIONS.forEach((field) => {
      const normalizedAliases = [field.key, ...field.aliases].map(normalizeHeading);
      const matchIndex = normalizedHeaders.findIndex(
        (header, index) => !usedIndexes.has(index) && normalizedAliases.includes(header)
      );
      mappings[field.key] = matchIndex >= 0 ? matchIndex : null;
      if (matchIndex >= 0) usedIndexes.add(matchIndex);
    });

    return mappings;
  }

  function validateMappedRows(parsedCSV, mappings) {
    const errors = [...parsedCSV.errors];
    const rows = [];
    const selectedIndexes = [];

    FIELD_DEFINITIONS.forEach((field) => {
      const rawIndex = mappings[field.key];
      const index = rawIndex === null || rawIndex === "" || rawIndex === undefined
        ? null
        : Number(rawIndex);

      if (field.required && (index === null || !Number.isInteger(index) || !parsedCSV.headers[index])) {
        errors.push(`Choose a CSV column for ${field.label}.`);
      }

      if (index !== null && Number.isInteger(index)) selectedIndexes.push(index);
    });

    if (new Set(selectedIndexes).size !== selectedIndexes.length) {
      errors.push("Each FreshRoute field must be mapped to a different CSV column.");
    }

    if (errors.length > 0) return { rows, errors: uniqueMessages(errors) };

    parsedCSV.records.forEach((record) => {
      const rowErrors = [];
      const getValue = (key) => {
        const index = mappings[key];
        return index === null || index === "" || index === undefined
          ? ""
          : String(record.values[Number(index)] || "").trim();
      };
      const productId = getValue("product_id");
      const productName = getValue("product_name");
      const brand = getValue("brand");
      const currentStock = parseQuantity(getValue("quantity_in_stock_literskg"));
      const restockAt = parseQuantity(getValue("minimum_stock_threshold_literskg"));
      const reorderRaw = getValue("reorder_quantity_literskg");
      const reorderQuantity = reorderRaw === "" ? null : parseQuantity(reorderRaw);
      const expirationDate = normalizeDate(getValue("expiration_date"));
      const snapshotRaw = getValue("date");
      const snapshotDate = snapshotRaw === "" ? "" : normalizeDate(snapshotRaw);

      if (!productId) rowErrors.push("Product ID / SKU is missing");
      if (!productName) rowErrors.push("Product name is missing");
      if (!brand) rowErrors.push("Brand is missing");
      if (currentStock === null) rowErrors.push("Current stock must be a non-negative number");
      if (restockAt === null) rowErrors.push("Restock threshold must be a non-negative number");
      if (reorderRaw !== "" && reorderQuantity === null) {
        rowErrors.push("Suggested reorder quantity must be a non-negative number");
      }
      if (!expirationDate) rowErrors.push("Expiration date must be a valid date");
      if (snapshotRaw !== "" && !snapshotDate) {
        rowErrors.push("Inventory snapshot date must be a valid date");
      }

      if (rowErrors.length > 0) {
        errors.push(`Line ${record.lineNumber}: ${rowErrors.join("; ")}.`);
        return;
      }

      rows.push({
        product_id: productId,
        product_name: productName,
        brand,
        quantity_in_stock_literskg: currentStock,
        minimum_stock_threshold_literskg: restockAt,
        reorder_quantity_literskg: reorderQuantity,
        expiration_date: expirationDate,
        date: snapshotDate
      });
    });

    if (parsedCSV.records.length === 0) errors.push("The CSV file does not contain any inventory rows.");

    return { rows, errors: uniqueMessages(errors) };
  }

  function parseQuantity(value) {
    const text = String(value ?? "").trim();
    if (text === "") return null;

    const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)
      ? text.replaceAll(",", "")
      : text;
    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;

    const number = Number(normalized);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeDate(value) {
    const text = String(value || "").trim();
    let year;
    let month;
    let day;
    let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);

    if (match) {
      [, year, month, day] = match;
    } else {
      match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) return null;
      [, month, day, year] = match;
    }

    const normalized = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return parseDate(normalized) ? normalized : null;
  }

  function parseDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return date;
  }

  function calculateDaysToExpiry(referenceDate, expirationDate) {
    const start = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
    const end = expirationDate instanceof Date ? expirationDate : parseDate(expirationDate);
    if (!start || !end) return null;
    return Math.round((Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) -
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) / 86400000);
  }

  function aggregateLatestInventory(rows, options = {}) {
    const mode = options.mode === "customer" ? "customer" : "demo";
    const currentDate = normalizeDate(options.currentDate) || getLocalTodayISO();
    const latestBySku = new Map();

    rows.forEach((row, sourceIndex) => {
      const productId = cleanText(row.product_id, "Unknown ID");
      const brand = cleanText(row.brand, "Unknown brand");
      const groupKey = JSON.stringify([productId, brand]);
      const snapshotTime = parseDate(normalizeDate(row.date))?.getTime() ?? Number.NEGATIVE_INFINITY;
      const existing = latestBySku.get(groupKey);

      if (
        !existing ||
        snapshotTime > existing.snapshotTime ||
        (snapshotTime === existing.snapshotTime && sourceIndex > existing.sourceIndex)
      ) {
        latestBySku.set(groupKey, { row, productId, brand, snapshotTime, sourceIndex });
      }
    });

    return [...latestBySku.values()]
      .map(({ row, productId, brand }) => cleanInventoryRow(row, productId, brand, mode, currentDate))
      .sort(sortByPriority);
  }

  function cleanInventoryRow(row, productId, brand, mode, currentDate) {
    const currentStock = toNumber(row.quantity_in_stock_literskg);
    const rawMinimumLevel = toNumber(row.minimum_stock_threshold_literskg);
    const restockAt = rawMinimumLevel === null ? null : Math.ceil(rawMinimumLevel);
    const reorderQuantity = toNumber(row.reorder_quantity_literskg);
    const normalizedSnapshotDate = normalizeDate(row.date);
    const expiryReferenceDate = mode === "customer" ? currentDate : normalizedSnapshotDate;
    const daysToExpiry = calculateDaysToExpiry(expiryReferenceDate, normalizeDate(row.expiration_date));
    const stockStatus = classifyStock(currentStock, restockAt);

    return {
      requestKey: mode === "customer"
        ? JSON.stringify(["customer", productId, brand])
        : JSON.stringify([productId, brand]),
      productId,
      productName: cleanText(row.product_name, "Unknown product"),
      brand,
      snapshotDate: mode === "customer"
        ? (normalizedSnapshotDate || `Imported ${currentDate}`)
        : cleanText(row.date, "Unknown date"),
      currentStock,
      restockAt,
      reorderQuantity,
      daysToExpiry,
      stockStatus,
      status: getDisplayStatus(stockStatus, daysToExpiry)
    };
  }

  function classifyStock(currentStock, restockAt) {
    if (!Number.isFinite(currentStock) || !Number.isFinite(restockAt)) return "needs-review";
    if (currentStock <= restockAt) return "low-stock";
    if (currentStock <= restockAt * 1.2) return "reorder-soon";
    return "adequate-stock";
  }

  function getDisplayStatus(stockStatus, daysToExpiry) {
    if (isExpired(daysToExpiry)) return "expired";
    if (daysToExpiry === 0) return "expires-today";
    if (isExpiringSoon(daysToExpiry)) return "expiring-soon";
    if (stockStatus === "low-stock" || stockStatus === "reorder-soon") return stockStatus;
    return stockStatus === "needs-review" ? "needs-review" : "healthy-stock";
  }

  function isExpired(daysToExpiry) {
    return daysToExpiry !== null && daysToExpiry < 0;
  }

  function isExpiringSoon(daysToExpiry) {
    return daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= EXPIRY_WARNING_DAYS;
  }

  function sortByPriority(firstItem, secondItem) {
    const priorityOrder = {
      "expired": 1,
      "expires-today": 2,
      "low-stock": 3,
      "reorder-soon": 4,
      "expiring-soon": 5,
      "healthy-stock": 6,
      "needs-review": 7
    };
    const priorityDifference =
      (priorityOrder[firstItem.status] || 7) - (priorityOrder[secondItem.status] || 7);
    if (priorityDifference !== 0) return priorityDifference;

    const expiryDifference =
      (firstItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER) -
      (secondItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER);
    if (expiryDifference !== 0) return expiryDifference;
    return firstItem.productName.localeCompare(secondItem.productName);
  }

  function getLocalTodayISO(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function toNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cleanText(value, fallback) {
    const cleanedValue = String(value || "").trim();
    return cleanedValue || fallback;
  }

  function uniqueMessages(messages) {
    return [...new Set(messages)];
  }

  return {
    EXPIRY_WARNING_DAYS,
    FIELD_DEFINITIONS,
    parseCSV,
    parsedRecordsToObjects,
    suggestColumnMappings,
    validateMappedRows,
    parseQuantity,
    normalizeDate,
    parseDate,
    calculateDaysToExpiry,
    aggregateLatestInventory,
    classifyStock,
    getDisplayStatus,
    isExpired,
    isExpiringSoon,
    sortByPriority,
    getLocalTodayISO
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteCore;
}

if (typeof window !== "undefined") {
  window.FreshRouteCore = FreshRouteCore;
}
