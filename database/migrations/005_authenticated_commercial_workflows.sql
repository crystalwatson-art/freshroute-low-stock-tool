-- FreshRoute authenticated commercial workflows.
-- REVIEW ONLY: apply to a disposable Supabase project first. Never apply to production
-- without the migration/rollback review and backup process described in the docs.
-- This migration assumes migrations 001-004 have already been applied.

begin;

alter table receiving_deliveries
  add column client_idempotency_key text
    check (client_idempotency_key is null or length(trim(client_idempotency_key)) between 8 and 200);

create unique index receiving_deliveries_business_client_key_unique
  on receiving_deliveries (business_id, client_idempotency_key)
  where client_idempotency_key is not null;

create table receiving_delivery_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_id uuid not null,
  event_type text not null check (event_type in ('recorded')),
  acted_by uuid not null references app_users(id),
  acted_at timestamptz not null default now(),
  reason text not null default '' check (length(reason) <= 1000),
  changes jsonb not null default '{}'::jsonb,
  foreign key (business_id, delivery_id)
    references receiving_deliveries(business_id, id) on delete restrict,
  unique (business_id, id)
);

create index receiving_delivery_events_by_delivery
  on receiving_delivery_events (business_id, delivery_id, acted_at);

alter table receiving_delivery_events enable row level security;
revoke all on receiving_delivery_events from public;
grant select on receiving_delivery_events to authenticated;

create policy receiving_delivery_events_read_by_members on receiving_delivery_events
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create trigger receiving_delivery_events_are_immutable
before update or delete on receiving_delivery_events
for each row execute function prevent_inventory_history_mutation();

create function app_private.current_user_email()
returns text
language plpgsql
stable
as $$
declare
  direct_email text := lower(trim(nullif(current_setting('request.jwt.claim.email', true), '')));
  claims text := current_setting('request.jwt.claims', true);
begin
  if direct_email is not null then return direct_email; end if;
  if claims is not null and claims <> '' then
    return lower(trim((claims::jsonb ->> 'email')));
  end if;
  return null;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function app_private.current_user_email() from public;
grant execute on function app_private.current_user_email() to authenticated;

