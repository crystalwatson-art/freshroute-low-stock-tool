-- Commercial lot and expiration tracking.
-- REVIEW ONLY: apply to an isolated preview database first. Never apply to production
-- without the migration/rollback review and backup process in the commercial runbook.

begin;

alter table products
  add column expiration_warning_days integer not null default 14
    check (expiration_warning_days between 0 and 3650);

alter table inventory_lots
  add constraint inventory_lots_lot_code_length
    check (lot_code is null or length(trim(lot_code)) between 1 and 120);

alter table new_product_reviews
  add column lot_code text
    check (lot_code is null or length(trim(lot_code)) between 1 and 120),
  add column expiration_date date,
  add constraint new_product_reviews_lot_pair
    check ((lot_code is null) = (expiration_date is null));

create view inventory_lot_balances
with (security_invoker = true) as
select
  product.business_id,
  product.id as product_id,
  product.sku,
  product.name,
  product.brand,
  product.base_unit,
  product.expiration_warning_days,
  lot.id as lot_id,
  lot.lot_code,
  lot.expiration_date,
  coalesce(sum(movement.normalized_quantity), 0)::numeric(30, 12) as quantity
from inventory_lots lot
join products product
  on product.business_id = lot.business_id and product.id = lot.product_id
left join inventory_movements movement
  on movement.business_id = lot.business_id and movement.product_id = lot.product_id
  and movement.lot_id = lot.id
group by product.business_id, product.id, product.sku, product.name, product.brand,
  product.base_unit, product.expiration_warning_days, lot.id, lot.lot_code, lot.expiration_date;

grant select on inventory_lot_balances to authenticated;

