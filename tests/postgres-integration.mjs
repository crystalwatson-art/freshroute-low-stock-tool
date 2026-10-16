"use strict";

import assert from "node:assert/strict";
import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const MIGRATIONS = [
  join(ROOT, "database/migrations/001_commercial_foundation.sql"),
  join(ROOT, "database/migrations/002_access_control_and_approval.sql"),
  join(ROOT, "database/migrations/003_warehouse_locations_and_transfers.sql"),
  join(ROOT, "database/migrations/004_new_product_review.sql"),
  join(ROOT, "database/migrations/005_authenticated_commercial_workflows.sql"),
  join(ROOT, "database/migrations/006_expiration_tracking.sql")
];
const DEFAULT_POSTGRES_BINS = [
  process.env.POSTGRES_BIN,
  "/Applications/Postgres.app/Contents/Versions/latest/bin",
  "/Applications/Postgres.app/Contents/Versions/18/bin"
].filter(Boolean);

function findPostgresBin() {
  for (const candidate of DEFAULT_POSTGRES_BINS) {
    try {
      accessSync(join(candidate, "initdb"), constants.X_OK);
      accessSync(join(candidate, "pg_ctl"), constants.X_OK);
      accessSync(join(candidate, "psql"), constants.X_OK);
      return candidate;
    } catch {
      // Try the next known local installation.
    }
  }
  throw new Error(
    "PostgreSQL tools were not found. Set POSTGRES_BIN to the directory containing initdb, pg_ctl, and psql."
  );
}

function command(commandPath, args, options = {}) {
  const result = spawnSync(commandPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${commandPath} ${args.join(" ")} failed with exit code ${result.status}\n${result.stdout || ""}${result.stderr || ""}`
    );
  }
  return result;
}

const postgresBin = findPostgresBin();
const testRoot = mkdtempSync(join("/private/tmp", "freshroute-pg-integration-"));
const dataDir = join(testRoot, "data");
const socketDir = join(testRoot, "socket");
const logPath = join(testRoot, "postgres.log");
const port = 55000 + (process.pid % 9000);
let serverStarted = false;
let checks = 0;

function cleanup() {
  if (serverStarted && existsSync(join(dataDir, "postmaster.pid"))) {
    spawnSync(join(postgresBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
      encoding: "utf8"
    });
  }
  serverStarted = false;
  if (!testRoot.startsWith("/private/tmp/freshroute-pg-integration-")) {
    throw new Error(`Refusing to remove unexpected path: ${testRoot}`);
  }
  rmSync(testRoot, { recursive: true, force: true });
}

function pass(message) {
  checks += 1;
  console.log(`PASS ${message}`);
}

function psqlArgs(extra = []) {
  return [
    "-X",
    "-v", "ON_ERROR_STOP=1",
    "-h", socketDir,
    "-p", String(port),
    "-U", "postgres",
    "-d", "freshroute_test",
    ...extra
  ];
}

function runSql(sql) {
  return command(join(postgresBin, "psql"), psqlArgs(), { input: sql });
}

function runPsqlAsync(sql) {
  return new Promise((resolve) => {
    const child = spawn(join(postgresBin, "psql"), psqlArgs(["-c", sql]), {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function run() {
  mkdirSync(socketDir);
  command(join(postgresBin, "initdb"), [
    "-D", dataDir,
    "--auth=trust",
    "--no-locale",
    "-U", "postgres"
  ]);
  command(join(postgresBin, "pg_ctl"), [
    "-D", dataDir,
    "-l", logPath,
    "-o", `-F -p ${port} -k ${socketDir} -c listen_addresses=''`,
    "-w", "start"
  ]);
  serverStarted = true;
  command(join(postgresBin, "createdb"), [
    "-h", socketDir,
    "-p", String(port),
    "-U", "postgres",
    "freshroute_test"
  ]);
  runSql("create role authenticated nologin;");
  for (const migration of MIGRATIONS) {
    command(join(postgresBin, "psql"), psqlArgs(["-f", migration]));
  }
  pass("all six migrations apply to a new PostgreSQL cluster");

  runSql(String.raw`
insert into businesses (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Business A'),
  ('10000000-0000-0000-0000-000000000002', 'Business B');

insert into app_users (id, email, display_name) values
  ('20000000-0000-0000-0000-000000000001', 'admin-a@example.test', 'Admin A'),
  ('20000000-0000-0000-0000-000000000002', 'supervisor-a@example.test', 'Supervisor A'),
  ('20000000-0000-0000-0000-000000000003', 'worker-a@example.test', 'Worker A'),
  ('20000000-0000-0000-0000-000000000004', 'pending-a@example.test', 'Pending A'),
  ('20000000-0000-0000-0000-000000000005', 'admin-b@example.test', 'Admin B'),
  ('20000000-0000-0000-0000-000000000006', 'outsider@example.test', 'Outsider');

insert into business_invitations (
  id, business_id, email, role, token_hash, invited_by, expires_at, accepted_by, accepted_at
) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin-a@example.test', 'administrator', repeat('a', 64), '20000000-0000-0000-0000-000000000001', now() + interval '7 days', '20000000-0000-0000-0000-000000000001', now()),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'supervisor-a@example.test', 'supervisor', repeat('b', 64), '20000000-0000-0000-0000-000000000001', now() + interval '7 days', '20000000-0000-0000-0000-000000000002', now()),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'worker-a@example.test', 'worker', repeat('c', 64), '20000000-0000-0000-0000-000000000001', now() + interval '7 days', '20000000-0000-0000-0000-000000000003', now()),
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'pending-a@example.test', 'worker', repeat('d', 64), '20000000-0000-0000-0000-000000000001', now() + interval '7 days', null, null),
  ('40000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'admin-b@example.test', 'administrator', repeat('e', 64), '20000000-0000-0000-0000-000000000005', now() + interval '7 days', '20000000-0000-0000-0000-000000000005', now());

insert into business_memberships (
  business_id, user_id, role, status, invitation_id, invitation_accepted_at
) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'administrator', 'active', '40000000-0000-0000-0000-000000000001', now()),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'supervisor', 'active', '40000000-0000-0000-0000-000000000002', now()),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'worker', 'active', '40000000-0000-0000-0000-000000000003', now()),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', 'worker', 'invited', '40000000-0000-0000-0000-000000000004', null),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'administrator', 'active', '40000000-0000-0000-0000-000000000005', now());

insert into products (id, business_id, sku, name, base_unit) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'A-EACH', 'Business A Each Product', 'each'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'A-KG', 'Business A Mass Product', 'kg'),
  ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'A-LOCK', 'Business A Lock Product', 'each'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'B-EACH', 'Business B Product', 'each');

update products set brand = case id
  when '30000000-0000-0000-0000-000000000001' then 'A Brand'
  when '30000000-0000-0000-0000-000000000002' then 'A Mass Brand'
  when '30000000-0000-0000-0000-000000000005' then 'A Lock Brand'
  else 'B Brand' end;

