-- FreshRoute commercial data foundation.
-- REVIEW ONLY: this migration has not been applied to any database or cloud service.
-- PostgreSQL 15+ is the intended target. Authentication is supplied by an external provider.

begin;

create extension if not exists pgcrypto;

create type app_role as enum ('worker', 'supervisor', 'administrator');
create type membership_status as enum ('invited', 'active', 'suspended', 'revoked');
create type unit_code as enum ('each', 'boxes', 'cases', 'kg', 'g', 'L', 'mL');
create type adjustment_type as enum ('opening_balance', 'receiving', 'count', 'correction');
create type adjustment_status as enum ('pending', 'approved', 'rejected');
create type approval_decision as enum ('approved', 'rejected');

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  created_at timestamptz not null default now()
);

-- Stores profile data only. Passwords and sign-in credentials belong to the chosen identity provider.
create table app_users (
  id uuid primary key,
  email text not null,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create unique index app_users_email_case_insensitive_unique
  on app_users (lower(email));

-- Invite secrets are never stored. Only a one-way hash is retained for server-side validation.
create table business_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  email text not null,
  role app_role not null,
  token_hash text not null check (length(token_hash) >= 32),
  invited_by uuid not null references app_users(id),
  invited_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by uuid references app_users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  unique (business_id, id),
  check (expires_at > invited_at),
  check ((accepted_by is null) = (accepted_at is null))
);

create unique index one_open_invitation_per_business_email
  on business_invitations (business_id, lower(email))
  where accepted_at is null and revoked_at is null;

create table business_memberships (
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role app_role not null,
  status membership_status not null default 'invited',
  invitation_id uuid not null,
  invitation_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id),
  foreign key (business_id, invitation_id)
    references business_invitations(business_id, id) on delete restrict,
  check (
    (status = 'active' and invitation_accepted_at is not null) or
    (status <> 'active')
  )
);

create table products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  sku text not null check (length(trim(sku)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 160),
  brand text not null default '' check (length(brand) <= 120),
  base_unit unit_code not null check (base_unit not in ('boxes', 'cases')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, sku, brand),
  unique (business_id, id)
);

-- Every accepted source unit has an explicit factor to the product's base unit.
-- Examples: 1 g = 0.001 kg; 1 case = 12 L for a particular product.
create table product_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  from_unit unit_code not null,
  to_base_factor numeric(30, 12) not null check (to_base_factor > 0),
  rule_source text not null check (rule_source in ('base', 'metric', 'packaging')),
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, product_id) references products(business_id, id) on delete cascade,
  unique (business_id, product_id, from_unit)
);

create function validate_product_unit_conversion()
returns trigger
language plpgsql
as $$
declare
  product_base_unit unit_code;
begin
  select base_unit into product_base_unit
  from products
  where business_id = new.business_id and id = new.product_id;

  if product_base_unit is null then
    raise exception 'Product does not belong to the conversion business.';
  end if;

  if new.from_unit in ('boxes', 'cases') then
    if new.rule_source <> 'packaging' then
      raise exception 'Boxes and cases require a packaging conversion rule.';
    end if;
  elsif new.from_unit = product_base_unit then
    if new.to_base_factor <> 1 or new.rule_source <> 'base' then
      raise exception 'A base-unit rule must use a factor of 1.';
    end if;
  elsif product_base_unit in ('kg', 'g') and new.from_unit in ('kg', 'g') then
    if new.rule_source <> 'metric' or
       (product_base_unit = 'kg' and (new.from_unit <> 'g' or new.to_base_factor <> 0.001)) or
       (product_base_unit = 'g' and (new.from_unit <> 'kg' or new.to_base_factor <> 1000)) then
      raise exception 'Invalid mass conversion rule.';
    end if;
  elsif product_base_unit in ('L', 'mL') and new.from_unit in ('L', 'mL') then
    if new.rule_source <> 'metric' or
       (product_base_unit = 'L' and (new.from_unit <> 'mL' or new.to_base_factor <> 0.001)) or
       (product_base_unit = 'mL' and (new.from_unit <> 'L' or new.to_base_factor <> 1000)) then
      raise exception 'Invalid volume conversion rule.';
    end if;
  else
    raise exception 'Incompatible measurement families cannot be combined.';
  end if;

  return new;
