# Database review package

The SQL in this directory is an unapplied PostgreSQL design for FreshRoute's future commercial backend.

- `migrations/001_commercial_foundation.sql` creates the tenant, invitation, product, unit, receiving, adjustment, approval, transaction, and movement structures.
- `migrations/002_access_control_and_approval.sql` adds tenant policies and the atomic Supervisor/Administrator approval workflow.

Do not run these files against production. Before use, select an authentication/database provider, confirm its authenticated role and identity-claim format, then apply and test the migrations in a disposable local database.

The migrations contain no credentials, service URLs, customer records, or provider project identifiers.