insert into product_unit_conversions (
  business_id, product_id, from_unit, to_base_factor, rule_source, created_by
) values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'each', 1, 'base', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'boxes', 12, 'packaging', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'kg', 1, 'base', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'g', 0.001, 'metric', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005', 'each', 1, 'base', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'each', 1, 'base', '20000000-0000-0000-0000-000000000005');

insert into warehouses (id, business_id, code, name, created_by) values
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'A1', 'Business A Main', '20000000-0000-0000-0000-000000000001'),
  ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'B1', 'Business B Main', '20000000-0000-0000-0000-000000000005'),
  ('80000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'A2', 'Business A Overflow', '20000000-0000-0000-0000-000000000001');

insert into warehouse_locations (
  id, business_id, warehouse_id, parent_location_id, code, name,
  kind, purpose, accepts_inventory, active, created_by
) values
  ('81000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', null, 'RECV', 'Receiving', 'area', 'receiving', true, true, '20000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', null, 'STOR', 'Storage', 'area', 'storage', false, true, '20000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'STOR-BIN-01', 'Storage Bin 01', 'bin', 'storage', true, true, '20000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', null, 'STAGE', 'Staging', 'area', 'staging', true, true, '20000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', null, 'INACTIVE', 'Inactive Storage', 'area', 'storage', true, false, '20000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', null, 'B-STOR', 'Business B Storage', 'area', 'storage', true, true, '20000000-0000-0000-0000-000000000005'),
  ('81000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000003', null, 'A2-STOR', 'Overflow Storage', 'area', 'storage', true, true, '20000000-0000-0000-0000-000000000001');

insert into pallets (id, business_id, warehouse_id, lpn, created_by) values
  ('82000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'LPN-A-0001', '20000000-0000-0000-0000-000000000003'),
  ('82000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', 'LPN-B-0001', '20000000-0000-0000-0000-000000000005');

insert into inventory_lots (id, business_id, product_id, lot_code, expiration_date) values
  ('83000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'LOT-A-001', current_date + 30),
  ('83000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005', 'LOT-LOCK-001', current_date + 30);

insert into receiving_deliveries (
  id, business_id, supplier, delivered_on, inspection_notes, recorded_by
) values (
  '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'Test Supplier', current_date, 'Two boxes received; four loose units damaged.',
  '20000000-0000-0000-0000-000000000003'
);

insert into receiving_items (
  id, business_id, delivery_id, product_id, received_quantity, received_unit,
  damaged_loose_quantity, damaged_loose_unit
) values (
  '51000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  2, 'boxes', 4, 'each'
);

do $$
declare blocked boolean := false;
begin
  begin
    insert into app_users (id, email, display_name)
    values ('20000000-0000-0000-0000-000000000099', 'ADMIN-A@EXAMPLE.TEST', 'Duplicate');
  exception when unique_violation then blocked := true;
  end;
  if not blocked then raise exception 'Case-insensitive email uniqueness was not enforced'; end if;
end;
$$;
  `);
  pass("case-insensitive email uniqueness and test fixtures are valid");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);

do $$
declare blocked boolean := false;
begin
  if (select count(*) from businesses) <> 1 then raise exception 'Worker business visibility failed'; end if;
  if (select count(*) from products) <> 3 then raise exception 'Worker product separation failed'; end if;
  if (select count(*) from warehouses) <> 2 then raise exception 'Worker warehouse separation failed'; end if;
  if exists (select 1 from products where business_id = '10000000-0000-0000-0000-000000000002') then raise exception 'Worker saw another business'; end if;
  if (select count(*) from app_users) <> 1 then raise exception 'User self-only policy failed'; end if;

  begin
    insert into products (business_id, sku, name, base_unit)
    values ('10000000-0000-0000-0000-000000000001', 'WORKER-DENIED', 'Denied', 'each');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Worker managed products'; end if;

  blocked := false;
  begin
    insert into warehouses (business_id, code, name, created_by)
    values ('10000000-0000-0000-0000-000000000001', 'WORKER', 'Denied', '20000000-0000-0000-0000-000000000003');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Worker managed warehouses'; end if;

  blocked := false;
  begin
    insert into business_invitations (business_id, email, role, token_hash, invited_by, expires_at)
    values ('10000000-0000-0000-0000-000000000001', 'worker-invite@example.test', 'worker', repeat('f', 64), '20000000-0000-0000-0000-000000000003', now() + interval '1 day');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Worker created an invitation'; end if;
end;
$$;

insert into inventory_adjustment_requests (
  id, business_id, type, source_reference, delivery_id, requested_by
) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'receiving', 'delivery-usable-units', '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'count', 'boxes-conversion', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'count', 'reject-me', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'count', 'concurrent', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'count', 'invalid-conversion', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'count', 'rollback-all', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'count', 'duplicate-idempotency', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', 'count', 'admin-approval', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'count', 'unauthorized-approval', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001', 'count', 'lock-product-located', null, '20000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', 'count', 'lock-product-unlocated', null, '20000000-0000-0000-0000-000000000003');

insert into inventory_adjustment_lines (
  id, business_id, request_id, product_id, lot_id, original_quantity, original_unit,
  warehouse_id, location_id, pallet_id
) values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', 20, 'each', '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', null, 2, 'boxes', null, null, null),
  ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', null, 1, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000001', null, 3, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000002', null, 1, 'L', null, null, null),
  ('70000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000001', null, 1, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000002', null, 1, 'L', null, null, null),
  ('70000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000001', null, 1, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000008', '30000000-0000-0000-0000-000000000001', null, 1, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000009', '30000000-0000-0000-0000-000000000001', null, 1, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000010', '30000000-0000-0000-0000-000000000005', '83000000-0000-0000-0000-000000000002', 20, 'each', '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000005', null, 24, 'each', null, null, null);

do $$
declare blocked boolean := false; message text;
begin
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000009', 'worker-denied-key');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('Supervisor or Administrator' in message) = 0 then
    raise exception 'Unauthorized worker approval was not rejected correctly: %', message;
  end if;
end;
$$;
reset role;
  `);
  pass("business isolation and Worker restrictions are enforced");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
do $$
declare blocked boolean := false;
begin
  begin
    insert into products (business_id, sku, name, base_unit)
    values ('10000000-0000-0000-0000-000000000001', 'SUPERVISOR-DENIED', 'Denied', 'each');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Supervisor managed products'; end if;
end;
$$;

select approve_inventory_adjustment('60000000-0000-0000-0000-000000000001', 'receiving-key-0001');
select approve_inventory_adjustment('60000000-0000-0000-0000-000000000002', 'duplicate-key-0001');
select approve_inventory_adjustment('60000000-0000-0000-0000-000000000010', 'lock-located-key');
select approve_inventory_adjustment('60000000-0000-0000-0000-000000000011', 'lock-unlocated-key');
select reject_inventory_adjustment('60000000-0000-0000-0000-000000000003', 'Inspection discrepancy');

do $$
declare blocked boolean := false; message text;
begin
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000002', 'duplicate-key-0002');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('already has a decision' in message) = 0 then raise exception 'Duplicate request approval was not blocked: %', message; end if;

  blocked := false; message := null;
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000005', 'invalid-unit-key');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('explicit conversion rule' in message) = 0 then raise exception 'Missing conversion was not rejected: %', message; end if;

  blocked := false; message := null;
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000006', 'rollback-key-0001');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('explicit conversion rule' in message) = 0 then raise exception 'Mixed request did not roll back: %', message; end if;

  blocked := false; message := null;
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000007', 'duplicate-key-0001');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('already applied' in message) = 0 then raise exception 'Duplicate idempotency key was not rejected: %', message; end if;
end;
$$;
reset role;
  `);
  pass("Supervisor approval and rejection permissions are enforced");
  pass("duplicate submissions and idempotency-key reuse are blocked");
  pass("invalid conversions fail and partial approvals roll back completely");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);

select execute_inventory_transfer(
  '10000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000003',
  '82000000-0000-0000-0000-000000000001',
  'putaway', 'putaway-first-0001',
  '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":8,"unit":"each"}]',
  'Initial put-away'
);

do $$
declare blocked boolean; message text; before_count bigint;
begin
  select count(*) into before_count from inventory_transfers;

  blocked := false;
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'putaway-first-0001',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":8,"unit":"each"}]', ''
    );
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('already processed' in message) = 0 then raise exception 'Duplicate transfer was not rejected: %', message; end if;

  blocked := false; message := null;
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'invalid-area-0001',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":1,"unit":"each"}]', ''
    );
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('destination location' in lower(message)) = 0 then raise exception 'Non-stock destination was accepted: %', message; end if;

  blocked := false; message := null;
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000005',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'inactive-dest-01',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":1,"unit":"each"}]', ''
    );
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked then raise exception 'Inactive destination was accepted'; end if;

  blocked := false; message := null;
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000007',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'cross-warehouse1',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":1,"unit":"each"}]', ''
    );
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked then raise exception 'Cross-warehouse destination was accepted'; end if;

  blocked := false; message := null;
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'insufficient-0001',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":13,"unit":"each"}]', ''
    );
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('Insufficient inventory' in message) = 0 then raise exception 'Insufficient stock was not rejected: %', message; end if;

  if (select count(*) from inventory_transfers) <> before_count then raise exception 'Failed transfer left a header behind'; end if;
  if (select count(*) from inventory_movements where movement_role in ('transfer_source', 'transfer_destination')) <> 2 then raise exception 'Transfer movement pair is incomplete'; end if;
  if (select count(distinct lot_id) from inventory_movements where movement_role <> 'adjustment') <> 1 then raise exception 'Lot identity was not preserved'; end if;
  if (select count(*) from inventory_movements where movement_role <> 'adjustment' and pallet_id = '82000000-0000-0000-0000-000000000001') <> 2 then raise exception 'Pallet identity was not preserved'; end if;
  if (select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001') <> 12 then raise exception 'Source balance is wrong after put-away'; end if;
  if (select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000003' and product_id = '30000000-0000-0000-0000-000000000001') <> 8 then raise exception 'Destination balance is wrong after put-away'; end if;
  if (select sum(quantity) from inventory_location_balances where business_id = '10000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001' and lot_id = '83000000-0000-0000-0000-000000000001') <> 20 then raise exception 'Put-away did not conserve inventory'; end if;
end;
$$;

select execute_inventory_transfer(
  '10000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000003',
  '81000000-0000-0000-0000-000000000004',
  '82000000-0000-0000-0000-000000000001',
  'relocation', 'relocation-00001',
  '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":2,"unit":"each"}]',
  'Move two units to staging'
);

do $$ begin
  if (select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000003' and product_id = '30000000-0000-0000-0000-000000000001') <> 6 then raise exception 'Relocation source balance is wrong'; end if;
  if (select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000004' and product_id = '30000000-0000-0000-0000-000000000001') <> 2 then raise exception 'Relocation destination balance is wrong'; end if;
  if (select sum(quantity) from inventory_location_balances where business_id = '10000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001' and lot_id = '83000000-0000-0000-0000-000000000001') <> 20 then raise exception 'Relocation did not conserve inventory'; end if;
end $$;
reset role;
  `);
  pass("put-away creates paired lot- and pallet-aware movements and conserves inventory");
  pass("relocation preserves source, destination, lot, pallet, and total inventory");
  pass("invalid destinations, warehouse boundaries, and insufficient stock roll back fully");
  pass("duplicate transfer submissions cannot change stock twice");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);

insert into inventory_adjustment_requests (
  id, business_id, type, source_reference, corrects_transaction_id, reason, requested_by
)
select request_id, '10000000-0000-0000-0000-000000000001', 'correction', source_reference,
  (select id from inventory_transactions where request_id = '60000000-0000-0000-0000-000000000010'),
  reason, '20000000-0000-0000-0000-000000000002'
from (values
  ('60000000-0000-0000-0000-000000000012'::uuid, 'combined-negative-correction', 'Combined balance test'),
  ('60000000-0000-0000-0000-000000000013'::uuid, 'located-concurrent-correction', 'Located concurrency test'),
  ('60000000-0000-0000-0000-000000000014'::uuid, 'unlocated-concurrent-correction', 'Unlocated concurrency test')
) fixture(request_id, source_reference, reason);

insert into inventory_adjustment_lines (
  id, business_id, request_id, product_id, lot_id, original_quantity, original_unit,
  warehouse_id, location_id, pallet_id
) values
  ('70000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000005', null, -30, 'each', null, null, null),
  ('70000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000005', '83000000-0000-0000-0000-000000000002', -20, 'each', '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000005', '83000000-0000-0000-0000-000000000002', -20, 'each', '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-000000000016', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000014', '30000000-0000-0000-0000-000000000005', null, -30, 'each', null, null, null);

do $$
declare blocked boolean := false; message text;
begin
  begin
    perform approve_inventory_adjustment('60000000-0000-0000-0000-000000000012', 'combined-negative-key');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('cannot make inventory negative' in message) = 0 then
    raise exception 'Combined product-wide decrease was not rejected: %', message;
  end if;
  if exists (select 1 from inventory_transactions where request_id = '60000000-0000-0000-0000-000000000012') then
    raise exception 'Rejected combined correction left a transaction';
  end if;
end $$;
reset role;
  `);
  pass("combined located and unlocated correction lines cannot make product stock negative");

  const correctionSession = "set role authenticated; select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);";
  const [locatedCorrection, unlocatedCorrection] = await Promise.all([
    runPsqlAsync(`${correctionSession} select approve_inventory_adjustment('60000000-0000-0000-0000-000000000013', 'located-race-key');`),
    runPsqlAsync(`${correctionSession} select approve_inventory_adjustment('60000000-0000-0000-0000-000000000014', 'unlocated-race-key');`)
  ]);
  assert.equal(
    [locatedCorrection.status, unlocatedCorrection.status].filter((status) => status === 0).length,
    1,
    `Exactly one competing negative correction should succeed.\n${locatedCorrection.stdout}${locatedCorrection.stderr}${unlocatedCorrection.stdout}${unlocatedCorrection.stderr}`
  );
  runSql(String.raw`
do $$ begin
  if (select count(*) from inventory_transactions where request_id in ('60000000-0000-0000-0000-000000000013', '60000000-0000-0000-0000-000000000014')) <> 1 then raise exception 'Correction race created the wrong transaction count'; end if;
  if (select quantity from inventory_balances where product_id = '30000000-0000-0000-0000-000000000005') not in (14, 24) then raise exception 'Correction race produced an invalid product balance'; end if;
  if (select quantity from inventory_balances where product_id = '30000000-0000-0000-0000-000000000005') < 0 then raise exception 'Correction race made inventory negative'; end if;
end $$;
  `);
  pass("product-wide locks serialize located and unlocated negative corrections");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
insert into products (id, business_id, sku, name, base_unit)
values ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'ADMIN-CREATED', 'Administrator Product', 'L');

insert into business_invitations (id, business_id, email, role, token_hash, invited_by, expires_at)
values ('40000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'new-worker@example.test', 'worker', repeat('1', 64), '20000000-0000-0000-0000-000000000001', now() + interval '1 day');

select approve_inventory_adjustment('60000000-0000-0000-0000-000000000008', 'admin-key-0001');

do $$
declare blocked boolean := false; message text;
begin
  begin
    insert into product_unit_conversions (business_id, product_id, from_unit, to_base_factor, rule_source, created_by)
    values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'L', 1, 'metric', '20000000-0000-0000-0000-000000000001');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('Incompatible measurement families' in message) = 0 then raise exception 'Cross-family conversion was accepted: %', message; end if;

  blocked := false; message := null;
  begin
    update product_unit_conversions set to_base_factor = 0.002
    where business_id = '10000000-0000-0000-0000-000000000001'
      and product_id = '30000000-0000-0000-0000-000000000002'
      and from_unit = 'g';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('Invalid mass conversion rule' in message) = 0 then raise exception 'Invalid metric factor was accepted: %', message; end if;

  blocked := false;
  begin
    insert into business_invitations (business_id, email, role, token_hash, invited_by, expires_at, accepted_by, accepted_at)
    values ('10000000-0000-0000-0000-000000000001', 'preaccepted@example.test', 'worker', repeat('2', 64), '20000000-0000-0000-0000-000000000001', now() + interval '1 day', '20000000-0000-0000-0000-000000000006', now());
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Client pre-accepted an invitation'; end if;
end;
$$;
reset role;
  `);
  pass("Administrator product, invitation, and approval permissions work");
  pass("incompatible and invalid unit conversions are rejected");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000004', false);
do $$ begin
  if (select count(*) from businesses) <> 0 then raise exception 'Unaccepted invite granted access'; end if;
  if (select count(*) from products) <> 0 then raise exception 'Unaccepted invite exposed products'; end if;
end $$;

do $$
declare blocked boolean := false;
begin
  begin
    perform execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003',
      '82000000-0000-0000-0000-000000000001', 'putaway', 'pending-denied-1',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":1,"unit":"each"}]', ''
    );
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Pending member executed a transfer'; end if;
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000006', false);
do $$
declare blocked boolean := false;
begin
  if (select count(*) from businesses) <> 0 then raise exception 'Outsider saw a business'; end if;
  begin
    insert into business_memberships (business_id, user_id, role, status, invitation_id)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000006', 'worker', 'invited', '40000000-0000-0000-0000-000000000006');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Client inserted its own membership'; end if;
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', false);
do $$ begin
  if (select count(*) from businesses) <> 1 then raise exception 'Business B admin visibility failed'; end if;
  if (select count(*) from products) <> 1 then raise exception 'Business B product separation failed'; end if;
  if (select count(*) from inventory_transfers) <> 0 then raise exception 'Business B admin saw Business A transfers'; end if;
  if exists (select 1 from products where business_id = '10000000-0000-0000-0000-000000000001') then raise exception 'Business B admin saw Business A'; end if;
