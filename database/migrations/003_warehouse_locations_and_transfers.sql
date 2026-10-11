-- FreshRoute warehouse, location, pallet, and internal-transfer foundation.
-- This migration is additive. Existing adjustment rows remain valid as unlocated legacy history.

-- PostgreSQL requires a newly added enum value to be committed before it can be used.
alter type adjustment_type add value if not exists 'transfer';

begin;

create type warehouse_location_kind as enum ('area', 'zone', 'aisle', 'rack', 'shelf', 'bin');
create type warehouse_location_purpose as enum ('receiving', 'staging', 'storage', 'quarantine', 'shipping');
create type pallet_status as enum ('active', 'held', 'closed');
create type warehouse_transfer_type as enum ('putaway', 'relocation');
create type inventory_movement_role as enum ('adjustment', 'transfer_source', 'transfer_destination');

alter table inventory_lots
  add constraint inventory_lots_product_identity_unique
  unique (business_id, product_id, id);

create table warehouses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  code text not null check (length(trim(code)) between 1 and 40),
  name text not null check (length(trim(name)) between 1 and 160),
  active boolean not null default true,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create unique index warehouses_business_code_case_insensitive_unique
  on warehouses (business_id, lower(code));

create function prevent_warehouse_scope_change()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.business_id <> old.business_id then
    raise exception 'Warehouse identity and business ownership cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger warehouse_scope_is_immutable
before update on warehouses
for each row execute function prevent_warehouse_scope_change();

create table warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  warehouse_id uuid not null,
  parent_location_id uuid,
  code text not null check (length(trim(code)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 160),
  kind warehouse_location_kind not null,
  purpose warehouse_location_purpose not null,
  accepts_inventory boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, warehouse_id)
    references warehouses(business_id, id) on delete restrict,
  unique (business_id, warehouse_id, id),
  foreign key (business_id, warehouse_id, parent_location_id)
    references warehouse_locations(business_id, warehouse_id, id) on delete restrict
);

create unique index warehouse_locations_code_case_insensitive_unique
  on warehouse_locations (business_id, warehouse_id, lower(code));
create index warehouse_locations_by_parent
  on warehouse_locations (business_id, warehouse_id, parent_location_id);

create function validate_warehouse_location_hierarchy()
returns trigger
language plpgsql
as $$
declare
  parent_kind warehouse_location_kind;
  parent_purpose warehouse_location_purpose;
  parent_rank integer;
  current_rank integer;
begin
  current_rank := case new.kind
    when 'area' then 1 when 'zone' then 2 when 'aisle' then 3
    when 'rack' then 4 when 'shelf' then 5 when 'bin' then 6
  end;

  if new.parent_location_id is null then
    if new.kind <> 'area' then
      raise exception 'A top-level warehouse location must be an area.';
    end if;
  else
    select location.kind, location.purpose,
      case location.kind
        when 'area' then 1 when 'zone' then 2 when 'aisle' then 3
        when 'rack' then 4 when 'shelf' then 5 when 'bin' then 6
      end
    into parent_kind, parent_purpose, parent_rank
    from warehouse_locations location
    where location.business_id = new.business_id
      and location.warehouse_id = new.warehouse_id
      and location.id = new.parent_location_id;

    if not found then raise exception 'The parent location does not belong to this warehouse.'; end if;
    if parent_purpose <> new.purpose then
      raise exception 'A child location must use the same operational purpose as its parent.';
    end if;
    if parent_rank >= current_rank then
      raise exception 'Location hierarchy must progress from area toward bin.';
    end if;
  end if;

  if tg_op = 'UPDATE' and exists (
    select 1 from warehouse_locations child
    where child.business_id = old.business_id
      and child.warehouse_id = old.warehouse_id
      and child.parent_location_id = old.id
      and (
        child.purpose <> new.purpose or
        case child.kind
          when 'area' then 1 when 'zone' then 2 when 'aisle' then 3
          when 'rack' then 4 when 'shelf' then 5 when 'bin' then 6
        end <= current_rank
      )
  ) then
    raise exception 'This change would invalidate a child location.';
  end if;

  return new;
end;
$$;

