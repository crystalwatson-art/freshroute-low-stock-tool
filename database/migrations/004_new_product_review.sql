-- FreshRoute new-product review workflow.
-- REVIEW ONLY: this migration has not been applied to any production database.
-- Unknown delivery lines stay attached to their delivery until an authenticated
-- Supervisor or Administrator creates the product and posts accepted stock.

begin;

alter table products
  add column low_stock_threshold numeric(30, 12) not null default 0
    check (low_stock_threshold >= 0),
  add column reorder_threshold numeric(30, 12) not null default 0
    check (reorder_threshold >= low_stock_threshold);

create unique index products_business_sku_brand_trimmed_unique
  on products (business_id, lower(trim(sku)), lower(trim(brand)));

create type new_product_review_status as enum (
  'pending', 'approved', 'rejected', 'correction_requested'
);

create table new_product_reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_id uuid not null,
  source_item_key text not null check (length(trim(source_item_key)) between 1 and 160),
  sku text not null check (length(trim(sku)) between 1 and 80),
  product_name text not null check (length(trim(product_name)) between 1 and 160),
  brand text not null check (length(trim(brand)) between 1 and 120),
  supplier text not null check (length(trim(supplier)) between 1 and 160),
  measurement_unit unit_code not null check (measurement_unit not in ('boxes', 'cases')),
  received_quantity numeric(30, 12) not null check (received_quantity > 0),
  damaged_quantity numeric(30, 12) not null default 0 check (damaged_quantity >= 0),
  accepted_quantity numeric(30, 12) not null check (accepted_quantity >= 0),
  low_stock_threshold numeric(30, 12) not null check (low_stock_threshold >= 0),
  reorder_threshold numeric(30, 12) not null check (reorder_threshold >= low_stock_threshold),
  status new_product_review_status not null default 'pending',
  requested_by uuid not null references app_users(id),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz,
  decision_reason text not null default '' check (length(decision_reason) <= 1000),
  approved_product_id uuid,
  foreign key (business_id, delivery_id)
    references receiving_deliveries(business_id, id) on delete restrict,
  foreign key (business_id, approved_product_id)
    references products(business_id, id) on delete restrict,
  unique (business_id, id),
  check (damaged_quantity + accepted_quantity <= received_quantity),
  check (measurement_unit <> 'each' or received_quantity = trunc(received_quantity)),
  check (measurement_unit <> 'each' or damaged_quantity = trunc(damaged_quantity)),
  check (measurement_unit <> 'each' or accepted_quantity = trunc(accepted_quantity)),
  check ((status = 'approved') = (approved_product_id is not null)),
  check ((status = 'pending' and reviewed_by is null and reviewed_at is null) or status <> 'pending'),
  check ((reviewed_by is null) = (reviewed_at is null))
);

create unique index new_product_reviews_delivery_item_unique
  on new_product_reviews (
    business_id, delivery_id, lower(trim(source_item_key))
  );

create index new_product_reviews_by_status
  on new_product_reviews (business_id, status, requested_at);

create table new_product_review_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  review_id uuid not null,
  event_type text not null check (event_type in (
    'requested', 'approved', 'rejected', 'correction_requested', 'resubmitted'
  )),
  acted_by uuid not null references app_users(id),
  acted_at timestamptz not null default now(),
  reason text not null default '' check (length(reason) <= 1000),
  changes jsonb not null default '{}'::jsonb,
  foreign key (business_id, review_id)
    references new_product_reviews(business_id, id) on delete restrict,
  unique (business_id, id)
);

create index new_product_review_events_by_review
  on new_product_review_events (business_id, review_id, acted_at);

alter table new_product_reviews enable row level security;
alter table new_product_review_events enable row level security;

revoke all on new_product_reviews, new_product_review_events from public;
grant select on new_product_reviews, new_product_review_events to authenticated;
grant insert on new_product_reviews to authenticated;