end $$;
reset role;
  `);
  pass("pending invitations and unaffiliated users receive no business access");
  pass("business data remains isolated for a second Administrator");

  const workerSession = "set role authenticated; select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);";
  const transferArguments = (destination, key) => `${workerSession} select execute_inventory_transfer(
    '10000000-0000-0000-0000-000000000001',
    '80000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001',
    '${destination}',
    '82000000-0000-0000-0000-000000000001',
    'putaway', '${key}',
    '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":8,"unit":"each"}]',
    'Concurrent put-away'
  );`;
  const [firstTransfer, secondTransfer] = await Promise.all([
    runPsqlAsync(transferArguments("81000000-0000-0000-0000-000000000003", "concurrent-move-1")),
    runPsqlAsync(transferArguments("81000000-0000-0000-0000-000000000004", "concurrent-move-2"))
  ]);
  assert.equal(
    [firstTransfer.status, secondTransfer.status].filter((status) => status === 0).length,
    1,
    `Exactly one concurrent transfer should succeed.\n${firstTransfer.stdout}${firstTransfer.stderr}${secondTransfer.stdout}${secondTransfer.stderr}`
  );

  runSql(String.raw`
do $$
declare blocked boolean := false; message text;
begin
  if (select count(*) from inventory_transfers) <> 3 then raise exception 'Concurrent transfer created the wrong header count'; end if;
  if (select count(*) from inventory_movements where movement_role in ('transfer_source', 'transfer_destination')) <> 6 then raise exception 'Concurrent transfer created the wrong movement count'; end if;
  if (select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001') <> 4 then raise exception 'Concurrent transfer overspent source inventory'; end if;
  if (select sum(quantity) from inventory_location_balances where business_id = '10000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001' and lot_id = '83000000-0000-0000-0000-000000000001') <> 20 then raise exception 'Concurrent transfer changed total inventory'; end if;

  begin
    update inventory_transfers set note = 'altered'
    where business_id = '10000000-0000-0000-0000-000000000001';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Transfer history was mutable: %', message; end if;

  blocked := false; message := null;
  begin
    delete from inventory_transfer_lines
    where business_id = '10000000-0000-0000-0000-000000000001';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Transfer line history was mutable: %', message; end if;
end;
$$;
  `);
  pass("concurrent transfers serialize source stock and exactly one oversubscribed move succeeds");
  pass("warehouse transfer headers and lines are immutable");

  const session = "set role authenticated; select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);";
  const [first, second] = await Promise.all([
    runPsqlAsync(`${session} select approve_inventory_adjustment('60000000-0000-0000-0000-000000000004', 'concurrent-key-0001');`),
    runPsqlAsync(`${session} select approve_inventory_adjustment('60000000-0000-0000-0000-000000000004', 'concurrent-key-0002');`)
  ]);
  assert.equal([first.status, second.status].filter((status) => status === 0).length, 1,
    `Exactly one concurrent approval should succeed.\n${first.stdout}${first.stderr}${second.stdout}${second.stderr}`);
  pass("simultaneous approvals apply inventory exactly once");

  runSql(String.raw`
do $$
declare blocked boolean := false; message text;
begin
  if (select count(*) from inventory_transactions where request_id = '60000000-0000-0000-0000-000000000004') <> 1 then raise exception 'Concurrent approval created wrong transaction count'; end if;
  if (select count(*) from inventory_movements movement join inventory_transactions transaction on transaction.id = movement.transaction_id where transaction.request_id = '60000000-0000-0000-0000-000000000004') <> 1 then raise exception 'Concurrent approval created wrong movement count'; end if;
  if (select quantity from inventory_balances where product_id = '30000000-0000-0000-0000-000000000001') <> 48 then raise exception 'Inventory balance was not updated exactly once'; end if;
  if (select normalized_quantity from inventory_movements where adjustment_line_id = '70000000-0000-0000-0000-000000000001') <> 20 then raise exception 'Damaged units were double-subtracted'; end if;
  if (select normalized_quantity from inventory_movements where adjustment_line_id = '70000000-0000-0000-0000-000000000002') <> 24 then raise exception 'Box conversion was incorrect'; end if;

  if exists (select 1 from inventory_transactions where request_id in ('60000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000005', '60000000-0000-0000-0000-000000000006', '60000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000009')) then raise exception 'Rejected or failed request created a transaction'; end if;
  if exists (select 1 from inventory_movements movement join inventory_adjustment_lines line on line.id = movement.adjustment_line_id where line.request_id in ('60000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000005', '60000000-0000-0000-0000-000000000006', '60000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000009')) then raise exception 'Rejected or failed request created movements'; end if;
  if (select count(*) from inventory_approval_events where request_id = '60000000-0000-0000-0000-000000000003' and decision = 'rejected' and reason = 'Inspection discrepancy') <> 1 then raise exception 'Rejection event was not recorded'; end if;
  if exists (select 1 from inventory_approval_events where request_id in ('60000000-0000-0000-0000-000000000005', '60000000-0000-0000-0000-000000000006', '60000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000009')) then raise exception 'Failed request created an approval event'; end if;

  begin
    update inventory_movements set original_quantity = original_quantity + 1 where adjustment_line_id = '70000000-0000-0000-0000-000000000001';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Movement history was mutable: %', message; end if;

  blocked := false; message := null;
  begin
    delete from inventory_transactions where request_id = '60000000-0000-0000-0000-000000000002';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Transaction history was mutable: %', message; end if;

  blocked := false; message := null;
  begin
    update inventory_approval_events set reason = 'altered' where request_id = '60000000-0000-0000-0000-000000000003';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Approval history was mutable: %', message; end if;
end;
$$;
  `);
  pass("usable quantities and explicit box conversions produce exact balances");
  pass("rejected and failed transactions leave no partial records");
  pass("transaction, movement, and approval history is immutable");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
insert into inventory_adjustment_requests (
  id, business_id, type, source_reference, corrects_transaction_id, reason, requested_by
) values (
  '60000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000001',
  'correction', 'transfer-correction-race',
  (select id from inventory_transactions where request_id = '60000000-0000-0000-0000-000000000001'),
  'Exact source lock race', '20000000-0000-0000-0000-000000000002'
);
insert into inventory_adjustment_lines (
  id, business_id, request_id, product_id, lot_id, original_quantity, original_unit,
  warehouse_id, location_id, pallet_id
) values (
  '70000000-0000-0000-0000-000000000017', '10000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000015', '30000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001', -4, 'each',
  '80000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001'
);
reset role;
  `);

  const [correctionAgainstSource, transferAgainstSource] = await Promise.all([
    runPsqlAsync(`${session} select approve_inventory_adjustment('60000000-0000-0000-0000-000000000015', 'source-correction-race');`),
    runPsqlAsync(`${workerSession} select execute_inventory_transfer(
      '10000000-0000-0000-0000-000000000001',
      '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000003',
      '82000000-0000-0000-0000-000000000001',
      'putaway', 'source-transfer-race',
      '[{"product_id":"30000000-0000-0000-0000-000000000001","lot_id":"83000000-0000-0000-0000-000000000001","quantity":4,"unit":"each"}]',
      'Competes with located correction'
    );`)
  ]);
  assert.equal(
    [correctionAgainstSource.status, transferAgainstSource.status].filter((status) => status === 0).length,
    1,
    `Exactly one source-decreasing operation should succeed.\n${correctionAgainstSource.stdout}${correctionAgainstSource.stderr}${transferAgainstSource.stdout}${transferAgainstSource.stderr}`
  );
  runSql(String.raw`
do $$ begin
  if coalesce((select quantity from inventory_location_balances where location_id = '81000000-0000-0000-0000-000000000001' and product_id = '30000000-0000-0000-0000-000000000001'), 0) <> 0 then raise exception 'Transfer/correction race did not consume the exact source once'; end if;
  if (select quantity from inventory_balances where product_id = '30000000-0000-0000-0000-000000000001') not in (44, 48) then raise exception 'Transfer/correction race produced an invalid total'; end if;
  if exists (select 1 from inventory_location_balances where quantity < 0) then raise exception 'Transfer/correction race made a location negative'; end if;
end $$;
  `);
  pass("transfers and located corrections share exact source locks");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
