-- FreshRoute tenant access control and atomic approval workflow.
-- REVIEW ONLY: this migration has not been applied to any database or cloud service.
-- It assumes the authenticated gateway sets request.jwt.claim.sub to the identity-provider UUID.

begin;

create schema if not exists app_private;
revoke all on schema app_private from public;

create function app_private.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create function app_private.has_business_role(target_business_id uuid, allowed_roles app_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from business_memberships membership
    where membership.business_id = target_business_id
      and membership.user_id = app_private.current_user_id()
      and membership.status = 'active'
      and membership.invitation_accepted_at is not null
      and membership.role = any(allowed_roles)
  )
$$;

revoke all on function app_private.current_user_id() from public;
revoke all on function app_private.has_business_role(uuid, app_role[]) from public;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_user_id() to authenticated;
grant execute on function app_private.has_business_role(uuid, app_role[]) to authenticated;

alter table businesses enable row level security;
alter table app_users enable row level security;
alter table business_invitations enable row level security;
alter table business_memberships enable row level security;
alter table products enable row level security;
alter table product_unit_conversions enable row level security;
alter table inventory_lots enable row level security;
alter table receiving_deliveries enable row level security;
alter table receiving_items enable row level security;
alter table damage_photos enable row level security;
alter table inventory_adjustment_requests enable row level security;
alter table inventory_adjustment_lines enable row level security;
alter table inventory_transactions enable row level security;
alter table inventory_movements enable row level security;
alter table inventory_approval_events enable row level security;

-- Do not rely on provider-specific default grants. RLS and grants must both allow an action.
revoke all on
  businesses, app_users, business_invitations, business_memberships, products,
  product_unit_conversions, inventory_lots, receiving_deliveries, receiving_items,
  damage_photos, inventory_adjustment_requests, inventory_adjustment_lines,
  inventory_transactions, inventory_movements, inventory_approval_events,
  inventory_balances
from public;

grant select on
  businesses, app_users, business_invitations, business_memberships, products,
  product_unit_conversions, inventory_lots, receiving_deliveries, receiving_items,
  damage_photos, inventory_adjustment_requests, inventory_adjustment_lines,
  inventory_transactions, inventory_movements, inventory_approval_events,
  inventory_balances
to authenticated;

grant insert on business_invitations, products, product_unit_conversions,
  inventory_lots, receiving_deliveries, receiving_items, damage_photos,
  inventory_adjustment_requests, inventory_adjustment_lines
to authenticated;

grant update on products, product_unit_conversions to authenticated;
grant update (role, status) on business_memberships to authenticated;
grant delete on product_unit_conversions to authenticated;

create policy businesses_read_by_members on businesses
for select to authenticated
using (app_private.has_business_role(id, array['worker', 'supervisor', 'administrator']::app_role[]));

create policy users_read_self on app_users
for select to authenticated
using (id = app_private.current_user_id());

create policy memberships_read_same_business on business_memberships
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

-- Membership creation and invitation acceptance are reserved for a trusted server workflow.
-- Administrators may change only role/status columns on an existing membership.
create policy memberships_updated_by_admin on business_memberships
for update to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]))
with check (app_private.has_business_role(business_id, array['administrator']::app_role[]));

create policy invitations_read_by_admin on business_invitations
for select to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]));

create policy invitations_created_by_admin on business_invitations
for insert to authenticated
with check (
  app_private.has_business_role(business_id, array['administrator']::app_role[])
  and invited_by = app_private.current_user_id()
  and accepted_by is null
  and accepted_at is null
  and revoked_at is null
);

create policy products_read_by_members on products
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy products_managed_by_admin on products
for all to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]))
with check (app_private.has_business_role(business_id, array['administrator']::app_role[]));

create policy conversions_read_by_members on product_unit_conversions
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy conversions_managed_by_admin on product_unit_conversions
for all to authenticated
using (app_private.has_business_role(business_id, array['administrator']::app_role[]))
with check (
  app_private.has_business_role(business_id, array['administrator']::app_role[])
  and created_by = app_private.current_user_id()
);