create policy new_product_reviews_read_by_members on new_product_reviews
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy new_product_reviews_requested_by_members on new_product_reviews
for insert to authenticated
with check (
  status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
  and approved_product_id is null
  and requested_by = app_private.current_user_id()
  and app_private.has_business_role(
    business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  )
  and exists (
    select 1
    from receiving_deliveries delivery
    where delivery.business_id = new_product_reviews.business_id
      and delivery.id = new_product_reviews.delivery_id
      and delivery.recorded_by = app_private.current_user_id()
      and lower(trim(delivery.supplier)) = lower(trim(new_product_reviews.supplier))
  )
);

create policy new_product_review_events_read_by_members on new_product_review_events
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create function app_private.record_new_product_review_request()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
begin
  insert into new_product_review_events (
    business_id, review_id, event_type, acted_by, changes
  ) values (
    new.business_id, new.id, 'requested', new.requested_by,
    jsonb_build_object(
      'sku', new.sku,
      'product_name', new.product_name,
      'brand', new.brand,
      'supplier', new.supplier,
      'measurement_unit', new.measurement_unit,
      'received_quantity', new.received_quantity,
      'damaged_quantity', new.damaged_quantity,
      'accepted_quantity', new.accepted_quantity,
      'low_stock_threshold', new.low_stock_threshold,
      'reorder_threshold', new.reorder_threshold
    )
  );
  return new;
end;
$$;

revoke all on function app_private.record_new_product_review_request() from public;
create trigger new_product_review_request_is_audited
after insert on new_product_reviews
for each row execute function app_private.record_new_product_review_request();