insert into new_product_reviews (
  id, business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
  measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
  low_stock_threshold, reorder_threshold, requested_by
) values
  ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'unknown-a', 'NEW-A', 'New A', 'Fresh Brand', 'Test Supplier',
   'each', 10, 2, 8, 3, 5, '20000000-0000-0000-0000-000000000003'),
  ('90000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'unknown-rejected', 'NEW-REJECT', 'Rejected Product', 'Reject Brand', 'Test Supplier',
   'each', 5, 0, 5, 1, 2, '20000000-0000-0000-0000-000000000003'),
  ('90000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'unknown-concurrent', 'NEW-CONCURRENT', 'Concurrent Product', 'Concurrent Brand', 'Test Supplier',
   'each', 6, 1, 5, 1, 2, '20000000-0000-0000-0000-000000000003'),
  ('90000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'unknown-failure', 'NEW-FAIL', 'Failed Product', 'Failure Brand', 'Test Supplier',
   'each', 4, 0, 4, 1, 2, '20000000-0000-0000-0000-000000000003');

do $$
declare blocked boolean := false; message text;
begin
  begin
    insert into new_product_reviews (
      business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
      measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
      low_stock_threshold, reorder_threshold, requested_by
    ) values (
      '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
      'unknown-a', 'DUPLICATE', 'Duplicate', 'Duplicate Brand', 'Test Supplier',
      'each', 1, 0, 1, 0, 0, '20000000-0000-0000-0000-000000000003'
    );
  exception when unique_violation then blocked := true;
  end;
  if not blocked then raise exception 'Duplicate unknown delivery line was accepted'; end if;

  blocked := false;
  begin
    insert into new_product_reviews (
      business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
      measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
      low_stock_threshold, reorder_threshold, requested_by
    ) values (
      '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
      'invalid-quantity', 'INVALID', 'Invalid', 'Invalid Brand', 'Test Supplier',
      'each', 1, 2, 1, 0, 0, '20000000-0000-0000-0000-000000000003'
    );
  exception when check_violation then blocked := true;
  end;
  if not blocked then raise exception 'Invalid accepted quantity was accepted'; end if;