create trigger warehouse_location_hierarchy_is_valid
before insert or update on warehouse_locations
for each row execute function validate_warehouse_location_hierarchy();

create function prevent_location_scope_change()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or
     new.business_id <> old.business_id or
     new.warehouse_id <> old.warehouse_id then
    raise exception 'Location identity, business, and warehouse cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger warehouse_location_scope_is_immutable
before update on warehouse_locations
for each row execute function prevent_location_scope_change();

create table pallets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  warehouse_id uuid not null,
  lpn text not null check (length(trim(lpn)) between 1 and 100),
  status pallet_status not null default 'active',
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (business_id, warehouse_id)
    references warehouses(business_id, id) on delete restrict,
  unique (business_id, id),
  unique (business_id, warehouse_id, id),
  check ((status = 'closed') = (closed_at is not null))
);

create unique index pallets_business_lpn_case_insensitive_unique
  on pallets (business_id, lower(lpn));
create index pallets_by_warehouse
  on pallets (business_id, warehouse_id, status, created_at);

create table inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  warehouse_id uuid not null,
  type warehouse_transfer_type not null,
  source_location_id uuid not null,
  destination_location_id uuid not null,
  pallet_id uuid,
  idempotency_key text not null check (length(trim(idempotency_key)) between 8 and 200),
  note text not null default '' check (length(note) <= 1000),
  performed_by uuid not null references app_users(id),
  performed_at timestamptz not null default now(),
  foreign key (business_id, warehouse_id)
    references warehouses(business_id, id) on delete restrict,
  foreign key (business_id, warehouse_id, source_location_id)
    references warehouse_locations(business_id, warehouse_id, id) on delete restrict,
  foreign key (business_id, warehouse_id, destination_location_id)
    references warehouse_locations(business_id, warehouse_id, id) on delete restrict,
  foreign key (business_id, warehouse_id, pallet_id)
    references pallets(business_id, warehouse_id, id) on delete restrict,
  unique (business_id, id),
  unique (business_id, idempotency_key),
  check (source_location_id <> destination_location_id)
);

create table inventory_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  transfer_id uuid not null,
  line_number integer not null check (line_number > 0),
  product_id uuid not null,
  lot_id uuid,
  original_quantity numeric(30, 6) not null check (original_quantity > 0),
  original_unit unit_code not null,
  conversion_factor numeric(30, 12) not null check (conversion_factor > 0),
  normalized_quantity numeric(30, 12) not null check (normalized_quantity > 0),
  normalized_unit unit_code not null check (normalized_unit not in ('boxes', 'cases')),
  created_at timestamptz not null default now(),
  foreign key (business_id, transfer_id)
    references inventory_transfers(business_id, id) on delete restrict,
  foreign key (business_id, product_id)
    references products(business_id, id) on delete restrict,
  foreign key (business_id, lot_id)
    references inventory_lots(business_id, id) on delete restrict,
  foreign key (business_id, product_id, lot_id)
    references inventory_lots(business_id, product_id, id) on delete restrict,
  unique (business_id, id),
  unique (business_id, transfer_id, line_number),
  check (
    original_unit not in ('each', 'boxes', 'cases') or
    original_quantity = trunc(original_quantity)
  )
);

alter table inventory_adjustment_lines
  add column warehouse_id uuid,
  add column location_id uuid,
  add column pallet_id uuid,
  add constraint adjustment_lines_warehouse_fk
    foreign key (business_id, warehouse_id) references warehouses(business_id, id) on delete restrict,
  add constraint adjustment_lines_location_fk
    foreign key (business_id, warehouse_id, location_id)
    references warehouse_locations(business_id, warehouse_id, id) on delete restrict,
  add constraint adjustment_lines_pallet_fk
    foreign key (business_id, warehouse_id, pallet_id)
    references pallets(business_id, warehouse_id, id) on delete restrict,
  add constraint adjustment_lines_product_lot_fk
    foreign key (business_id, product_id, lot_id)
    references inventory_lots(business_id, product_id, id) on delete restrict,
  add constraint adjustment_lines_location_context_check check (
    (warehouse_id is null and location_id is null and pallet_id is null) or
    (warehouse_id is not null and location_id is not null)
  );