create function app_private.ensure_inventory_lot(
  target_business_id uuid,
  target_product_id uuid,
  target_lot_code text,
  target_expiration_date date
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  normalized_lot text := nullif(trim(target_lot_code), '');
  lot_id uuid;
begin
  if normalized_lot is null and target_expiration_date is null then
    return null;
  end if;
  if normalized_lot is null or target_expiration_date is null then
    raise exception 'Batch or lot and expiration date must be supplied together.';
  end if;
  if length(normalized_lot) > 120 then
    raise exception 'Batch or lot must be 120 characters or fewer.';
  end if;
  if not exists (
    select 1 from products product
    where product.business_id = target_business_id and product.id = target_product_id
  ) then
    raise exception 'The inventory lot product does not belong to the business.';
  end if;

  insert into inventory_lots (business_id, product_id, lot_code, expiration_date)
  values (target_business_id, target_product_id, normalized_lot, target_expiration_date)
  on conflict (business_id, product_id, lot_code, expiration_date) do update
    set lot_code = excluded.lot_code
  returning id into lot_id;
  return lot_id;
end;
$$;

create or replace function list_receiving_records(target_business_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app_private, pg_temp
as $$
  select coalesce(jsonb_agg(row_data order by (row_data->>'savedAt') desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', delivery.id, 'supplier', delivery.supplier, 'deliveryDate', delivery.delivered_on,
      'notes', delivery.inspection_notes, 'savedAt', delivery.recorded_at,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku', product.sku, 'productName', product.name, 'brand', product.brand,
          'totalUnits', item.received_quantity,
          'totalDamagedUnits', item.damaged_package_quantity + item.damaged_loose_quantity,
          'usableUnits', item.received_quantity - item.damaged_package_quantity - item.damaged_loose_quantity,
          'totalBoxes', 0, 'damagedBoxes', 0, 'damagedUnits', item.damaged_loose_quantity,
          'unitsPerBox', 1, 'lotCode', lot.lot_code, 'expirationDate', lot.expiration_date
        ) order by item.created_at)
        from receiving_items item
        join products product on product.business_id = item.business_id and product.id = item.product_id
        left join inventory_lots lot on lot.business_id = item.business_id and lot.id = item.lot_id
        where item.business_id = delivery.business_id and item.delivery_id = delivery.id
      ), '[]'::jsonb) || coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku', review.sku, 'productName', review.product_name, 'brand', review.brand,
          'totalUnits', review.received_quantity, 'totalDamagedUnits', review.damaged_quantity,
          'usableUnits', review.accepted_quantity, 'totalBoxes', 0, 'damagedBoxes', 0,
          'damagedUnits', review.damaged_quantity, 'unitsPerBox', 1,
          'lotCode', review.lot_code, 'expirationDate', review.expiration_date,
          'newProductReviewId', review.id, 'reviewStatus', review.status
        ) order by review.requested_at)
        from new_product_reviews review
        where review.business_id = delivery.business_id and review.delivery_id = delivery.id
      ), '[]'::jsonb),
      'totals', jsonb_build_object(
        'lineItems', (select count(*) from receiving_items item where item.business_id = delivery.business_id and item.delivery_id = delivery.id)
          + (select count(*) from new_product_reviews review where review.business_id = delivery.business_id and review.delivery_id = delivery.id),
        'totalUnits', coalesce((select sum(item.received_quantity) from receiving_items item where item.business_id = delivery.business_id and item.delivery_id = delivery.id), 0)
          + coalesce((select sum(review.received_quantity) from new_product_reviews review where review.business_id = delivery.business_id and review.delivery_id = delivery.id), 0),
        'totalDamagedUnits', coalesce((select sum(item.damaged_package_quantity + item.damaged_loose_quantity) from receiving_items item where item.business_id = delivery.business_id and item.delivery_id = delivery.id), 0)
          + coalesce((select sum(review.damaged_quantity) from new_product_reviews review where review.business_id = delivery.business_id and review.delivery_id = delivery.id), 0),
        'usableUnits', coalesce((select sum(item.received_quantity - item.damaged_package_quantity - item.damaged_loose_quantity) from receiving_items item where item.business_id = delivery.business_id and item.delivery_id = delivery.id), 0)
          + coalesce((select sum(review.accepted_quantity) from new_product_reviews review where review.business_id = delivery.business_id and review.delivery_id = delivery.id), 0)
      ),
      'sourceKey', 'commercial:' || target_business_id::text, 'sourceLabel', 'Commercial business records'
    ) as row_data
    from receiving_deliveries delivery
    where delivery.business_id = target_business_id
      and app_private.has_business_role(target_business_id, array['worker', 'supervisor', 'administrator']::app_role[])
  ) records;
$$;