end;
$$;
reset role;
  `);
  pass("unknown delivery lines persist with duplicate and invalid quantity checks");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
do $$
declare blocked boolean := false;
begin
  begin
    perform review_new_product('90000000-0000-0000-0000-000000000001', 'approve', 'Typed name only', 'new-product-unauthorized');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Worker approved a new product'; end if;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
select review_new_product('90000000-0000-0000-0000-000000000001', 'request_correction', 'Brand must match the supplier catalog.');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
select resubmit_new_product_review(
  '90000000-0000-0000-0000-000000000001', 'NEW-A', 'New A Corrected', 'Fresh Brand', 'each',
  10, 2, 8, 3, 5, 'Corrected product identity.'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
select review_new_product('90000000-0000-0000-0000-000000000001', 'approve', 'Verified by authenticated Supervisor.', 'new-product-a-0001');
select review_new_product('90000000-0000-0000-0000-000000000001', 'approve', 'Retry with the same key.', 'new-product-a-0001');
select review_new_product('90000000-0000-0000-0000-000000000003', 'reject', 'Supplier could not verify this catalog item.');
reset role;

do $$
declare blocked boolean := false; message text;
begin
  begin
    update new_product_review_events set reason = 'tampered'
    where review_id = '90000000-0000-0000-0000-000000000001';
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'New product audit history was mutable: %', message; end if;
  if (select count(*) from products where sku = 'NEW-A') <> 1 then raise exception 'New product was not created exactly once'; end if;
  if (select count(*) from inventory_transactions where idempotency_key = 'new-product-a-0001') <> 1 then raise exception 'New product posting was duplicated'; end if;
  if (select quantity from inventory_balances where product_id = (select id from products where sku = 'NEW-A')) <> 8 then raise exception 'Only accepted usable quantity was posted'; end if;
  if (select status from new_product_reviews where id = '90000000-0000-0000-0000-000000000001') <> 'approved' then raise exception 'Corrected new product was not approved'; end if;
  if (select count(*) from new_product_review_events where review_id = '90000000-0000-0000-0000-000000000001' and event_type in ('requested', 'correction_requested', 'resubmitted', 'approved')) <> 4 then raise exception 'New product audit trail is incomplete'; end if;
  if (select status from new_product_reviews where id = '90000000-0000-0000-0000-000000000003') <> 'rejected' then raise exception 'Rejected new product did not retain status'; end if;
  if exists (select 1 from products where sku = 'NEW-REJECT') then raise exception 'Rejected new product was created'; end if;
end;
$$;
  `);
  pass("authenticated new-product correction, approval, rejection, audit, and idempotency work");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', false);