create policy lots_read_by_members on inventory_lots
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy lots_created_by_members on inventory_lots
for insert to authenticated
with check (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy deliveries_read_by_members on receiving_deliveries
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy deliveries_created_by_members on receiving_deliveries
for insert to authenticated
with check (
  recorded_by = app_private.current_user_id()
  and app_private.has_business_role(
    business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  )
);

create policy receiving_items_read_by_members on receiving_items
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy receiving_items_created_by_members on receiving_items
for insert to authenticated
with check (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy damage_photos_read_by_members on damage_photos
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy damage_photos_created_by_members on damage_photos
for insert to authenticated
with check (
  uploaded_by = app_private.current_user_id()
  and app_private.has_business_role(
    business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  )
);

create policy requests_read_by_members on inventory_adjustment_requests
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy requests_created_by_authorized_members on inventory_adjustment_requests
for insert to authenticated
with check (
  status = 'pending'
  and requested_by = app_private.current_user_id()
  and (
    (type in ('receiving', 'count') and app_private.has_business_role(
      business_id,
      array['worker', 'supervisor', 'administrator']::app_role[]
    )) or
    (type in ('opening_balance', 'correction') and app_private.has_business_role(
      business_id,
      array['supervisor', 'administrator']::app_role[]
    ))
  )
);

create policy request_lines_read_by_members on inventory_adjustment_lines
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy request_lines_created_for_own_pending_request on inventory_adjustment_lines
for insert to authenticated
with check (
  app_private.has_business_role(
    business_id,
    array['worker', 'supervisor', 'administrator']::app_role[]
  )
  and exists (
    select 1 from inventory_adjustment_requests request
    where request.id = inventory_adjustment_lines.request_id
      and request.business_id = inventory_adjustment_lines.business_id
      and request.status = 'pending'
      and request.requested_by = app_private.current_user_id()
  )
);

create policy transactions_read_by_members on inventory_transactions
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy movements_read_by_members on inventory_movements
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

create policy approval_events_read_by_members on inventory_approval_events
for select to authenticated
using (app_private.has_business_role(
  business_id,
  array['worker', 'supervisor', 'administrator']::app_role[]
));

-- There are intentionally no client insert/update/delete grants or policies for transactions,
-- movements, or approval events. The security-definer workflow below is the only write path.

create function approve_inventory_adjustment(target_request_id uuid, request_idempotency_key text)
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
begin
  select * into adjustment
  from inventory_adjustment_requests
  where id = target_request_id
  for update;

  if not found then
    raise exception 'Adjustment request not found.';
  end if;
  if not app_private.has_business_role(
    adjustment.business_id,
    array['supervisor', 'administrator']::app_role[]
  ) then
    raise exception 'Supervisor or Administrator permission is required.';
  end if;
  if adjustment.status <> 'pending' then
    raise exception 'This adjustment already has a decision.';
  end if;

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

  if adjustment.type <> 'correction' and exists (
    select 1 from inventory_adjustment_lines line
    where line.business_id = adjustment.business_id
      and line.request_id = adjustment.id
      and line.original_quantity < 0
  ) then
    raise exception 'Only corrections may use negative quantities.';
  end if;

  if adjustment.type = 'correction' and exists (
    select 1
    from inventory_adjustment_lines line
    join product_unit_conversions conversion
      on conversion.business_id = line.business_id
      and conversion.product_id = line.product_id
      and conversion.from_unit = line.original_unit
    left join inventory_balances balance
      on balance.business_id = line.business_id and balance.product_id = line.product_id
    where line.business_id = adjustment.business_id
      and line.request_id = adjustment.id
    group by line.product_id, balance.quantity
    having coalesce(balance.quantity, 0) + sum(line.original_quantity * conversion.to_base_factor) < 0
  ) then
    raise exception 'A correction cannot make inventory negative.';
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
    normalized_quantity, normalized_unit
  )
  select
    line.business_id, transaction_id, line.id, line.product_id, line.lot_id,
    line.original_quantity, line.original_unit, conversion.to_base_factor,
    line.original_quantity * conversion.to_base_factor, product.base_unit
  from inventory_adjustment_lines line
  join products product
    on product.business_id = line.business_id and product.id = line.product_id
  join product_unit_conversions conversion
    on conversion.business_id = line.business_id
    and conversion.product_id = line.product_id
    and conversion.from_unit = line.original_unit
  where line.business_id = adjustment.business_id and line.request_id = adjustment.id;

  update inventory_adjustment_requests
  set status = 'approved'
  where id = adjustment.id;

  insert into inventory_approval_events (
    business_id, request_id, decision, decided_by
  ) values (
    adjustment.business_id, adjustment.id, 'approved', app_private.current_user_id()
  );

  return transaction_id;
exception
  when unique_violation then
    raise exception 'This adjustment or idempotency key was already applied.';
end;
$$;

create function reject_inventory_adjustment(target_request_id uuid, rejection_reason text)
returns void
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
declare
  adjustment inventory_adjustment_requests%rowtype;
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
  if adjustment.status <> 'pending' then
    raise exception 'This adjustment already has a decision.';
  end if;
  if length(trim(coalesce(rejection_reason, ''))) = 0 then
    raise exception 'A rejection reason is required.';
  end if;

  update inventory_adjustment_requests set status = 'rejected' where id = adjustment.id;
  insert into inventory_approval_events (
    business_id, request_id, decision, decided_by, reason
  ) values (
    adjustment.business_id, adjustment.id, 'rejected',
    app_private.current_user_id(), trim(rejection_reason)
  );
end;
$$;

revoke all on function approve_inventory_adjustment(uuid, text) from public;
revoke all on function reject_inventory_adjustment(uuid, text) from public;
grant execute on function approve_inventory_adjustment(uuid, text) to authenticated;
grant execute on function reject_inventory_adjustment(uuid, text) to authenticated;

commit;
