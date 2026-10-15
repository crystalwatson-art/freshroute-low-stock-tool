# FreshRoute commercial data foundation

This document describes the review-ready commercial foundation. Nothing in `database/` has been applied to a database or connected to a cloud service. The current dashboard still uses its existing browser-only data.

## Boundaries

- The original 4,325-record classroom dataset remains a separate historical demo. It is not a tenant and must never be copied into commercial customer records automatically.
- Commercial records belong to exactly one business. Every tenant-owned table carries `business_id`, and composite foreign keys prevent records from crossing businesses accidentally.
- Authentication must come from a production identity provider. FreshRoute stores a user profile and accepted business membership, but never passwords.
- Accounts are invitation-only. A user needs an accepted, active invitation-backed membership before any business data is available.
- Membership creation and invitation acceptance must run through a trusted server workflow; an Administrator cannot create an active membership directly from the browser.
- The browser never has permission to write an applied inventory movement directly.

## Relationships

```text
Business
├── Invitations ── accepted by ── User
├── Memberships ── User + role (Worker, Supervisor, Administrator)
├── Products
│   ├── Unit conversion rules
│   └── Inventory lots
├── Receiving deliveries
│   ├── Receiving items ── Product / optional lot
│   └── Private damage-photo metadata
└── Adjustment requests
    ├── Adjustment lines ── Product / optional lot + original measurement
    ├── Approval event ── deciding Supervisor or Administrator
    └── Applied transaction
        └── Immutable inventory movements
```

An unfamiliar SKU is stored as a `new_product_reviews` record linked to the
delivery. It is not discarded and it does not bypass the existing product
foreign keys. A trusted database function locks the review, verifies the
authenticated tenant role and product identity, creates the product and its
base-unit rule, and posts only the accepted quantity in one transaction.

The current balance is the sum of immutable normalized movements. There is no independently editable stock total that can drift away from its history.

## Roles

| Capability | Worker | Supervisor | Administrator |
| --- | --- | --- | --- |
| View inventory and movements | Yes | Yes | Yes |
| Record receiving information | Yes | Yes | Yes |
| Submit a pending receiving/count adjustment | Yes | Yes | Yes |
| Approve or reject an adjustment | No | Yes | Yes |
| Create a traceable correction | No | Yes | Yes |
| Manage products and conversion rules | No | No | Yes |
| Invite users and manage memberships | No | No | Yes |

The local adapter enforces this matrix for tests. The SQL policies enforce it at the database boundary. Interface visibility alone is not treated as permission.

New-product approval uses the same server-side Supervisor/Administrator
boundary. A browser-entered name is never used as authorization. The static
classroom dashboard remains explicitly demonstration-only because it has no
identity provider or persistent commercial connection.

## Units and conversions

Supported input units are:

- `each`, `boxes`, and `cases`
- `kg` and `g`
- `L` and `mL`

Each product has one non-packaging base unit: `each`, `kg`, `g`, `L`, or `mL`. Every accepted input unit must have one explicit factor to that base unit.

Examples:

```text
Milk base unit: L
1 mL   = 0.001 L       (metric rule)
1 case = 12 L          (product-specific packaging rule)

Eggs base unit: each
1 box  = 12 each       (product-specific packaging rule)
1 case = 144 each      (separate explicit rule)
```

FreshRoute does not infer a case from a box rule and does not convert mass to volume. An entry in liters for a kilogram-based product fails unless the data model is deliberately extended and reviewed. Discrete units must be whole numbers. Decimal strings are used in the commercial modules so calculations do not depend on binary floating-point rounding.

Each movement preserves:

- The quantity and unit entered by the user.
- The conversion factor used at that time.
- The normalized quantity and product base unit.
- The business, product, source transaction, actor, role, and timestamp.

Changing a product's future conversion rules does not rewrite old movements.

## Adjustment workflow

1. An authorized member records a delivery or count.
2. FreshRoute creates a pending adjustment request and its original measurements.
3. A Supervisor or Administrator reviews it.
4. The approval database function locks the request, verifies the role and tenant, verifies every conversion, checks correction balances, and writes the approval, transaction, and movements in one transaction.
5. A unique business-scoped idempotency key and a unique request-to-transaction relationship prevent duplicate application.
6. A rejection records the decision and reason but creates no movement.
7. A correction references the earlier transaction and appends signed movements. It cannot modify the original transaction or make stock negative.

## Data-access interface

`commercial-data-access.js` defines a small interface used by any data source:

- `listProducts(context)`
- `getInventoryBalances(context)`
- `listMovements(context)`
- `approveAdjustment(context, command)`
- `createCorrection(context, command)`

`createInMemoryCommercialAdapter()` is a non-persistent test implementation. It demonstrates permission, tenant, conversion, idempotency, and correction behavior without claiming to provide authentication or durable storage.

`createClassroomDemoAdapter()` is intentionally read-only. It provides a future seam for the current demo without allowing classroom data to enter the commercial ledger.

The commercial Vercel handlers call authenticated PostgreSQL RPCs with the signed-in Supabase bearer token. The user identity comes from the verified session and database claim, never from an editable form field. The classroom adapter remains separate and read-only.

## Migration review notes

The SQL files target PostgreSQL 15 or later and assume the future authenticated gateway:

- Creates an `authenticated` database role.
- Places the verified identity-provider UUID in `request.jwt.claim.sub`.
- Uses TLS and server-managed secrets.

These assumptions match common Postgres API gateways but must be confirmed against the selected provider before applying anything. Migrations must first be applied to an isolated local or development database, reviewed, and tested with both allowed and denied access cases.

The migration intentionally does not contain provider credentials, project identifiers, storage bucket names, production URLs, or customer data.

## Before connecting a backend

- Choose the authentication and database provider and region.
- Decide invitation expiry, account recovery, session lifetime, and whether MFA is required.
- Confirm SKU base units, decimal precision, packaging rules, and treatment of partial packages.
- Configure the authenticated adapter and trusted invitation-creation and acceptance workflows described in `docs/commercial-preview.md`.
- Keep the server integration tests running against a disposable PostgreSQL/Supabase environment.
- Test migrations forward and backward on disposable data.
- Run database policy tests as every role and as a user from another business.
- Decide backup retention and recovery targets, then complete a restore drill.
- Configure private photograph storage and its independent backup process.
- Add monitoring for failed approvals, duplicate attempts, policy denials, and backup failures.