do $$
declare blocked boolean := false;
begin
  if (select count(*) from new_product_reviews) <> 0 then raise exception 'Business B saw Business A new-product reviews'; end if;
  begin
    perform review_new_product('90000000-0000-0000-0000-000000000004', 'approve', 'Cross-tenant attempt.', 'cross-tenant-new-product');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Cross-tenant new-product approval was accepted'; end if;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
insert into new_product_reviews (
  id, business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
  measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
  low_stock_threshold, reorder_threshold, requested_by
) values (
  '90000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001', 'unknown-duplicate-product', 'NEW-A', 'Duplicate Product', 'Fresh Brand', 'Test Supplier',
  'each', 4, 0, 4, 1, 2, '20000000-0000-0000-0000-000000000003'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
do $$
declare blocked boolean := false;
begin
  begin
    perform review_new_product('90000000-0000-0000-0000-000000000006', 'approve', 'Duplicate product attempt.', 'duplicate-product-review');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Duplicate product approval was accepted'; end if;
end;
$$;
reset role;
  `);
  pass("cross-tenant access is denied and duplicate product creation is blocked");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  if (select count(*) from businesses) <> 0 then
    raise exception 'A session without a JWT subject could read tenant records';
  end if;
end;
$$;
reset role;
  `);
  pass("sessions without a verified JWT subject cannot read business data");

  runSql(String.raw`
reset role;
create table freshroute_test_ids (delivery_id uuid, replay_delivery_id uuid, review_id uuid, invitation_id uuid);
grant select, insert on freshroute_test_ids to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
do $$
declare blocked boolean := false;
begin
  begin
    perform record_receiving_delivery(
      '10000000-0000-0000-0000-000000000001',
      'commercial-duplicate-lines-001',
      '{"supplier":"Commercial Supplier","delivered_on":"2026-10-15"}'::jsonb,
      '[
        {"sku":"NEW-DUPLICATE","product_name":"Duplicate One","brand":"Duplicate Brand","total_units":2,"damaged_units":0},
        {"sku":"NEW-DUPLICATE","product_name":"Duplicate Two","brand":"Duplicate Brand","total_units":3,"damaged_units":0}
      ]'::jsonb
    );
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Duplicate commercial receiving lines were accepted'; end if;
  if exists (select 1 from receiving_deliveries where client_idempotency_key = 'commercial-duplicate-lines-001') then
    raise exception 'Duplicate receiving rejection left a delivery behind';
  end if;
end;
$$;
insert into freshroute_test_ids (delivery_id)
select (record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001',
  'commercial-receiving-key-001',
  '{"supplier":"Commercial Supplier","delivered_on":"2026-10-15","inspection_notes":"Server persistence test"}'::jsonb,
  '[
    {"sku":"A-EACH","product_name":"Business A Each Product","brand":"A Brand","total_boxes":2,"total_units":10,"units_per_box":5,"damaged_boxes":0,"damaged_units":2},
    {"sku":"NEW-SERVER","product_name":"Server New Product","brand":"Server Brand","total_boxes":1,"total_units":6,"units_per_box":6,"damaged_boxes":0,"damaged_units":1}
  ]'::jsonb
)->>'delivery_id')::uuid;
insert into freshroute_test_ids (replay_delivery_id)
select (record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001',
  'commercial-receiving-key-001',
  '{"supplier":"Commercial Supplier","delivered_on":"2026-10-15"}'::jsonb,
  '[]'::jsonb
)->>'delivery_id')::uuid;

do $$
declare blocked boolean := false; message text;
begin
  if (select delivery_id from freshroute_test_ids where delivery_id is not null limit 1) <> (select replay_delivery_id from freshroute_test_ids where replay_delivery_id is not null limit 1) then
    raise exception 'Receiving idempotency replay returned a different delivery';
  end if;
  if (select count(*) from receiving_deliveries where client_idempotency_key = 'commercial-receiving-key-001') <> 1 then
    raise exception 'Receiving idempotency created duplicate deliveries';
  end if;
  if (select count(*) from new_product_reviews where sku = 'NEW-SERVER') <> 1 then
    raise exception 'Unknown receiving SKU was not retained for review';
  end if;
  begin
    perform decide_receiving_delivery((select delivery_id from freshroute_test_ids where delivery_id is not null limit 1), 'approve', 'Worker must not approve', 'commercial-delivery-key-1');
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('Supervisor or Administrator' in message) = 0 then
    raise exception 'Worker delivery approval was not rejected: %', message;
  end if;
end $$;
reset role;
  `);
  pass("authenticated receiving persists known and unknown lines with idempotent replay");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