create or replace function app_private.sync_current_app_user(
  profile_email text,
  profile_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  actor_id uuid := app_private.current_user_id();
  normalized_email text := lower(trim(coalesce(profile_email, '')));
  normalized_name text := trim(coalesce(profile_display_name, ''));
  verified_email text := app_private.current_user_email();
begin
  if actor_id is null then raise exception 'An authenticated session is required.'; end if;
  if verified_email is null or verified_email = '' then
    raise exception 'A verified account email claim is required.';
  end if;
  if normalized_email <> verified_email then
    raise exception 'The profile email must match the authenticated account.';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid account email is required.';
  end if;
  if length(normalized_name) not between 1 and 120 then
    raise exception 'Display name must be between 1 and 120 characters.';
  end if;

  insert into app_users (id, email, display_name)
  values (actor_id, normalized_email, normalized_name)
  on conflict (id) do update
    set email = excluded.email, display_name = excluded.display_name;
  return actor_id;
end;
$$;

revoke all on function app_private.sync_current_app_user(text, text) from public;
grant execute on function app_private.sync_current_app_user(text, text) to authenticated;

-- PostgREST exposes the public schema RPC surface. This wrapper delegates to the
-- locked-down implementation and does not expose a browser-controlled user ID.
create function sync_current_app_user(
  profile_email text,
  profile_display_name text
)
returns uuid
language sql
security definer
set search_path = public, app_private, pg_temp
as $$
  select app_private.sync_current_app_user(profile_email, profile_display_name)
$$;

revoke all on function sync_current_app_user(text, text) from public;
grant execute on function sync_current_app_user(text, text) to authenticated;

create function create_business_invitation(
  target_business_id uuid,
  invite_email text,
  invite_role app_role,
  invite_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  invitation_id uuid;
  actor_id uuid := app_private.current_user_id();
  normalized_email text := lower(trim(coalesce(invite_email, '')));
  normalized_hash text := lower(trim(coalesce(invite_token_hash, '')));
begin
  if not app_private.has_business_role(target_business_id, array['administrator']::app_role[]) then
    raise exception 'Administrator permission is required.';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid invitation email is required.';
  end if;
  if normalized_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invitation token hash is invalid.';
  end if;

  insert into business_invitations (
    business_id, email, role, token_hash, invited_by, expires_at
  ) values (
    target_business_id, normalized_email, invite_role, normalized_hash,
    actor_id, now() + interval '7 days'
  ) returning id into invitation_id;
  return invitation_id;
exception
  when unique_violation then
    raise exception 'An open invitation already exists for this email.';
end;
$$;

create function accept_business_invitation(
  target_invitation_id uuid,
  invitation_token text,
  profile_email text,
  profile_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  invitation business_invitations%rowtype;
  actor_id uuid;
  normalized_email text := lower(trim(coalesce(profile_email, '')));
begin
  actor_id := app_private.sync_current_app_user(profile_email, profile_display_name);
  select * into invitation
  from business_invitations
  where id = target_invitation_id
  for update;
  if not found then raise exception 'Invitation not found.'; end if;
  if invitation.accepted_at is not null or invitation.revoked_at is not null then
    raise exception 'This invitation is no longer available.';
  end if;
  if invitation.expires_at <= now() then raise exception 'This invitation has expired.'; end if;
  if lower(invitation.email) <> normalized_email then
    raise exception 'This invitation was issued to a different email address.';
  end if;
  if encode(digest(trim(coalesce(invitation_token, '')), 'sha256'), 'hex') <> invitation.token_hash then
    raise exception 'The invitation token is invalid.';
  end if;

  insert into business_memberships (
    business_id, user_id, role, status, invitation_id, invitation_accepted_at
  ) values (
    invitation.business_id, actor_id, invitation.role, 'active', invitation.id, now()
  )
  on conflict (business_id, user_id) do update
    set role = excluded.role, status = 'active',
        invitation_id = excluded.invitation_id,
        invitation_accepted_at = excluded.invitation_accepted_at;

  update business_invitations
  set accepted_by = actor_id, accepted_at = now()
  where id = invitation.id;
  return invitation.business_id;
end;
$$;

revoke all on function create_business_invitation(uuid, text, app_role, text) from public;
revoke all on function accept_business_invitation(uuid, text, text, text) from public;
grant execute on function create_business_invitation(uuid, text, app_role, text) to authenticated;
grant execute on function accept_business_invitation(uuid, text, text, text) to authenticated;

create function record_receiving_delivery(
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
  product_id uuid;
  received numeric;
  damaged numeric;
  accepted numeric;
  boxes numeric;
  damaged_boxes numeric;
  damaged_units numeric;
  source_item_key text;
  review_id uuid;
  review_ids jsonb := '[]'::jsonb;
  normalized_key text := trim(coalesce(client_key, ''));
begin
  if not app_private.has_business_role(
    target_business_id, array['worker', 'supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'Active business membership is required.';
  end if;
  if length(normalized_key) not between 8 and 200 then
    raise exception 'A receiving idempotency key between 8 and 200 characters is required.';
  end if;
  select id into saved_delivery_id
  from receiving_deliveries
  where business_id = target_business_id and client_idempotency_key = normalized_key;
  if saved_delivery_id is not null then
    select coalesce(jsonb_agg(review.id order by review.requested_at), '[]'::jsonb)
      into review_ids
    from new_product_reviews review
    where review.business_id = target_business_id and review.delivery_id = saved_delivery_id;
    return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', review_ids, 'replayed', true);
  end if;

  if jsonb_typeof(item_payload) <> 'array' or jsonb_array_length(item_payload) = 0 then
    raise exception 'At least one receiving item is required.';
  end if;

  if trim(coalesce(delivery_payload->>'supplier', '')) = ''
     or trim(coalesce(delivery_payload->>'delivered_on', '')) = '' then
    raise exception 'Supplier and delivery date are required.';
  end if;

  insert into receiving_deliveries (
    business_id, supplier, delivered_on, inspection_notes, recorded_by, client_idempotency_key
  ) values (
    target_business_id,
    trim(delivery_payload->>'supplier'),
    (delivery_payload->>'delivered_on')::date,
    trim(coalesce(delivery_payload->>'inspection_notes', '')),
    actor_id, normalized_key
  ) returning id into saved_delivery_id;

  for item in select value from jsonb_array_elements(item_payload) loop
    item_index := item_index + 1;
    item_sku := trim(coalesce(item->>'sku', ''));
    item_brand := trim(coalesce(item->>'brand', ''));
    item_name := trim(coalesce(item->>'product_name', ''));
    boxes := (item->>'total_boxes')::numeric;
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

    select product.id into product_id
    from products product
    where product.business_id = target_business_id
      and lower(trim(product.sku)) = lower(item_sku)
      and lower(trim(product.brand)) = lower(item_brand)
      and product.active;

    if product_id is null then
      insert into new_product_reviews (
        business_id, delivery_id, source_item_key, sku, product_name, brand, supplier,
        measurement_unit, received_quantity, damaged_quantity, accepted_quantity,
        low_stock_threshold, reorder_threshold, requested_by
      ) values (
        target_business_id, saved_delivery_id, source_item_key, item_sku, item_name, item_brand,
        trim(delivery_payload->>'supplier'), 'each', received, damaged, accepted, 0, 0, actor_id
      ) returning id into review_id;
      review_ids := review_ids || to_jsonb(review_id);
    else
      insert into receiving_items (
        business_id, delivery_id, product_id, received_quantity, received_unit,
        damaged_package_quantity, damaged_package_unit,
        damaged_loose_quantity, damaged_loose_unit
      ) values (
        target_business_id, saved_delivery_id, product_id, received, 'each',
        0, null,
        damaged, case when damaged > 0 then 'each'::unit_code else null end
      );
    end if;
  end loop;

  insert into receiving_delivery_events (
    business_id, delivery_id, event_type, acted_by, changes
  ) values (
    target_business_id, saved_delivery_id, 'recorded', actor_id,
    jsonb_build_object('item_count', jsonb_array_length(item_payload), 'review_ids', review_ids)
  );
  return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', review_ids, 'replayed', false);
exception
  when unique_violation then
    select id into saved_delivery_id
    from receiving_deliveries
    where business_id = target_business_id and client_idempotency_key = normalized_key;
    if saved_delivery_id is not null then
      return jsonb_build_object('delivery_id', saved_delivery_id, 'review_ids', '[]'::jsonb, 'replayed', true);
    end if;
    raise;
end;
$$;

revoke all on function record_receiving_delivery(uuid, text, jsonb, jsonb) from public;
grant execute on function record_receiving_delivery(uuid, text, jsonb, jsonb) to authenticated;

create function list_receiving_records(target_business_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app_private, pg_temp
as $$
  select coalesce(jsonb_agg(row_data order by (row_data->>'savedAt') desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', delivery.id,
      'supplier', delivery.supplier,
      'deliveryDate', delivery.delivered_on,
      'notes', delivery.inspection_notes,
      'savedAt', delivery.recorded_at,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku', product.sku, 'productName', product.name, 'brand', product.brand,
          'totalUnits', item.received_quantity,
          'totalDamagedUnits', item.damaged_package_quantity + item.damaged_loose_quantity,
          'usableUnits', item.received_quantity - item.damaged_package_quantity - item.damaged_loose_quantity,
          'totalBoxes', 0,
          'damagedBoxes', 0,
          'damagedUnits', item.damaged_loose_quantity,
          'unitsPerBox', 1
        ) order by item.created_at)
        from receiving_items item
        join products product on product.business_id = item.business_id and product.id = item.product_id
        where item.business_id = delivery.business_id and item.delivery_id = delivery.id
      ), '[]'::jsonb) || coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku', review.sku, 'productName', review.product_name, 'brand', review.brand,
          'totalUnits', review.received_quantity,
          'totalDamagedUnits', review.damaged_quantity,
          'usableUnits', review.accepted_quantity,
          'totalBoxes', 0, 'damagedBoxes', 0, 'damagedUnits', review.damaged_quantity,
          'unitsPerBox', 1, 'newProductReviewId', review.id, 'reviewStatus', review.status
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
      'sourceKey', 'commercial:' || target_business_id::text,
      'sourceLabel', 'Commercial business records'
    ) as row_data
    from receiving_deliveries delivery
    where delivery.business_id = target_business_id
      and app_private.has_business_role(target_business_id, array['worker', 'supervisor', 'administrator']::app_role[])
  ) records;
$$;

revoke all on function list_receiving_records(uuid) from public;
grant execute on function list_receiving_records(uuid) to authenticated;

create function decide_receiving_delivery(
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
  select * into delivery
  from receiving_deliveries
  where id = target_delivery_id
  for update;
  if not found then raise exception 'Receiving delivery not found.'; end if;
  if not app_private.has_business_role(delivery.business_id, array['supervisor', 'administrator']::app_role[]) then
    raise exception 'Supervisor or Administrator permission is required.';
  end if;
  if normalized_decision not in ('approve', 'reject') then
    raise exception 'Delivery decision must be approve or reject.';
  end if;
  if normalized_reason = '' then raise exception 'A decision reason is required.'; end if;
  if length(normalized_key) not between 8 and 200 then
    raise exception 'A decision idempotency key between 8 and 200 characters is required.';
  end if;

  select transaction.id into existing_transaction
  from inventory_transactions transaction
  where transaction.business_id = delivery.business_id
    and transaction.idempotency_key = normalized_key;
  if existing_transaction is not null then return existing_transaction; end if;

  if normalized_decision = 'approve' and exists (
    select 1 from new_product_reviews review
    where review.business_id = delivery.business_id
      and review.delivery_id = delivery.id
      and review.status <> 'approved'
  ) then
    raise exception 'Every unfamiliar SKU must be approved before the delivery can be posted.';
  end if;

  select id into adjustment_id
  from inventory_adjustment_requests
  where business_id = delivery.business_id
    and source_reference = 'receiving-delivery:' || delivery.id::text
  for update;

  if adjustment_id is null then
    insert into inventory_adjustment_requests (
      business_id, type, source_reference, delivery_id, reason, requested_by
    ) values (
      delivery.business_id, 'receiving', 'receiving-delivery:' || delivery.id::text,
      delivery.id, normalized_reason, delivery.recorded_by
    ) returning id into adjustment_id;

    insert into inventory_adjustment_lines (
      business_id, request_id, product_id, original_quantity, original_unit
    )
    select item.business_id, adjustment_id, item.product_id,
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

revoke all on function decide_receiving_delivery(uuid, text, text, text) from public;
grant execute on function decide_receiving_delivery(uuid, text, text, text) to authenticated;

commit;