end;
$$;

create trigger product_unit_conversions_are_compatible
before insert or update on product_unit_conversions
for each row execute function validate_product_unit_conversion();

create table inventory_lots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  lot_code text,
  expiration_date date,
  created_at timestamptz not null default now(),
  foreign key (business_id, product_id) references products(business_id, id) on delete restrict,
  unique nulls not distinct (business_id, product_id, lot_code, expiration_date),
  unique (business_id, id)
);

create table receiving_deliveries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  supplier text not null check (length(trim(supplier)) between 1 and 160),
  delivered_on date not null,
  inspection_notes text not null default '' check (length(inspection_notes) <= 4000),
  recorded_by uuid not null references app_users(id),
  recorded_at timestamptz not null default now(),
  unique (business_id, id)
);

create table receiving_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  received_quantity numeric(30, 6) not null check (received_quantity > 0),
  received_unit unit_code not null,
  damaged_package_quantity numeric(30, 6) not null default 0 check (damaged_package_quantity >= 0),
  damaged_package_unit unit_code check (damaged_package_unit in ('boxes', 'cases')),
  damaged_loose_quantity numeric(30, 6) not null default 0 check (damaged_loose_quantity >= 0),
  damaged_loose_unit unit_code,
  created_at timestamptz not null default now(),
  foreign key (business_id, delivery_id) references receiving_deliveries(business_id, id) on delete cascade,
  foreign key (business_id, product_id) references products(business_id, id) on delete restrict,
  foreign key (business_id, lot_id) references inventory_lots(business_id, id) on delete restrict,
  check (
    (damaged_package_quantity = 0 and damaged_package_unit is null) or
    (damaged_package_quantity > 0 and damaged_package_unit is not null)
  ),
  check (
    (damaged_loose_quantity = 0 and damaged_loose_unit is null) or
    (damaged_loose_quantity > 0 and damaged_loose_unit is not null)
  ),
  check (
    received_unit not in ('each', 'boxes', 'cases') or
    received_quantity = trunc(received_quantity)
  ),
  check (damaged_package_quantity = trunc(damaged_package_quantity)),
  check (
    damaged_loose_unit not in ('each', 'boxes', 'cases') or
    damaged_loose_quantity = trunc(damaged_loose_quantity)
  )
);

-- Metadata only. object_key must point to a private bucket controlled by tenant-aware policies.
create table damage_photos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_id uuid not null,
  object_key text not null check (length(trim(object_key)) between 1 and 500),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, delivery_id) references receiving_deliveries(business_id, id) on delete cascade,
  unique (business_id, object_key)
);

create table inventory_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  type adjustment_type not null,
  status adjustment_status not null default 'pending',
  source_reference text not null check (length(trim(source_reference)) between 1 and 160),
  delivery_id uuid,
  corrects_transaction_id uuid,
  reason text not null default '' check (length(reason) <= 1000),
  requested_by uuid not null references app_users(id),
  requested_at timestamptz not null default now(),
  foreign key (business_id, delivery_id) references receiving_deliveries(business_id, id) on delete restrict,
  unique (business_id, id),
  check ((type = 'receiving') = (delivery_id is not null)),
  check ((type = 'correction') = (corrects_transaction_id is not null)),
  check (type <> 'correction' or length(trim(reason)) > 0)
);

create table inventory_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  request_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  original_quantity numeric(30, 6) not null check (original_quantity <> 0),
  original_unit unit_code not null,
  created_at timestamptz not null default now(),
  foreign key (business_id, request_id) references inventory_adjustment_requests(business_id, id) on delete cascade,
  foreign key (business_id, product_id) references products(business_id, id) on delete restrict,
  foreign key (business_id, lot_id) references inventory_lots(business_id, id) on delete restrict,
  unique (business_id, id),
  check (
    original_unit not in ('each', 'boxes', 'cases') or
    original_quantity = trunc(original_quantity)
  )
);