alter table inventory_transactions
  add column transfer_id uuid,
  alter column request_id drop not null,
  add constraint inventory_transactions_transfer_fk
    foreign key (business_id, transfer_id)
    references inventory_transfers(business_id, id) on delete restrict,
  add constraint inventory_transactions_one_source_check check (
    (request_id is not null and transfer_id is null and type <> 'transfer') or
    (request_id is null and transfer_id is not null and type = 'transfer')
  ),
  add constraint inventory_transactions_transfer_unique unique (business_id, transfer_id);

alter table inventory_movements
  add column warehouse_id uuid,
  add column location_id uuid,
  add column pallet_id uuid,
  add column transfer_line_id uuid,
  add column movement_role inventory_movement_role not null default 'adjustment',
  alter column adjustment_line_id drop not null,
  add constraint inventory_movements_warehouse_fk
    foreign key (business_id, warehouse_id) references warehouses(business_id, id) on delete restrict,
  add constraint inventory_movements_location_fk
    foreign key (business_id, warehouse_id, location_id)
    references warehouse_locations(business_id, warehouse_id, id) on delete restrict,
  add constraint inventory_movements_pallet_fk
    foreign key (business_id, warehouse_id, pallet_id)
    references pallets(business_id, warehouse_id, id) on delete restrict,
  add constraint inventory_movements_transfer_line_fk
    foreign key (business_id, transfer_line_id)
    references inventory_transfer_lines(business_id, id) on delete restrict,
  add constraint inventory_movements_product_lot_fk
    foreign key (business_id, product_id, lot_id)
    references inventory_lots(business_id, product_id, id) on delete restrict,
  add constraint inventory_movements_location_context_check check (
    (warehouse_id is null and location_id is null and pallet_id is null) or
    (warehouse_id is not null and location_id is not null)
  ),
  add constraint inventory_movements_source_check check (
    (movement_role = 'adjustment' and adjustment_line_id is not null and transfer_line_id is null) or
    (movement_role in ('transfer_source', 'transfer_destination') and adjustment_line_id is null and transfer_line_id is not null)
  ),
  add constraint inventory_movements_transfer_role_unique
    unique (transaction_id, transfer_line_id, movement_role);

create index inventory_movements_by_location_stock
  on inventory_movements (
    business_id, warehouse_id, location_id, product_id, lot_id, pallet_id, occurred_at
  ) where warehouse_id is not null;
create index inventory_transfers_by_pallet
  on inventory_transfers (business_id, warehouse_id, pallet_id, performed_at)
  where pallet_id is not null;

create view inventory_location_balances
with (security_invoker = true) as
select
  movement.business_id,
  movement.warehouse_id,
  movement.location_id,
  movement.product_id,
  movement.lot_id,
  movement.pallet_id,
  movement.normalized_unit,
  sum(movement.normalized_quantity)::numeric(30, 12) as quantity
from inventory_movements movement
where movement.warehouse_id is not null and movement.location_id is not null
group by
  movement.business_id, movement.warehouse_id, movement.location_id,
  movement.product_id, movement.lot_id, movement.pallet_id, movement.normalized_unit
having sum(movement.normalized_quantity) <> 0;

create function app_private.inventory_stock_lock_key(
  target_business_id uuid,
  target_warehouse_id uuid,
  target_location_id uuid,
  target_product_id uuid,
  target_lot_id uuid,
  target_pallet_id uuid
)
returns bigint
language sql
immutable
set search_path = pg_catalog
as $$
  select hashtextextended(
    concat_ws('|',
      'inventory-stock',
      target_business_id::text,
      coalesce(target_warehouse_id::text, '*'),
      coalesce(target_location_id::text, '*'),
      target_product_id::text,
      coalesce(target_lot_id::text, '*'),
      coalesce(target_pallet_id::text, '*')
    ),
    0
  )
$$;

create function app_private.warehouse_metadata_lock_key(
  target_business_id uuid,
  target_warehouse_id uuid
)
returns bigint
language sql
immutable
set search_path = pg_catalog
as $$
  select hashtextextended(
    concat_ws('|', 'warehouse-metadata', target_business_id::text, target_warehouse_id::text),
    0
  )
$$;

