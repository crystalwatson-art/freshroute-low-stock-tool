# FreshRoute commercial preview runbook

The commercial path is implemented but is intentionally inactive until a Supabase project and a Vercel preview are configured. The classroom CSV and browser `localStorage` path is separate and is never copied into commercial tables.

## Supabase setup

1. Create a disposable development Supabase project. Do not use the production project for migration testing.
2. Apply migrations `001` through `006` in order using the Supabase SQL editor or a reviewed migration pipeline. Do not apply them from the browser and do not skip the isolated PostgreSQL test first.
3. In Authentication, enable the selected email sign-in and recovery method. Set the project Site URL and redirect allow-list to the Vercel preview URL and its `#settings` recovery route.
4. Configure the invitation email template to include the invitation metadata supplied by the server (`freshroute_invitation_id` and `freshroute_invitation_token`) in a link back to the app's invitation acceptance view. Keep the token out of logs and analytics.
5. Decide whether email confirmation, MFA, session lifetime, invitation expiry, and password policy meet the launch policy. The database invitation expires after seven days.
6. Configure private object storage separately before enabling damage-photo persistence. The current commercial receiving endpoint stores delivery data and audit metadata; it does not upload photo bytes.

## Vercel settings

Set these variables in the Vercel project for Preview only while validating:

- `SUPABASE_URL`: the development project URL.
- `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`): the public client key. `/api/config` returns only this public key.
- `SUPABASE_SERVICE_ROLE_KEY`: a server-only Vercel secret required for Supabase invitation email delivery. Never expose it to the browser, commit it, or print it.

Use separate Preview and Production values. Production values must not be added until a reviewed release is approved. The API handlers forward the authenticated user's bearer token to PostgREST, so row-level security remains the authorization boundary. The service key is used only by the server invitation-email call.

After setting variables, redeploy the preview. A successful `/api/config` response and a successful sign-in/profile request establish configuration; they do not by themselves prove a production launch.

## Verification sequence

1. Create a test account in the isolated project and sign in from Settings.
2. Invite a second test account as Worker and Supervisor; confirm the recipient accepts the invitation before seeing business data.
3. Record a delivery, including a batch/lot and expiration date when the stock is dated. Confirm two lots for one SKU retain separate quantities and dates. Known product lines and unfamiliar SKU lines are saved by one PostgreSQL transaction. Repeat the request with the same idempotency key and confirm one delivery only.
4. Confirm a Worker cannot approve a delivery or new product. Approve as Supervisor and confirm only accepted usable quantity creates immutable inventory movement rows.
5. Repeat approval and run concurrent approvals; confirm one transaction and one audit trail. Test a second business account for cross-tenant denial.
6. Test recovery email, sign-out, expired/revoked invitation, interrupted network retry, duplicate SKU, invalid quantities, correction request, rejection, and failed transaction rollback.
7. As an Administrator, set a product-specific expiration warning period. Confirm the Inventory workspace marks matching lots as expiring soon and that an expired lot cannot be approved as usable stock.

## Backups and launch requirements

Before a real customer preview, configure Supabase backups/PITR according to the recovery target, perform a restore drill, restrict dashboard access with MFA, and monitor Auth, API, database policy-denial, approval, and backup failures. Keep the private photo bucket and its backup policy tenant-scoped. No production migration, customer data, billing activation, or production deployment was performed by this change.

The repository has no committed build system: Vercel serves the static frontend and Node-compatible `/api` functions directly. A preview is ready to attempt only after the required Vercel project and Supabase Preview variables are supplied and the end-to-end checks above pass.