create table inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete restrict,
  request_id uuid not null,
  idempotency_key text not null check (length(trim(idempotency_key)) between 8 and 200),
  type adjustment_type not null,
  corrects_transaction_id uuid,
  approved_by uuid not null references app_users(id),
  approved_at timestamptz not null default now(),
  foreign key (business_id, request_id) references inventory_adjustment_requests(business_id, id) on delete restrict,
  foreign key (corrects_transaction_id) references inventory_transactions(id) on delete restrict,
  unique (business_id, request_id),
  unique (business_id, idempotency_key),
  unique (business_id, id)
);

alter table inventory_adjustment_requests
  add constraint correction_transaction_business_fk
  foreign key (business_id, corrects_transaction_id)
  references inventory_transactions(business_id, id) on delete restrict;

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  transaction_id uuid not null,
  adjustment_line_id uuid not null,
  product_id uuid not null,
  lot_id uuid,
  original_quantity numeric(30, 6) not null,
  original_unit unit_code not null,
  conversion_factor numeric(30, 12) not null check (conversion_factor > 0),
  normalized_quantity numeric(30, 12) not null check (normalized_quantity <> 0),
  normalized_unit unit_code not null check (normalized_unit not in ('boxes', 'cases')),
  occurred_at timestamptz not null default now(),
  foreign key (business_id, transaction_id) references inventory_transactions(business_id, id) on delete restrict,
  foreign key (business_id, product_id) references products(business_id, id) on delete restrict,
  foreign key (business_id, lot_id) references inventory_lots(business_id, id) on delete restrict,
  foreign key (business_id, adjustment_line_id)
    references inventory_adjustment_lines(business_id, id) on delete restrict,
  unique (transaction_id, adjustment_line_id)
);

create table inventory_approval_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete restrict,
  request_id uuid not null,
  decision approval_decision not null,
  decided_by uuid not null references app_users(id),
  decided_at timestamptz not null default now(),
  reason text not null default '' check (length(reason) <= 1000),
  foreign key (business_id, request_id) references inventory_adjustment_requests(business_id, id) on delete restrict,
  unique (business_id, request_id)
);

create index memberships_by_user on business_memberships (user_id, business_id) where status = 'active';
create index products_by_business on products (business_id, active, sku);
create index lots_by_expiration on inventory_lots (business_id, expiration_date);
create index requests_by_status on inventory_adjustment_requests (business_id, status, requested_at);
create index movements_by_product on inventory_movements (business_id, product_id, occurred_at);

-- Balances are derived from immutable movements; no mutable quantity column can drift from history.
create view inventory_balances
with (security_invoker = true) as
select
  p.business_id,
  p.id as product_id,
  p.sku,
  p.name,
  p.brand,
  p.base_unit,
  coalesce(sum(m.normalized_quantity), 0)::numeric(30, 12) as quantity
from products p
left join inventory_movements m
  on m.business_id = p.business_id and m.product_id = p.id
group by p.business_id, p.id, p.sku, p.name, p.brand, p.base_unit;

-- Applied history is append-only. Corrections must be new requests and movements.
create function prevent_inventory_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Inventory history is append-only; create a correction instead.';
end;
$$;

create trigger inventory_movements_are_immutable
before update or delete on inventory_movements
for each row execute function prevent_inventory_history_mutation();

create trigger inventory_transactions_are_immutable
before update or delete on inventory_transactions
for each row execute function prevent_inventory_history_mutation();

create trigger approval_events_are_immutable
before update or delete on inventory_approval_events
for each row execute function prevent_inventory_history_mutation();

comment on schema public is
  'Commercial tenant data only. The 4,325-row classroom dataset stays outside this schema.';
comment on table damage_photos is
  'Private object metadata only. Database backups do not replace object-storage backups.';

commit;