create function app_private.lock_warehouse_metadata_change()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  target_business_id uuid := old.business_id;
  target_warehouse_id uuid;
begin
  target_warehouse_id := case
    when tg_table_name = 'warehouses' then old.id
    else old.warehouse_id
  end;
  perform pg_advisory_xact_lock(
    app_private.warehouse_metadata_lock_key(target_business_id, target_warehouse_id)
  );
  return new;
end;
$$;

create trigger warehouse_metadata_updates_are_serialized
before update on warehouses
for each row execute function app_private.lock_warehouse_metadata_change();

create trigger location_metadata_updates_are_serialized
before update on warehouse_locations
for each row execute function app_private.lock_warehouse_metadata_change();

create trigger pallet_metadata_updates_are_serialized
before update on pallets
for each row execute function app_private.lock_warehouse_metadata_change();

create function app_private.location_is_operational(
  target_business_id uuid,
  target_warehouse_id uuid,
  target_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive ancestry as (
    select location.id, location.parent_location_id, location.active
    from warehouse_locations location
    where location.business_id = target_business_id
      and location.warehouse_id = target_warehouse_id
      and location.id = target_location_id
    union all
    select parent.id, parent.parent_location_id, parent.active
    from warehouse_locations parent
    join ancestry child on child.parent_location_id = parent.id
    where parent.business_id = target_business_id
      and parent.warehouse_id = target_warehouse_id
  )
  select exists (select 1 from ancestry) and coalesce(bool_and(active), false)
  from ancestry
$$;

revoke all on function app_private.inventory_stock_lock_key(uuid, uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function app_private.warehouse_metadata_lock_key(uuid, uuid) from public;
revoke all on function app_private.lock_warehouse_metadata_change() from public;
revoke all on function app_private.location_is_operational(uuid, uuid, uuid) from public;

create or replace function approve_inventory_adjustment(target_request_id uuid, request_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  adjustment inventory_adjustment_requests%rowtype;
  transaction_id uuid := gen_random_uuid();
  line_count integer;
  converted_count integer;
  stock record;
  available_quantity numeric(30, 12);
begin
  select * into adjustment
  from inventory_adjustment_requests
  where id = target_request_id
  for update;

  if not found then raise exception 'Adjustment request not found.'; end if;
  if not app_private.has_business_role(
    adjustment.business_id,
    array['supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'Supervisor or Administrator permission is required.';
  end if;
  if adjustment.status <> 'pending' then raise exception 'This adjustment already has a decision.'; end if;

  select count(*) into line_count
  from inventory_adjustment_lines line
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;

  select count(*) into converted_count
  from inventory_adjustment_lines line
  join products product
    on product.business_id = line.business_id and product.id = line.product_id
  join product_unit_conversions conversion
    on conversion.business_id = line.business_id
    and conversion.product_id = line.product_id
    and conversion.from_unit = line.original_unit
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;

  if line_count = 0 or converted_count <> line_count then
    raise exception 'Every adjustment line requires one explicit conversion rule.';
  end if;

  -- Share the warehouse metadata lock while validating and recording located
  -- adjustments. Administrative deactivation/status changes take it exclusively.
  for stock in
    select distinct line.warehouse_id
    from inventory_adjustment_lines line
    where line.business_id = adjustment.business_id
      and line.request_id = adjustment.id
      and line.warehouse_id is not null
    order by line.warehouse_id
  loop
    perform pg_advisory_xact_lock_shared(
      app_private.warehouse_metadata_lock_key(adjustment.business_id, stock.warehouse_id)
    );
  end loop;

  if exists (
    select 1
    from inventory_adjustment_lines line
    join warehouses warehouse
      on warehouse.business_id = line.business_id and warehouse.id = line.warehouse_id
    join warehouse_locations location
      on location.business_id = line.business_id
      and location.warehouse_id = line.warehouse_id
      and location.id = line.location_id
    left join pallets pallet
      on pallet.business_id = line.business_id
      and pallet.warehouse_id = line.warehouse_id
      and pallet.id = line.pallet_id
    where line.business_id = adjustment.business_id
      and line.request_id = adjustment.id
      and line.location_id is not null
      and (
        not warehouse.active or
        not location.accepts_inventory or
        not app_private.location_is_operational(line.business_id, line.warehouse_id, line.location_id) or
        (line.pallet_id is not null and (pallet.id is null or pallet.status <> 'active'))
      )
  ) then
    raise exception 'Located adjustments require an active warehouse, operational inventory location, and active pallet.';
  end if;

  if adjustment.type <> 'correction' and exists (
    select 1 from inventory_adjustment_lines line
    where line.business_id = adjustment.business_id
      and line.request_id = adjustment.id
      and line.original_quantity < 0
  ) then
    raise exception 'Only corrections may use negative quantities.';
  end if;

  if adjustment.type = 'correction' then
    -- Serialize every stock-decreasing correction for a product, then verify the
    -- combined request delta against the product-wide balance. This protects
    -- located and legacy unlocated corrections from racing each other.
    for stock in
      select
        line.product_id,
        sum(line.original_quantity * conversion.to_base_factor)::numeric(30, 12) as delta
      from inventory_adjustment_lines line
      join product_unit_conversions conversion
        on conversion.business_id = line.business_id
        and conversion.product_id = line.product_id
        and conversion.from_unit = line.original_unit
      where line.business_id = adjustment.business_id
        and line.request_id = adjustment.id
      group by line.product_id
      having bool_or(line.original_quantity < 0)
      order by line.product_id::text
    loop
      perform pg_advisory_xact_lock(app_private.inventory_stock_lock_key(
        adjustment.business_id, null, null, stock.product_id, null, null
      ));

      select coalesce(balance.quantity, 0) into available_quantity
      from inventory_balances balance
      where balance.business_id = adjustment.business_id
        and balance.product_id = stock.product_id;

      if coalesce(available_quantity, 0) + stock.delta < 0 then
        raise exception 'A correction cannot make inventory negative.';
      end if;
    end loop;

    -- Located corrections also share the exact source lock used by transfers.
    -- Group the complete request at each source so positive and negative lines
    -- in the same correction are evaluated atomically as one net change.
    for stock in
      select
        line.warehouse_id, line.location_id, line.product_id, line.lot_id, line.pallet_id,
        sum(line.original_quantity * conversion.to_base_factor)::numeric(30, 12) as delta
      from inventory_adjustment_lines line
      join product_unit_conversions conversion
        on conversion.business_id = line.business_id
        and conversion.product_id = line.product_id
        and conversion.from_unit = line.original_unit
      where line.business_id = adjustment.business_id
        and line.request_id = adjustment.id
      group by line.warehouse_id, line.location_id, line.product_id, line.lot_id, line.pallet_id
      having bool_or(line.original_quantity < 0)
      order by
        coalesce(line.warehouse_id::text, ''), coalesce(line.location_id::text, ''),
        line.product_id::text, coalesce(line.lot_id::text, ''), coalesce(line.pallet_id::text, '')
    loop
      perform pg_advisory_xact_lock(app_private.inventory_stock_lock_key(
        adjustment.business_id, stock.warehouse_id, stock.location_id,
        stock.product_id, stock.lot_id, stock.pallet_id
      ));

      if stock.location_id is not null then
        select coalesce(sum(movement.normalized_quantity), 0) into available_quantity
        from inventory_movements movement
        where movement.business_id = adjustment.business_id
          and movement.warehouse_id = stock.warehouse_id
          and movement.location_id = stock.location_id
          and movement.product_id = stock.product_id
          and movement.lot_id is not distinct from stock.lot_id
          and movement.pallet_id is not distinct from stock.pallet_id;
        if coalesce(available_quantity, 0) + stock.delta < 0 then
          raise exception 'A correction cannot make inventory negative at its warehouse location.';
        end if;
      end if;
    end loop;
  end if;

  insert into inventory_transactions (
    id, business_id, request_id, idempotency_key, type,
    corrects_transaction_id, approved_by
  ) values (
    transaction_id, adjustment.business_id, adjustment.id,
    trim(request_idempotency_key), adjustment.type,
    adjustment.corrects_transaction_id, app_private.current_user_id()
  );

  insert into inventory_movements (
    business_id, transaction_id, adjustment_line_id, product_id, lot_id,
    original_quantity, original_unit, conversion_factor,
    normalized_quantity, normalized_unit,
    warehouse_id, location_id, pallet_id
  )
  select
    line.business_id, transaction_id, line.id, line.product_id, line.lot_id,
    line.original_quantity, line.original_unit, conversion.to_base_factor,
    line.original_quantity * conversion.to_base_factor, product.base_unit,
    line.warehouse_id, line.location_id, line.pallet_id
  from inventory_adjustment_lines line
  join products product
    on product.business_id = line.business_id and product.id = line.product_id
  join product_unit_conversions conversion
    on conversion.business_id = line.business_id
    and conversion.product_id = line.product_id
    and conversion.from_unit = line.original_unit
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;

  update inventory_adjustment_requests set status = 'approved' where id = adjustment.id;
  insert into inventory_approval_events (business_id, request_id, decision, decided_by)
  values (adjustment.business_id, adjustment.id, 'approved', app_private.current_user_id());
  return transaction_id;
exception
  when unique_violation then
    raise exception 'This adjustment or idempotency key was already applied.';
end;
$$;

create function execute_inventory_transfer(
  target_business_id uuid,
  target_warehouse_id uuid,
  source_location_id uuid,
  destination_location_id uuid,
  target_pallet_id uuid,
  requested_transfer_type warehouse_transfer_type,
  request_idempotency_key text,
  requested_lines jsonb,
  transfer_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  generated_transfer_id uuid := gen_random_uuid();
  generated_transaction_id uuid := gen_random_uuid();
  source_location warehouse_locations%rowtype;
  destination_location warehouse_locations%rowtype;
  stock record;
  available_quantity numeric(30, 12);
  requested_line_count integer;
  stored_line_count integer;
begin
  if not app_private.has_business_role(
    target_business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'An active warehouse membership is required.';
  end if;
  if length(trim(coalesce(request_idempotency_key, ''))) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.';
  end if;
  if source_location_id = destination_location_id then
    raise exception 'Source and destination locations must be different.';
  end if;
  if jsonb_typeof(requested_lines) <> 'array' or jsonb_array_length(requested_lines) = 0 then
    raise exception 'At least one transfer line is required.';
  end if;

  -- Keep warehouse, location ancestry, and pallet status stable through the
  -- full transfer. Other stock operations share this lock and remain concurrent.
  perform pg_advisory_xact_lock_shared(
    app_private.warehouse_metadata_lock_key(target_business_id, target_warehouse_id)
  );

  perform 1 from warehouses warehouse
  where warehouse.business_id = target_business_id
    and warehouse.id = target_warehouse_id
    and warehouse.active;
  if not found then raise exception 'The warehouse is inactive or does not belong to this business.'; end if;

  select * into source_location from warehouse_locations location
  where location.business_id = target_business_id
    and location.warehouse_id = target_warehouse_id
    and location.id = source_location_id;
  if not found or not source_location.accepts_inventory or
     not app_private.location_is_operational(target_business_id, target_warehouse_id, source_location_id) then
    raise exception 'The source location is inactive, invalid, or cannot hold inventory.';
  end if;

  select * into destination_location from warehouse_locations location
  where location.business_id = target_business_id
    and location.warehouse_id = target_warehouse_id
    and location.id = destination_location_id;
  if not found or not destination_location.accepts_inventory or
     not app_private.location_is_operational(target_business_id, target_warehouse_id, destination_location_id) then
    raise exception 'The destination location is inactive, invalid, or cannot hold inventory.';
  end if;

  if requested_transfer_type = 'putaway' and (
    source_location.purpose not in ('receiving', 'staging') or
    destination_location.purpose not in ('staging', 'storage', 'quarantine')
  ) then
    raise exception 'Put-away must move stock from receiving or staging into staging, storage, or quarantine.';
  end if;

  if target_pallet_id is not null and not exists (
    select 1 from pallets pallet
    where pallet.business_id = target_business_id
      and pallet.warehouse_id = target_warehouse_id
      and pallet.id = target_pallet_id
      and pallet.status = 'active'
  ) then
    raise exception 'The pallet is inactive or does not belong to this warehouse.';
  end if;

  insert into inventory_transfers (
    id, business_id, warehouse_id, type, source_location_id,
    destination_location_id, pallet_id, idempotency_key, note, performed_by
  ) values (
    generated_transfer_id, target_business_id, target_warehouse_id, requested_transfer_type,
    source_location_id, destination_location_id, target_pallet_id,
    trim(request_idempotency_key), trim(coalesce(transfer_note, '')),
    app_private.current_user_id()
  );

  requested_line_count := jsonb_array_length(requested_lines);

  insert into inventory_transfer_lines (
    business_id, transfer_id, line_number, product_id, lot_id,
    original_quantity, original_unit, conversion_factor,
    normalized_quantity, normalized_unit
  )
  select
    target_business_id,
    generated_transfer_id,
    input.line_number,
    product.id,
    lot.id,
    input.quantity,
    input.unit::unit_code,
    conversion.to_base_factor,
    input.quantity * conversion.to_base_factor,
    product.base_unit
  from jsonb_array_elements(requested_lines) with ordinality as element(value, line_number)
  cross join lateral (
    select
      element.value->>'product_id' as product_id,
      element.value->>'lot_id' as lot_id,
      (element.value->>'quantity')::numeric as quantity,
      element.value->>'unit' as unit,
      element.line_number
  ) input
  join products product
    on product.business_id = target_business_id
    and product.id = input.product_id::uuid
    and product.active
  join product_unit_conversions conversion
    on conversion.business_id = product.business_id
    and conversion.product_id = product.id
    and conversion.from_unit = input.unit::unit_code
  left join inventory_lots lot
    on lot.business_id = product.business_id
    and lot.product_id = product.id
    and lot.id = nullif(trim(input.lot_id), '')::uuid
  where input.quantity > 0
    and (input.unit::unit_code not in ('each', 'boxes', 'cases') or input.quantity = trunc(input.quantity))
    and (nullif(trim(input.lot_id), '') is null or lot.id is not null);

  get diagnostics stored_line_count = row_count;
  if stored_line_count <> requested_line_count then
    raise exception 'Every transfer line requires a valid business product, lot, quantity, unit, and conversion rule.';
  end if;

  for stock in
    select line.product_id, line.lot_id, sum(line.normalized_quantity) as requested_quantity
    from inventory_transfer_lines line
    where line.business_id = target_business_id and line.transfer_id = generated_transfer_id
    group by line.product_id, line.lot_id
    order by line.product_id::text, coalesce(line.lot_id::text, '')
  loop
    perform pg_advisory_xact_lock(app_private.inventory_stock_lock_key(
      target_business_id, target_warehouse_id, source_location_id,
      stock.product_id, stock.lot_id, target_pallet_id
    ));

    select coalesce(sum(movement.normalized_quantity), 0) into available_quantity
    from inventory_movements movement
    where movement.business_id = target_business_id
      and movement.warehouse_id = target_warehouse_id
      and movement.location_id = source_location_id
      and movement.product_id = stock.product_id
      and movement.lot_id is not distinct from stock.lot_id
      and movement.pallet_id is not distinct from target_pallet_id;

    if available_quantity < stock.requested_quantity then
      raise exception 'Insufficient inventory at the source location.';
    end if;
  end loop;

  insert into inventory_transactions (
    id, business_id, transfer_id, idempotency_key, type, approved_by
  ) values (
    generated_transaction_id, target_business_id, generated_transfer_id,
    trim(request_idempotency_key), 'transfer', app_private.current_user_id()
  );

  insert into inventory_movements (
    business_id, transaction_id, transfer_line_id, product_id, lot_id,
    original_quantity, original_unit, conversion_factor,
    normalized_quantity, normalized_unit,
    warehouse_id, location_id, pallet_id, movement_role
  )
  select
    line.business_id, generated_transaction_id, line.id, line.product_id, line.lot_id,
    -line.original_quantity, line.original_unit, line.conversion_factor,
    -line.normalized_quantity, line.normalized_unit,
    target_warehouse_id, source_location_id, target_pallet_id,
    'transfer_source'::inventory_movement_role
  from inventory_transfer_lines line
  where line.business_id = target_business_id and line.transfer_id = generated_transfer_id
  union all
  select
    line.business_id, generated_transaction_id, line.id, line.product_id, line.lot_id,
    line.original_quantity, line.original_unit, line.conversion_factor,
    line.normalized_quantity, line.normalized_unit,
    target_warehouse_id, destination_location_id, target_pallet_id,
    'transfer_destination'::inventory_movement_role
  from inventory_transfer_lines line
  where line.business_id = target_business_id and line.transfer_id = generated_transfer_id;

  return generated_transfer_id;
exception
  when unique_violation then
    raise exception 'This transfer or idempotency key was already processed.';
end;
$$;

create trigger inventory_transfers_are_immutable
before update or delete on inventory_transfers
for each row execute function prevent_inventory_history_mutation();

create trigger inventory_transfer_lines_are_immutable
before update or delete on inventory_transfer_lines
for each row execute function prevent_inventory_history_mutation();

alter table warehouses enable row level security;
alter table warehouse_locations enable row level security;
alter table pallets enable row level security;
alter table inventory_transfers enable row level security;
alter table inventory_transfer_lines enable row level security;

revoke all on warehouses, warehouse_locations, pallets,
  inventory_transfers, inventory_transfer_lines, inventory_location_balances
from public;

grant select on warehouses, warehouse_locations, pallets,
  inventory_transfers, inventory_transfer_lines, inventory_location_balances
to authenticated;

grant insert on warehouses, warehouse_locations, pallets to authenticated;
grant update on warehouses, warehouse_locations to authenticated;
grant update (status, closed_at) on pallets to authenticated;

create policy warehouses_read_by_members on warehouses
for select to authenticated
using (app_private.has_business_role(
  business_id, array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy warehouses_created_by_admin on warehouses
for insert to authenticated
with check (
  created_by = app_private.current_user_id() and
  app_private.has_business_role(business_id, array['administrator']::app_role[])
);

create policy warehouses_updated_by_admin on warehouses
for update to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]))
with check (app_private.has_business_role(business_id, array['administrator']::app_role[]));

create policy locations_read_by_members on warehouse_locations
for select to authenticated
using (app_private.has_business_role(
  business_id, array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy locations_created_by_admin on warehouse_locations
for insert to authenticated
with check (
  created_by = app_private.current_user_id() and
  app_private.has_business_role(business_id, array['administrator']::app_role[])
);

create policy locations_updated_by_admin on warehouse_locations
for update to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]))
with check (app_private.has_business_role(business_id, array['administrator']::app_role[]));

create policy pallets_read_by_members on pallets
for select to authenticated
using (app_private.has_business_role(
  business_id, array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy pallets_created_by_members on pallets
for insert to authenticated
with check (
  created_by = app_private.current_user_id() and
  app_private.has_business_role(
    business_id, array['worker', 'supervisor', 'administrator']::app_role[]
  )
);

create policy pallets_updated_by_supervisor on pallets
for update to authenticated
using (app_private.has_business_role(
  business_id, array['supervisor', 'administrator']::app_role[]
))
with check (app_private.has_business_role(
  business_id, array['supervisor', 'administrator']::app_role[]
));

create policy transfers_read_by_members on inventory_transfers
for select to authenticated
using (app_private.has_business_role(
  business_id, array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy transfer_lines_read_by_members on inventory_transfer_lines
for select to authenticated
using (app_private.has_business_role(
  business_id, array['worker', 'supervisor', 'administrator']::app_role[]
));

revoke all on function execute_inventory_transfer(
  uuid, uuid, uuid, uuid, uuid, warehouse_transfer_type, text, jsonb, text
) from public;
grant execute on function execute_inventory_transfer(
  uuid, uuid, uuid, uuid, uuid, warehouse_transfer_type, text, jsonb, text
) to authenticated;

comment on view inventory_location_balances is
  'Derived location, lot, and pallet balances. Internal transfers net to zero in product-wide inventory_balances.';
comment on function execute_inventory_transfer(uuid, uuid, uuid, uuid, uuid, warehouse_transfer_type, text, jsonb, text) is
  'Creates one immutable source movement and one immutable destination movement per line under serialized source-stock locks.';

commit;