create function review_new_product(
  target_review_id uuid,
  decision text,
  decision_reason text,
  request_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  review new_product_reviews%rowtype;
  actor_id uuid := app_private.current_user_id();
  product_id uuid := gen_random_uuid();
  adjustment_request_id uuid := gen_random_uuid();
  transaction_id uuid := gen_random_uuid();
  normalized_decision text := lower(trim(decision));
  normalized_reason text := trim(coalesce(decision_reason, ''));
  existing_transaction uuid;
begin
  if normalized_decision not in ('approve', 'reject', 'request_correction') then
    raise exception 'New-product decision must be approve, reject, or request_correction.';
  end if;
  if normalized_reason = '' then
    raise exception 'A decision reason is required.';
  end if;
  if length(normalized_reason) > 1000 then
    raise exception 'Decision reason must be 1,000 characters or fewer.';
  end if;
  if normalized_decision = 'approve' and length(trim(coalesce(request_idempotency_key, ''))) < 8 then
    raise exception 'An approval idempotency key is required.';
  end if;
  if not app_private.has_business_role(
    (select business_id from new_product_reviews where id = target_review_id),
    array['supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'Supervisor or Administrator permission is required.';
  end if;

  select * into review
  from new_product_reviews
  where id = target_review_id
  for update;
  if not found then raise exception 'New-product review not found.'; end if;

  if normalized_decision = 'approve' and review.status = 'approved' then
    select transaction.id into existing_transaction
    from inventory_transactions transaction
    join inventory_adjustment_requests request
      on request.business_id = transaction.business_id
      and request.id = transaction.request_id
    where request.source_reference = 'new-product-review:' || review.id::text
      and transaction.idempotency_key = trim(request_idempotency_key)
      and transaction.business_id = review.business_id;
    if existing_transaction is not null then return existing_transaction; end if;
  end if;

  if normalized_decision = 'approve' then
    if review.status not in ('pending', 'correction_requested') then
      raise exception 'This new-product review already has a final decision.';
    end if;
    if review.accepted_quantity <= 0 then
      raise exception 'Accepted usable quantity must be greater than zero.';
    end if;
    if review.supplier <> (
      select delivery.supplier from receiving_deliveries delivery
      where delivery.business_id = review.business_id and delivery.id = review.delivery_id
    ) then
      raise exception 'Supplier does not match the saved delivery.';
    end if;
    if exists (
      select 1 from products product
      where product.business_id = review.business_id
        and lower(trim(product.sku)) = lower(trim(review.sku))
        and lower(trim(product.brand)) = lower(trim(review.brand))
    ) then
      raise exception 'A product with this SKU and brand already exists.';
    end if;

    insert into products (
      id, business_id, sku, name, brand, base_unit,
      low_stock_threshold, reorder_threshold
    ) values (
      product_id, review.business_id, trim(review.sku), trim(review.product_name),
      trim(review.brand), review.measurement_unit,
      review.low_stock_threshold, review.reorder_threshold
    );

    insert into product_unit_conversions (
      business_id, product_id, from_unit, to_base_factor, rule_source, created_by
    ) values (
      review.business_id, product_id, review.measurement_unit, 1, 'base', actor_id
    );

    insert into inventory_adjustment_requests (
      id, business_id, type, source_reference, delivery_id, reason, requested_by
    ) values (
      adjustment_request_id, review.business_id, 'receiving',
      'new-product-review:' || review.id::text, review.delivery_id,
      normalized_reason, review.requested_by
    );

    insert into inventory_adjustment_lines (
      business_id, request_id, product_id, original_quantity, original_unit
    ) values (
      review.business_id, adjustment_request_id, product_id,
      review.accepted_quantity, review.measurement_unit
    );

    insert into inventory_transactions (
      id, business_id, request_id, idempotency_key, type, approved_by
    ) values (
      transaction_id, review.business_id, adjustment_request_id,
      trim(request_idempotency_key), 'receiving', actor_id
    );

    insert into inventory_movements (
      business_id, transaction_id, adjustment_line_id, product_id,
      original_quantity, original_unit, conversion_factor,
      normalized_quantity, normalized_unit
    ) values (
      review.business_id, transaction_id,
      (select line.id
       from inventory_adjustment_lines line
       where line.business_id = review.business_id
         and line.request_id = adjustment_request_id),
      product_id, review.accepted_quantity, review.measurement_unit,
      1, review.accepted_quantity, review.measurement_unit
    );

    update inventory_adjustment_requests
    set status = 'approved'
    where id = adjustment_request_id and business_id = review.business_id;

    insert into inventory_approval_events (
      business_id, request_id, decision, decided_by, reason
    ) values (
      review.business_id, adjustment_request_id, 'approved', actor_id, normalized_reason
    );

    update new_product_reviews
    set status = 'approved', reviewed_by = actor_id, reviewed_at = now(),
        decision_reason = normalized_reason, approved_product_id = product_id
    where id = review.id and business_id = review.business_id;

    insert into new_product_review_events (
      business_id, review_id, event_type, acted_by, reason, changes
    ) values (
      review.business_id, review.id, 'approved', actor_id, normalized_reason,
      jsonb_build_object(
        'product_id', product_id,
        'sku', review.sku,
        'measurement_unit', review.measurement_unit,
        'accepted_quantity', review.accepted_quantity,
        'low_stock_threshold', review.low_stock_threshold,
        'reorder_threshold', review.reorder_threshold
      )
    );
    return transaction_id;
  end if;

  if review.status not in ('pending', 'correction_requested') then
    raise exception 'This new-product review already has a final decision.';
  end if;
  update new_product_reviews
  set status = case when normalized_decision = 'reject'
                    then 'rejected'::new_product_review_status
                    else 'correction_requested'::new_product_review_status end,
      reviewed_by = actor_id, reviewed_at = now(), decision_reason = normalized_reason
  where id = review.id and business_id = review.business_id;

  insert into new_product_review_events (
    business_id, review_id, event_type, acted_by, reason, changes
  ) values (
    review.business_id, review.id,
    case when normalized_decision = 'reject' then 'rejected' else 'correction_requested' end,
    actor_id, normalized_reason, '{}'::jsonb
  );
  return review.id;
end;
$$;

create function resubmit_new_product_review(
  target_review_id uuid,
  corrected_sku text,
  corrected_product_name text,
  corrected_brand text,
  corrected_measurement_unit unit_code,
  corrected_received_quantity numeric,
  corrected_damaged_quantity numeric,
  corrected_accepted_quantity numeric,
  corrected_low_stock_threshold numeric,
  corrected_reorder_threshold numeric,
  correction_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  review new_product_reviews%rowtype;
  actor_id uuid := app_private.current_user_id();
  normalized_reason text := trim(coalesce(correction_reason, ''));
begin
  select * into review from new_product_reviews where id = target_review_id for update;
  if not found then raise exception 'New-product review not found.'; end if;
  if not app_private.has_business_role(
    review.business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'Active business membership is required.';
  end if;
  if review.status <> 'correction_requested' then
    raise exception 'This review is not waiting for corrections.';
  end if;
  if normalized_reason = '' then raise exception 'A correction reason is required.'; end if;
  if corrected_received_quantity <= 0 or corrected_damaged_quantity < 0 or corrected_accepted_quantity <= 0 then
    raise exception 'Quantities must be positive, with damage at zero or more.';
  end if;
  if corrected_damaged_quantity + corrected_accepted_quantity > corrected_received_quantity then
    raise exception 'Accepted quantity plus damaged quantity cannot exceed received quantity.';
  end if;
  if corrected_low_stock_threshold < 0 or corrected_reorder_threshold < corrected_low_stock_threshold then
    raise exception 'Stock thresholds are invalid.';
  end if;
  if exists (
    select 1 from products product
    where product.business_id = review.business_id
      and lower(trim(product.sku)) = lower(trim(corrected_sku))
      and lower(trim(product.brand)) = lower(trim(corrected_brand))
  ) then
    raise exception 'A product with this SKU and brand already exists.';
  end if;

  update new_product_reviews
  set sku = trim(corrected_sku), product_name = trim(corrected_product_name),
      brand = trim(corrected_brand), measurement_unit = corrected_measurement_unit,
      received_quantity = corrected_received_quantity,
      damaged_quantity = corrected_damaged_quantity,
      accepted_quantity = corrected_accepted_quantity,
      low_stock_threshold = corrected_low_stock_threshold,
      reorder_threshold = corrected_reorder_threshold,
      status = 'pending', reviewed_by = null, reviewed_at = null,
      decision_reason = normalized_reason, approved_product_id = null
  where id = review.id and business_id = review.business_id;

  insert into new_product_review_events (
    business_id, review_id, event_type, acted_by, reason, changes
  ) values (
    review.business_id, review.id, 'resubmitted', actor_id, normalized_reason,
    jsonb_build_object(
      'sku', trim(corrected_sku),
      'product_name', trim(corrected_product_name),
      'brand', trim(corrected_brand),
      'measurement_unit', corrected_measurement_unit,
      'received_quantity', corrected_received_quantity,
      'damaged_quantity', corrected_damaged_quantity,
      'accepted_quantity', corrected_accepted_quantity,
      'low_stock_threshold', corrected_low_stock_threshold,
      'reorder_threshold', corrected_reorder_threshold
    )
  );
  return review.id;
end;
$$;

revoke all on function review_new_product(uuid, text, text, text) from public;
revoke all on function resubmit_new_product_review(uuid, text, text, text, unit_code, numeric, numeric, numeric, numeric, numeric, text) from public;
grant execute on function review_new_product(uuid, text, text, text) to authenticated;
grant execute on function resubmit_new_product_review(uuid, text, text, text, unit_code, numeric, numeric, numeric, numeric, numeric, text) to authenticated;

create trigger new_product_review_events_are_immutable
before update or delete on new_product_review_events
for each row execute function prevent_inventory_history_mutation();

commit;
