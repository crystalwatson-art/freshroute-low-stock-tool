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
