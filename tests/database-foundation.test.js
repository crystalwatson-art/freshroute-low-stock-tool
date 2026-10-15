"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const schema = readFileSync(
  join(ROOT, "database/migrations/001_commercial_foundation.sql"),
  "utf8"
);
const access = readFileSync(
  join(ROOT, "database/migrations/002_access_control_and_approval.sql"),
  "utf8"
);
const warehouse = readFileSync(
  join(ROOT, "database/migrations/003_warehouse_locations_and_transfers.sql"),
  "utf8"
);
const newProduct = readFileSync(
  join(ROOT, "database/migrations/004_new_product_review.sql"),
  "utf8"
);

const TENANT_TABLES = [
  "businesses",
  "app_users",
  "business_invitations",
  "business_memberships",
  "products",
  "product_unit_conversions",
  "inventory_lots",
  "receiving_deliveries",
  "receiving_items",
  "damage_photos",
  "inventory_adjustment_requests",
  "inventory_adjustment_lines",
  "inventory_transactions",
  "inventory_movements",
  "inventory_approval_events"
];

test("every tenant table has row-level security prepared", () => {
  TENANT_TABLES.forEach((table) => {
    assert.match(access, new RegExp(`alter table ${table} enable row level security;`));
  });
});

test("tenant-owned relationships use business-scoped foreign keys", () => {
  assert.match(schema, /references business_invitations\(business_id, id\)/);
  assert.match(schema, /references products\(business_id, id\)/);
  assert.match(schema, /references inventory_adjustment_lines\(business_id, id\)/);
  assert.match(schema, /references inventory_transactions\(business_id, id\)/);
});

test("only authorized roles can apply inventory adjustments", () => {
  assert.match(access, /create function approve_inventory_adjustment/);
  assert.match(access, /array\['supervisor', 'administrator'\]::app_role\[\]/);
  assert.match(access, /There are intentionally no client insert\/update\/delete grants or policies/);
  assert.match(access, /grant select on[\s\S]+to authenticated;/);
  assert.doesNotMatch(access, /create policy .* on inventory_movements\s+for insert/is);
  assert.doesNotMatch(access, /grant insert on[^;]*inventory_movements/is);
});

test("duplicate application and immutable history have database constraints", () => {
  assert.match(schema, /unique \(business_id, request_id\)/);
  assert.match(schema, /unique \(business_id, idempotency_key\)/);
  assert.match(schema, /inventory_movements_are_immutable/);
  assert.match(schema, /inventory_transactions_are_immutable/);
  assert.match(schema, /approval_events_are_immutable/);
});

test("database rules reject incompatible units and preserve original measurements", () => {
  assert.match(schema, /Incompatible measurement families cannot be combined/);
  assert.match(schema, /original_quantity numeric\(30, 6\) not null/);
  assert.match(schema, /original_unit unit_code not null/);
  assert.match(schema, /normalized_quantity numeric\(30, 12\) not null/);
  assert.match(schema, /normalized_unit unit_code not null/);
});

test("balance view respects underlying tenant policies", () => {
  assert.match(schema, /create view inventory_balances\s+with \(security_invoker = true\)/);
});

test("photo records are private metadata and not public image data", () => {
  assert.match(schema, /create table damage_photos/);
  assert.match(schema, /object_key text not null/);
  assert.doesNotMatch(schema, /public_url/i);
  assert.doesNotMatch(access, /damage_photos.*to anon/is);
});

test("warehouse, hierarchical location, and pallet records are tenant-owned", () => {
  ["warehouses", "warehouse_locations", "pallets", "inventory_transfers", "inventory_transfer_lines"]
    .forEach((table) => {
      assert.match(warehouse, new RegExp(`alter table ${table} enable row level security;`));
    });
  assert.match(warehouse, /warehouses_business_code_case_insensitive_unique/);
  assert.match(warehouse, /warehouse_locations_business_id_warehouse_id_parent_location_id_fkey|foreign key \(business_id, warehouse_id, parent_location_id\)/);
  assert.match(warehouse, /pallets_business_lpn_case_insensitive_unique/);
  assert.match(warehouse, /warehouse_scope_is_immutable/);
  assert.match(warehouse, /warehouse_location_scope_is_immutable/);
  assert.match(warehouse, /foreign key \(business_id, product_id, lot_id\)/);
});

test("internal transfers are paired, idempotent, serialized, and immutable", () => {
  assert.match(warehouse, /create function execute_inventory_transfer/);
  assert.match(warehouse, /pg_advisory_xact_lock/);
  assert.match(warehouse, /unique \(business_id, idempotency_key\)/);
  assert.match(warehouse, /'transfer_source'/);
  assert.match(warehouse, /'transfer_destination'/);
  assert.match(warehouse, /inventory_transfers_are_immutable/);
  assert.match(warehouse, /inventory_transfer_lines_are_immutable/);
});

test("all correction decreases use product-wide and exact source locks", () => {
  assert.match(
    warehouse,
    /inventory_stock_lock_key\(\s*adjustment\.business_id, null, null, stock\.product_id, null, null\s*\)/
  );
  assert.match(warehouse, /having bool_or\(line\.original_quantity < 0\)/);
  assert.match(warehouse, /A correction cannot make inventory negative at its warehouse location/);
});

test("warehouse metadata cannot change during located stock operations", () => {
  assert.match(warehouse, /create function app_private\.warehouse_metadata_lock_key/);
  assert.match(warehouse, /pg_advisory_xact_lock_shared/);
  assert.match(warehouse, /warehouse_metadata_updates_are_serialized/);
  assert.match(warehouse, /location_metadata_updates_are_serialized/);
  assert.match(warehouse, /pallet_metadata_updates_are_serialized/);
});

test("location balances preserve product, lot, pallet, and warehouse dimensions", () => {
  assert.match(warehouse, /create view inventory_location_balances/);
  assert.match(warehouse, /movement\.warehouse_id/);
  assert.match(warehouse, /movement\.location_id/);
  assert.match(warehouse, /movement\.lot_id/);
  assert.match(warehouse, /movement\.pallet_id/);
});

test("new-product review preserves unknown deliveries and uses an authenticated atomic path", () => {
  assert.match(newProduct, /create table new_product_reviews/);
  assert.match(newProduct, /foreign key \(business_id, delivery_id\)/);
  assert.match(newProduct, /alter table new_product_reviews enable row level security/);
  assert.match(newProduct, /array\['supervisor', 'administrator'\]::app_role\[\]/);
  assert.match(newProduct, /create function review_new_product/);
  assert.match(newProduct, /create function resubmit_new_product_review/);
  assert.match(newProduct, /create trigger new_product_review_events_are_immutable/);
  assert.match(newProduct, /request_idempotency_key/);
  assert.match(newProduct, /low_stock_threshold/);
  assert.match(newProduct, /accepted_quantity/);
});
