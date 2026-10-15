# Database review package

The SQL in this directory is an unapplied PostgreSQL design for FreshRoute's future commercial backend.

- `migrations/001_commercial_foundation.sql` creates the tenant, invitation, product, unit, receiving, adjustment, approval, transaction, and movement structures.
- `migrations/002_access_control_and_approval.sql` adds tenant policies and the atomic Supervisor/Administrator approval workflow.
- `migrations/003_warehouse_locations_and_transfers.sql` adds warehouse-aware locations, pallets, transfers, and source locks.
- `migrations/004_new_product_review.sql` preserves unfamiliar delivery lines for authenticated Supervisor/Administrator review, with correction, rejection, atomic product creation, accepted-quantity posting, and immutable audit events.
- `migrations/005_authenticated_commercial_workflows.sql` adds authenticated profile sync, invitation acceptance, atomic receiving persistence/idempotency, server-side delivery decisions, and durable receiving audit events.

Do not run these files against production. Before use, select an authentication/database provider, confirm its authenticated role and identity-claim format, then apply and test the migrations in a disposable local database.

For the Supabase/Vercel wiring, see [`docs/commercial-preview.md`](../docs/commercial-preview.md). Migration 005 is still unapplied review SQL in this repository; the hosted project must be a disposable Preview project until the release is approved.

The migrations contain no credentials, service URLs, customer records, or provider project identifiers.