select record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001', 'expiration-fresh-0001',
  '{"supplier":"Expiration Supplier","delivered_on":"2026-10-15"}'::jsonb,
  '[{"sku":"A-EACH","product_name":"Business A Each Product","brand":"A Brand","total_units":10,"damaged_units":1,"lot_code":"LOT-FRESH-001","expiration_date": "2030-01-15"}]'::jsonb
);
select record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001', 'expiration-soon-0001',
  '{"supplier":"Expiration Supplier","delivered_on":"2026-10-15"}'::jsonb,
  jsonb_build_array(jsonb_build_object('sku','A-EACH','product_name','Business A Each Product','brand','A Brand','total_units',4,'damaged_units',0,'lot_code','LOT-SOON-001','expiration_date',(current_date + 3)::text))
);
select record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001', 'expiration-expired-001',
  '{"supplier":"Expiration Supplier","delivered_on":"2026-10-15"}'::jsonb,
  jsonb_build_array(jsonb_build_object('sku','A-EACH','product_name','Business A Each Product','brand','A Brand','total_units',5,'damaged_units',0,'lot_code','LOT-EXPIRED-001','expiration_date',(current_date - 1)::text))
);
select record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001', 'expiration-new-product-1',
  '{"supplier":"Expiration Supplier","delivered_on":"2026-10-15"}'::jsonb,
  '[{"sku":"NEW-LOT-001","product_name":"New Lot Product","brand":"Lot Brand","total_units":6,"damaged_units":1,"lot_code":"LOT-NEW-001","expiration_date": "2030-02-20"}]'::jsonb
);
select record_receiving_delivery(
  '10000000-0000-0000-0000-000000000001', 'expiration-new-expired-1',
  '{"supplier":"Expiration Supplier","delivered_on":"2026-10-15"}'::jsonb,
  jsonb_build_array(jsonb_build_object('sku','NEW-EXPIRED-001','product_name','Expired New Product','brand','Lot Brand','total_units',6,'damaged_units',0,'lot_code','LOT-NEW-EXPIRED-001','expiration_date',(current_date - 1)::text))
);
do $$
declare blocked boolean := false;
begin
  if (select count(*) from inventory_lots where lot_code in ('LOT-FRESH-001', 'LOT-SOON-001', 'LOT-EXPIRED-001')) <> 3 then
    raise exception 'Receiving did not create every known-product lot';
  end if;
  if (select count(distinct expiration_date) from inventory_lots where product_id = '30000000-0000-0000-0000-000000000001' and lot_code in ('LOT-FRESH-001', 'LOT-SOON-001')) <> 2 then
    raise exception 'Different expiration dates were collapsed for one product';
  end if;
  if (select count(*) from receiving_items item join inventory_lots lot on lot.business_id = item.business_id and lot.id = item.lot_id where item.delivery_id = (select id from receiving_deliveries where client_idempotency_key = 'expiration-fresh-0001') and lot.lot_code = 'LOT-FRESH-001') <> 1 then
    raise exception 'Known receiving item did not retain its lot';
  end if;
  if (select count(*) from new_product_reviews where lot_code = 'LOT-NEW-001') <> 1 then
    raise exception 'Unknown receiving item did not retain its lot';
  end if;
  begin
    perform update_product_expiration_warning('30000000-0000-0000-0000-000000000001', 5);
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Worker changed a product expiration policy'; end if;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
select decide_receiving_delivery((select id from receiving_deliveries where client_idempotency_key = 'expiration-fresh-0001'), 'approve', 'Fresh lot verified.', 'expiration-approval-fresh-1');
select decide_receiving_delivery((select id from receiving_deliveries where client_idempotency_key = 'expiration-soon-0001'), 'approve', 'Soon-expiring lot verified.', 'expiration-approval-soon-1');
select review_new_product((select id from new_product_reviews where lot_code = 'LOT-NEW-001'), 'approve', 'New product and lot verified.', 'expiration-new-review-1');
do $$
declare blocked boolean := false;
begin
  begin
    perform review_new_product((select id from new_product_reviews where lot_code = 'LOT-NEW-EXPIRED-001'), 'approve', 'Expired new lot must be blocked.', 'expiration-new-expired-review-1');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Expired new-product lot was approved as usable inventory'; end if;
  if exists (select 1 from products where sku = 'NEW-EXPIRED-001') then
    raise exception 'Expired new-product approval left a product behind';
  end if;
  blocked := false;
  begin
    perform decide_receiving_delivery((select id from receiving_deliveries where client_idempotency_key = 'expiration-expired-001'), 'approve', 'Expired lot must be blocked.', 'expiration-approval-expired-1');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Expired lot was approved as usable inventory'; end if;
  if exists (select 1 from inventory_transactions transaction join inventory_adjustment_requests request on request.business_id = transaction.business_id and request.id = transaction.request_id where request.source_reference = 'receiving-delivery:' || (select id::text from receiving_deliveries where client_idempotency_key = 'expiration-expired-001')) then
    raise exception 'Expired delivery created an inventory transaction';
  end if;
  if (select count(*) from inventory_movements movement join inventory_lots lot on lot.business_id = movement.business_id and lot.id = movement.lot_id where lot.lot_code = 'LOT-NEW-001') <> 1 then
    raise exception 'Approved new product did not post one lot-aware movement';
  end if;
  if (select quantity from inventory_lot_balances where lot_code = 'LOT-FRESH-001') <> 9 then
    raise exception 'Fresh lot quantity did not preserve usable units';
  end if;
  if (select quantity from inventory_lot_balances where lot_code = 'LOT-SOON-001') <> 4 then
    raise exception 'Soon-expiring lot quantity was not tracked';
  end if;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