create or replace function decide_receiving_delivery(
  target_delivery_id uuid,
  delivery_decision text,
  decision_reason text,
  request_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  delivery receiving_deliveries%rowtype;
  adjustment_id uuid;
  existing_transaction uuid;
  normalized_decision text := lower(trim(coalesce(delivery_decision, '')));
  normalized_reason text := trim(coalesce(decision_reason, ''));
  normalized_key text := trim(coalesce(request_idempotency_key, ''));
begin
  select * into delivery from receiving_deliveries where id = target_delivery_id for update;
  if not found then raise exception 'Receiving delivery not found.'; end if;
  if not app_private.has_business_role(delivery.business_id, array['supervisor', 'administrator']::app_role[]) then
    raise exception 'Supervisor or Administrator permission is required.';
  end if;
  if normalized_decision not in ('approve', 'reject') then raise exception 'Delivery decision must be approve or reject.'; end if;
  if normalized_reason = '' then raise exception 'A decision reason is required.'; end if;
  if length(normalized_key) not between 8 and 200 then raise exception 'A decision idempotency key between 8 and 200 characters is required.'; end if;
  select transaction.id into existing_transaction from inventory_transactions transaction
  where transaction.business_id = delivery.business_id and transaction.idempotency_key = normalized_key;
  if existing_transaction is not null then return existing_transaction; end if;
  if normalized_decision = 'approve' and exists (
    select 1 from new_product_reviews review
    where review.business_id = delivery.business_id and review.delivery_id = delivery.id and review.status <> 'approved'
  ) then raise exception 'Every unfamiliar SKU must be approved before the delivery can be posted.'; end if;

  select id into adjustment_id from inventory_adjustment_requests
  where business_id = delivery.business_id and source_reference = 'receiving-delivery:' || delivery.id::text for update;
  if adjustment_id is null then
    insert into inventory_adjustment_requests (
      business_id, type, source_reference, delivery_id, reason, requested_by
    ) values (
      delivery.business_id, 'receiving', 'receiving-delivery:' || delivery.id::text,
      delivery.id, normalized_reason, delivery.recorded_by
    ) returning id into adjustment_id;
    insert into inventory_adjustment_lines (
      business_id, request_id, product_id, lot_id, original_quantity, original_unit
    )
    select item.business_id, adjustment_id, item.product_id, item.lot_id,
      item.received_quantity - item.damaged_package_quantity - item.damaged_loose_quantity,
      item.received_unit
    from receiving_items item
    where item.business_id = delivery.business_id and item.delivery_id = delivery.id
      and item.received_quantity - item.damaged_package_quantity - item.damaged_loose_quantity > 0;
  end if;
  if normalized_decision = 'reject' then
    perform reject_inventory_adjustment(adjustment_id, normalized_reason);
    return adjustment_id;
  end if;
  return approve_inventory_adjustment(adjustment_id, normalized_key);
end;
$$;

revoke all on function record_receiving_delivery(uuid, text, jsonb, jsonb) from public;
revoke all on function list_receiving_records(uuid) from public;
revoke all on function decide_receiving_delivery(uuid, text, text, text) from public;
grant execute on function record_receiving_delivery(uuid, text, jsonb, jsonb) to authenticated;
grant execute on function list_receiving_records(uuid) to authenticated;
grant execute on function decide_receiving_delivery(uuid, text, text, text) to authenticated;

revoke all on function app_private.ensure_inventory_lot(uuid, uuid, text, date) from public;

create or replace function app_private.attach_new_product_review_lot()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  source_reference text;
  review_id uuid;
  review_lot text;
  review_expiration date;
begin
  select request.source_reference into source_reference
  from inventory_adjustment_requests request
  where request.business_id = new.business_id and request.id = new.request_id;

  if source_reference like 'new-product-review:%' then
    review_id := split_part(source_reference, ':', 2)::uuid;
    select review.lot_code, review.expiration_date
      into review_lot, review_expiration
    from new_product_reviews review
    where review.business_id = new.business_id and review.id = review_id;
    if review_lot is not null or review_expiration is not null then
      new.lot_id := app_private.ensure_inventory_lot(
        new.business_id, new.product_id, review_lot, review_expiration
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.attach_new_product_review_lot() from public;
create trigger adjustment_lines_attach_new_product_lot
before insert on inventory_adjustment_lines
for each row execute function app_private.attach_new_product_review_lot();

create or replace function app_private.attach_adjustment_line_lot()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
begin
  if new.adjustment_line_id is not null and new.lot_id is null then
    select line.lot_id into new.lot_id
    from inventory_adjustment_lines line
    where line.business_id = new.business_id and line.id = new.adjustment_line_id;
  end if;
  return new;
end;
$$;

revoke all on function app_private.attach_adjustment_line_lot() from public;
create trigger movements_attach_adjustment_line_lot
before insert on inventory_movements
for each row execute function app_private.attach_adjustment_line_lot();

create or replace function app_private.prevent_expired_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
begin
  if new.normalized_quantity > 0 and new.lot_id is not null and exists (
    select 1 from inventory_lots lot
    where lot.business_id = new.business_id
      and lot.id = new.lot_id
      and lot.expiration_date < current_date
  ) then
    raise exception 'Expired lots cannot be approved as usable inventory.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_expired_inventory_movement() from public;
create trigger movements_block_expired_usable_stock
before insert on inventory_movements
for each row execute function app_private.prevent_expired_inventory_movement();

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
    adjustment.business_id, array['supervisor', 'administrator']::app_role[]
  ) then raise exception 'Supervisor or Administrator permission is required.'; end if;
  if adjustment.status <> 'pending' then raise exception 'This adjustment already has a decision.'; end if;

  select count(*) into line_count
  from inventory_adjustment_lines line
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;
  select count(*) into converted_count
  from inventory_adjustment_lines line
  join products product on product.business_id = line.business_id and product.id = line.product_id
  join product_unit_conversions conversion
    on conversion.business_id = line.business_id
    and conversion.product_id = line.product_id
    and conversion.from_unit = line.original_unit
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;
  if line_count = 0 or converted_count <> line_count then
    raise exception 'Every adjustment line requires one explicit conversion rule.';
  end if;
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
      and line.request_id = adjustment.id and line.original_quantity < 0
  ) then raise exception 'Only corrections may use negative quantities.'; end if;
  if adjustment.type = 'correction' then
    for stock in
      select line.product_id,
        sum(line.original_quantity * conversion.to_base_factor)::numeric(30, 12) as delta
      from inventory_adjustment_lines line
      join product_unit_conversions conversion
        on conversion.business_id = line.business_id
        and conversion.product_id = line.product_id
        and conversion.from_unit = line.original_unit
      where line.business_id = adjustment.business_id and line.request_id = adjustment.id
      group by line.product_id
      having bool_or(line.original_quantity < 0)
      order by line.product_id::text
    loop
      perform pg_advisory_xact_lock(app_private.inventory_stock_lock_key(
        adjustment.business_id, null, null, stock.product_id, null, null
      ));
      select coalesce(balance.quantity, 0) into available_quantity
      from inventory_balances balance
      where balance.business_id = adjustment.business_id and balance.product_id = stock.product_id;
      if coalesce(available_quantity, 0) + stock.delta < 0 then
        raise exception 'A correction cannot make inventory negative.';
      end if;
    end loop;
    for stock in
      select line.warehouse_id, line.location_id, line.product_id, line.lot_id, line.pallet_id,
        sum(line.original_quantity * conversion.to_base_factor)::numeric(30, 12) as delta
      from inventory_adjustment_lines line
      join product_unit_conversions conversion
        on conversion.business_id = line.business_id
        and conversion.product_id = line.product_id
        and conversion.from_unit = line.original_unit
      where line.business_id = adjustment.business_id and line.request_id = adjustment.id
      group by line.warehouse_id, line.location_id, line.product_id, line.lot_id, line.pallet_id
      having bool_or(line.original_quantity < 0)
      order by coalesce(line.warehouse_id::text, ''), coalesce(line.location_id::text, ''),
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
  if adjustment.type <> 'correction' and exists (
    select 1
    from inventory_adjustment_lines line
    join inventory_lots lot on lot.business_id = line.business_id and lot.id = line.lot_id
    where line.business_id = adjustment.business_id and line.request_id = adjustment.id
      and line.original_quantity > 0 and lot.expiration_date < current_date
  ) then raise exception 'Expired lots cannot be approved as usable inventory.'; end if;
  if adjustment.type = 'correction' and exists (
    select 1
    from inventory_adjustment_lines line
    join product_unit_conversions conversion
      on conversion.business_id = line.business_id
      and conversion.product_id = line.product_id
      and conversion.from_unit = line.original_unit
    left join inventory_balances balance
      on balance.business_id = line.business_id and balance.product_id = line.product_id
    where line.business_id = adjustment.business_id and line.request_id = adjustment.id
    group by line.product_id, balance.quantity
    having coalesce(balance.quantity, 0) + sum(line.original_quantity * conversion.to_base_factor) < 0
  ) then raise exception 'A correction cannot make inventory negative.'; end if;

  insert into inventory_transactions (
    id, business_id, request_id, idempotency_key, type,
    corrects_transaction_id, approved_by
  ) values (
    transaction_id, adjustment.business_id, adjustment.id, trim(request_idempotency_key),
    adjustment.type, adjustment.corrects_transaction_id, app_private.current_user_id()
  );
  insert into inventory_movements (
    business_id, transaction_id, adjustment_line_id, product_id, lot_id,
    original_quantity, original_unit, conversion_factor,
    normalized_quantity, normalized_unit, warehouse_id, location_id, pallet_id
  )
  select line.business_id, transaction_id, line.id, line.product_id, line.lot_id,
    line.original_quantity, line.original_unit, conversion.to_base_factor,
    line.original_quantity * conversion.to_base_factor, product.base_unit,
    line.warehouse_id, line.location_id, line.pallet_id
  from inventory_adjustment_lines line
  join products product on product.business_id = line.business_id and product.id = line.product_id
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
  when unique_violation then raise exception 'This adjustment or idempotency key was already applied.';
