"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../inventory-core.js");

test("parseCSV handles quoted commas, escaped quotes, and quoted newlines", () => {
  const parsed = core.parseCSV(
    'SKU,Name,Brand\n001,"Milk, Whole","Farm ""Fresh"""\n002,"Soft\nCheese",Dairy Co'
  );

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.headers, ["SKU", "Name", "Brand"]);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].values[1], "Milk, Whole");
  assert.equal(parsed.records[0].values[2], 'Farm "Fresh"');
  assert.equal(parsed.records[1].values[1], "Soft\nCheese");
});

test("parseCSV reports malformed rows and unclosed quoted values", () => {
  const uneven = core.parseCSV("SKU,Name\n1,Milk,Extra");
  const unclosed = core.parseCSV('SKU,Name\n1,"Milk');

  assert.match(uneven.errors[0], /found 3 columns; expected 2/);
  assert.match(unclosed.errors[0], /quoted value is not closed/);
});

test("column matching recognizes common customer headings", () => {
  const headers = [
    "SKU",
    "Item Name",
    "Manufacturer",
    "Stock On Hand",
    "Reorder Point",
    "Expiry Date",
    "Last Updated",
    "Order Quantity"
  ];
  const mappings = core.suggestColumnMappings(headers);

  assert.deepEqual(mappings, {
    product_id: 0,
    product_name: 1,
    brand: 2,
    quantity_in_stock_literskg: 3,
    minimum_stock_threshold_literskg: 4,
    expiration_date: 5,
    date: 6,
    reorder_quantity_literskg: 7
  });
});

test("mapped row validation normalizes quantities and supported date formats", () => {
  const parsed = core.parseCSV(
    "SKU,Item,Brand,On Hand,Restock,Expires,Snapshot,Reorder\n" +
    'A-1,Milk,North Farm,"1,250.5",100,10/25/2026,10/10/2026,300'
  );
  const mappings = {
    product_id: 0,
    product_name: 1,
    brand: 2,
    quantity_in_stock_literskg: 3,
    minimum_stock_threshold_literskg: 4,
    expiration_date: 5,
    date: 6,
    reorder_quantity_literskg: 7
  };
  const validation = core.validateMappedRows(parsed, mappings);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.rows[0].quantity_in_stock_literskg, 1250.5);
  assert.equal(validation.rows[0].expiration_date, "2026-10-25");
  assert.equal(validation.rows[0].date, "2026-10-10");
});

test("invalid quantities, dates, and required values are rejected instead of becoming zero", () => {
  const parsed = core.parseCSV(
    "SKU,Item,Brand,On Hand,Restock,Expires\n" +
    ",Milk,North Farm,not-a-number,-2,2026-02-30"
  );
  const validation = core.validateMappedRows(parsed, {
    product_id: 0,
    product_name: 1,
    brand: 2,
    quantity_in_stock_literskg: 3,
    minimum_stock_threshold_literskg: 4,
    expiration_date: 5,
    date: "",
    reorder_quantity_literskg: ""
  });

  assert.equal(validation.rows.length, 0);
  assert.match(validation.errors[0], /Product ID \/ SKU is missing/);
  assert.match(validation.errors[0], /Current stock must be a non-negative number/);
  assert.match(validation.errors[0], /Restock threshold must be a non-negative number/);
  assert.match(validation.errors[0], /Expiration date must be a valid date/);
});

test("missing required column mappings stop the import", () => {
  const parsed = core.parseCSV("SKU,Item\n1,Milk");
  const validation = core.validateMappedRows(parsed, {
    product_id: 0,
    product_name: 1,
    brand: "",
    quantity_in_stock_literskg: "",
    minimum_stock_threshold_literskg: "",
    expiration_date: "",
    date: "",
    reorder_quantity_literskg: ""
  });

  assert.equal(validation.rows.length, 0);
  assert.ok(validation.errors.some((error) => error.includes("Choose a CSV column for Brand")));
});

test("date calculations use calendar days and include today in expiring soon", () => {
  assert.equal(core.calculateDaysToExpiry("2026-10-10", "2026-10-10"), 0);
  assert.equal(core.calculateDaysToExpiry("2026-10-10", "2026-10-24"), 14);
  assert.equal(core.calculateDaysToExpiry("2026-10-10", "2026-10-25"), 15);
  assert.equal(core.calculateDaysToExpiry("2026-10-10", "2026-10-09"), -1);
  assert.equal(core.isExpiringSoon(0), true);
  assert.equal(core.isExpiringSoon(14), true);
  assert.equal(core.isExpiringSoon(15), false);
});

test("inventory classification separates low, reorder-soon, and adequate stock", () => {
  assert.equal(core.classifyStock(10, 10), "low-stock");
  assert.equal(core.classifyStock(11, 10), "reorder-soon");
  assert.equal(core.classifyStock(13, 10), "adequate-stock");
  assert.equal(core.classifyStock(null, 10), "needs-review");
});

test("customer mode uses current date while demo mode preserves snapshot behavior", () => {
  const row = {
    product_id: "A-1",
    product_name: "Milk",
    brand: "North Farm",
    quantity_in_stock_literskg: 50,
    minimum_stock_threshold_literskg: 10,
    reorder_quantity_literskg: 20,
    date: "2025-01-01",
    expiration_date: "2026-10-20"
  };

  const customer = core.aggregateLatestInventory([row], {
    mode: "customer",
    currentDate: "2026-10-10"
  })[0];
  const demo = core.aggregateLatestInventory([row], {
    mode: "demo",
    currentDate: "2026-10-10"
  })[0];

  assert.equal(customer.daysToExpiry, 10);
  assert.equal(customer.status, "expiring-soon");
  assert.ok(demo.daysToExpiry > 600);
  assert.equal(demo.status, "healthy-stock");
});

test("latest unique SKU aggregation remains intact for the classroom dataset", () => {
  const csvPath = path.join(__dirname, "..", "dairy_goods_sales_cleaned.csv");
  const parsed = core.parseCSV(fs.readFileSync(csvPath, "utf8"));
  const inventory = core.aggregateLatestInventory(core.parsedRecordsToObjects(parsed), {
    mode: "demo"
  });

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 4325);
  assert.equal(inventory.length, 40);
});