select update_product_expiration_warning('30000000-0000-0000-0000-000000000001', 5);
do $$
begin
  if (select expiration_warning_days from products where id = '30000000-0000-0000-0000-000000000001') <> 5 then
    raise exception 'Administrator warning period was not saved';
  end if;
  if (select count(*) from inventory_lot_balances where product_id = '30000000-0000-0000-0000-000000000001' and expiration_date = current_date + 3 and quantity > 0) <> 1 then
    raise exception 'Expiring-soon lot was not identified by date and quantity';
  end if;
end;
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', false);
do $$
declare blocked boolean := false;
begin
  begin
    perform update_product_expiration_warning('30000000-0000-0000-0000-000000000001', 30);
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Business B changed Business A expiration policy'; end if;
end;
$$;
reset role;
  `);
  pass("commercial lots preserve quantities and dates, block expired approval, and enforce warning permissions");

  runSql(String.raw`
insert into freshroute_test_ids (review_id)
select id
from new_product_reviews
where sku = 'NEW-SERVER';
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
select review_new_product((select review_id from freshroute_test_ids where review_id is not null limit 1), 'approve', 'Verified by the authenticated supervisor.', 'commercial-new-product-key-1');
select decide_receiving_delivery((select delivery_id from freshroute_test_ids where delivery_id is not null limit 1), 'approve', 'Verified commercial delivery.', 'commercial-delivery-key-1');
select decide_receiving_delivery((select delivery_id from freshroute_test_ids where delivery_id is not null limit 1), 'approve', 'Safe retry.', 'commercial-delivery-key-1');
reset role;

do $$
declare blocked boolean := false; message text;
begin
  if (select count(*) from products where sku = 'NEW-SERVER') <> 1 then raise exception 'Server new product was not created once'; end if;
  if (select quantity from inventory_balances where product_id = (select id from products where sku = 'NEW-SERVER')) <> 5 then raise exception 'Server new product posted the wrong accepted quantity'; end if;
  if (select count(*) from inventory_transactions where idempotency_key = 'commercial-delivery-key-1') <> 1 then raise exception 'Known receiving line was posted more than once'; end if;
  if jsonb_array_length(list_receiving_records('10000000-0000-0000-0000-000000000001')) = 0 then raise exception 'Saved commercial receiving records were not readable'; end if;
  begin
    update receiving_delivery_events set reason = 'tampered' where delivery_id = (select delivery_id from freshroute_test_ids where delivery_id is not null limit 1);
  exception when others then blocked := true; message := sqlerrm;
  end;
  if not blocked or position('append-only' in message) = 0 then raise exception 'Receiving audit history was mutable: %', message; end if;
end $$;
  `);
  pass("authenticated review and delivery decisions post only accepted stock once and keep immutable audit history");

  runSql(String.raw`
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
select create_business_invitation(
  '10000000-0000-0000-0000-000000000001', 'invited-commercial@example.test', 'worker',
  encode(digest('commercial-invite-token', 'sha256'), 'hex')
);
insert into freshroute_test_ids (invitation_id)
select id from business_invitations where email = 'invited-commercial@example.test';
reset role;
insert into app_users (id, email, display_name)
values ('20000000-0000-0000-0000-000000000007', 'invited-commercial@example.test', 'Invited Commercial');
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000007', false);
select set_config('request.jwt.claim.email', 'different-account@example.test', false);
do $$
declare blocked boolean := false;
begin
  begin
    perform accept_business_invitation(
      (select invitation_id from freshroute_test_ids where invitation_id is not null limit 1),
      'commercial-invite-token', 'invited-commercial@example.test', 'Invited Commercial'
    );
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Invitation accepted with an untrusted email claim'; end if;
end;
$$;
select set_config('request.jwt.claim.email', 'invited-commercial@example.test', false);
select accept_business_invitation(
  (select invitation_id from freshroute_test_ids where invitation_id is not null limit 1),
  'commercial-invite-token', 'invited-commercial@example.test', 'Invited Commercial'
);
do $$ begin
  if (select count(*) from businesses) <> 1 then raise exception 'Accepted invite did not grant business access'; end if;
  if (select role from business_memberships where user_id = '20000000-0000-0000-0000-000000000007') <> 'worker' then raise exception 'Accepted invite role was not preserved'; end if;
end $$;
reset role;
  `);
  pass("administrator invitations require token acceptance before a worker membership becomes active");

  const newProductSession = "set role authenticated; select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);";
  const [newProductFirst, newProductSecond] = await Promise.all([
    runPsqlAsync(`${newProductSession} select review_new_product('90000000-0000-0000-0000-000000000004', 'approve', 'Concurrent review one.', 'new-product-concurrent-1');`),
    runPsqlAsync(`${newProductSession} select review_new_product('90000000-0000-0000-0000-000000000004', 'approve', 'Concurrent review two.', 'new-product-concurrent-2');`)
  ]);
  assert.equal(
    [newProductFirst.status, newProductSecond.status].filter((status) => status === 0).length,
    1,
    `Exactly one concurrent new-product approval should succeed.\n${newProductFirst.stdout}${newProductFirst.stderr}${newProductSecond.stdout}${newProductSecond.stderr}`
  );
  runSql(String.raw`
do $$
declare blocked boolean := false;
begin
  if (select count(*) from products where sku = 'NEW-CONCURRENT') <> 1 then raise exception 'Concurrent approval created duplicate products'; end if;
  if (select count(*) from inventory_transactions where request_id = (select id from inventory_adjustment_requests where source_reference like 'new-product-review:90000000-0000-0000-0000-000000000004')) <> 1 then raise exception 'Concurrent approval created duplicate transactions'; end if;
  begin
    perform review_new_product('90000000-0000-0000-0000-000000000005', 'approve', 'Failure should roll back.', 'admin-key-0001');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'Transaction failure did not fail'; end if;
  if exists (select 1 from products where sku = 'NEW-FAIL') then raise exception 'Failed new-product transaction left a product'; end if;
  if (select status from new_product_reviews where id = '90000000-0000-0000-0000-000000000005') <> 'pending' then raise exception 'Failed new-product transaction changed review status'; end if;
end;
$$;
  `);
  pass("concurrent new-product approvals serialize and failed posting rolls back atomically");

  console.log(`\n${checks} PostgreSQL integration checks passed.`);
}

try {
  await run();
} finally {
  cleanup();
}