end;
$$;

create or replace function update_product_expiration_warning(
  target_product_id uuid,
  warning_days integer
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  target_business_id uuid;
begin
  select product.business_id into target_business_id
  from products product where product.id = target_product_id for update;
  if target_business_id is null then raise exception 'Product not found.'; end if;
  if not app_private.has_business_role(target_business_id, array['administrator']::app_role[]) then
    raise exception 'Administrator permission is required.';
  end if;
  if warning_days is null or warning_days not between 0 and 3650 then
    raise exception 'Expiration warning must be between 0 and 3,650 days.';
  end if;
  update products set expiration_warning_days = warning_days, updated_at = now()
  where id = target_product_id and business_id = target_business_id;
  return target_product_id;
end;
$$;

revoke all on function approve_inventory_adjustment(uuid, text) from public;
revoke all on function update_product_expiration_warning(uuid, integer) from public;
grant execute on function approve_inventory_adjustment(uuid, text) to authenticated;
grant execute on function update_product_expiration_warning(uuid, integer) to authenticated;

create or replace function record_receiving_delivery(
  target_business_id uuid,
  client_key text,
  delivery_payload jsonb,
  item_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  actor_id uuid := app_private.current_user_id();
  saved_delivery_id uuid;
  item jsonb;
  item_index integer := 0;
  item_sku text;
  item_brand text;
  item_name text;
  item_lot_code text;
  item_expiration_text text;
  item_expiration_date date;
  product_id uuid;
  lot_id uuid;
  received numeric;
  damaged numeric;
  accepted numeric;
  damaged_boxes numeric;
  damaged_units numeric;
  source_item_key text;
  review_id uuid;
  review_ids jsonb := '[]'::jsonb;
  normalized_key text := trim(coalesce(client_key, ''));
begin
  if not app_private.has_business_role(
    target_business_id, array['worker', 'supervisor', 'administrator']::app_role[]
  ) then raise exception 'Active business membership is required.'; end if;
  if length(normalized_key) not between 8 and 200 then
    raise exception 'A receiving idempotency key between 8 and 200 characters is required.';
  end if;
  select id into saved_delivery_id from receiving_deliveries
  where business_id = target_business_id and client_idempotency_key = normalized_key;
  if saved_delivery_id is not null then
    select coalesce(jsonb_agg(review.id order by review.requested_at), '[]'::jsonb)
      into review_ids from new_product_reviews review
      where review.business_id = target_business_id and review.delivery_id = saved_delivery_id;
    return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', review_ids, 'replayed', true);
  end if;
  if jsonb_typeof(item_payload) <> 'array' or jsonb_array_length(item_payload) = 0 then
    raise exception 'At least one receiving item is required.';
  end if;
  if exists (
    select 1 from (
      select lower(trim(coalesce(value->>'sku', ''))) as sku,
             lower(trim(coalesce(value->>'brand', ''))) as brand
      from jsonb_array_elements(item_payload)
      group by 1, 2 having count(*) > 1
    ) duplicate_items
  ) then raise exception 'A receiving delivery cannot contain duplicate SKU and brand lines.'; end if;
  if trim(coalesce(delivery_payload->>'supplier', '')) = ''
     or trim(coalesce(delivery_payload->>'delivered_on', '')) = '' then
    raise exception 'Supplier and delivery date are required.';
  end if;

  insert into receiving_deliveries (
    business_id, supplier, delivered_on, inspection_notes, recorded_by, client_idempotency_key
  ) values (
    target_business_id, trim(delivery_payload->>'supplier'),
    (delivery_payload->>'delivered_on')::date,
    trim(coalesce(delivery_payload->>'inspection_notes', '')), actor_id, normalized_key
  ) returning id into saved_delivery_id;

  for item in select value from jsonb_array_elements(item_payload) loop
    item_index := item_index + 1;
    item_sku := trim(coalesce(item->>'sku', ''));
    item_brand := trim(coalesce(item->>'brand', ''));
    item_name := trim(coalesce(item->>'product_name', ''));
    item_lot_code := nullif(trim(coalesce(item->>'lot_code', '')), '');
    item_expiration_text := nullif(trim(coalesce(item->>'expiration_date', '')), '');
    if item_expiration_text is not null and item_expiration_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Expiration date must use YYYY-MM-DD format.';
    end if;
    item_expiration_date := case when item_expiration_text is null then null else item_expiration_text::date end;
    received := (item->>'total_units')::numeric;
    damaged_boxes := coalesce((item->>'damaged_boxes')::numeric, 0);
    damaged_units := coalesce((item->>'damaged_units')::numeric, 0);
    damaged := (damaged_boxes * coalesce((item->>'units_per_box')::numeric, 0)) + damaged_units;
    accepted := received - damaged;
    source_item_key := lower(item_sku || '|' || item_brand || '|' || item_index::text);
    if item_sku = '' or item_name = '' or item_brand = '' then
      raise exception 'Each receiving item requires SKU, product name, and brand.';
    end if;
    if received <= 0 or damaged < 0 or accepted < 0 then
      raise exception 'Receiving quantities are invalid.';
    end if;
    if (item_lot_code is null) <> (item_expiration_date is null) then
      raise exception 'Batch or lot and expiration date must be supplied together.';
    end if;

    select product.id into product_id from products product
    where product.business_id = target_business_id
      and lower(trim(product.sku)) = lower(item_sku)
      and lower(trim(product.brand)) = lower(item_brand) and product.active;
    if product_id is null then
      insert into new_product_reviews (
        business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
        measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
        low_stock_threshold, reorder_threshold, lot_code, expiration_date, requested_by
      ) values (
        target_business_id, saved_delivery_id, source_item_key, item_sku, item_name, item_brand,
        trim(delivery_payload->>'supplier'), 'each', received, damaged, accepted, 0, 0,
        item_lot_code, item_expiration_date, actor_id
      ) returning id into review_id;
      review_ids := review_ids || to_jsonb(review_id);
    else
      lot_id := app_private.ensure_inventory_lot(
        target_business_id, product_id, item_lot_code, item_expiration_date
      );
      insert into receiving_items (
        business_id, delivery_id, product_id, lot_id, received_quantity, received_unit,
        damaged_package_quantity, damaged_package_unit, damaged_loose_quantity, damaged_loose_unit
      ) values (
        target_business_id, saved_delivery_id, product_id, lot_id, received, 'each',
        0, null, damaged, case when damaged > 0 then 'each'::unit_code else null end
      );
    end if;
  end loop;

  insert into receiving_delivery_events (business_id, delivery_id, event_type, acted_by, changes)
  values (
    target_business_id, saved_delivery_id, 'recorded', actor_id,
    jsonb_build_object('item_count', jsonb_array_length(item_payload), 'review_ids', review_ids)
  );
  return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', review_ids, 'replayed', false);
exception
  when unique_violation then
    select id into saved_delivery_id from receiving_deliveries
    where business_id = target_business_id and client_idempotency_key = normalized_key;
    if saved_delivery_id is not null then
      return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', '[]'::jsonb, 'replayed', true);
    end if;
    raise;
end;
$$;

commit;
