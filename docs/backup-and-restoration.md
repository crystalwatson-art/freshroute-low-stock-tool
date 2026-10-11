# Backup and restoration requirements

FreshRoute does not yet have a commercial database or photograph store. These are requirements for selecting and configuring them; no service has been created.

## Decisions required before launch

The business owner must approve:

- **Recovery point objective (RPO):** how much recent data may be lost. A reasonable initial target is no more than 15 minutes for inventory movements.
- **Recovery time objective (RTO):** how long restoration may take. A reasonable initial target is four hours.
- **Retention:** how long daily, weekly, monthly, and audit records must be kept.
- **Region and residency:** where database backups and photographs may be stored.
- **Photograph retention:** when damage photographs may be deleted and whether legal holds are required.

These values are proposals, not promises, until the selected provider and budget are approved.

## Database protection

The production database should provide:

1. Encrypted automated backups with documented retention.
2. Point-in-time recovery or frequent transaction-log archiving consistent with the approved RPO.
3. A separate encrypted export stored in a different account or failure domain.
4. Restricted backup access with multi-factor authentication and access logging.
5. Alerts for failed or stale backups.
6. A record of schema migration versions alongside each recovery procedure.

Backups must include business memberships, invitations, products, conversions, lots, receiving records, requests, approvals, transactions, and movements. Authentication-provider configuration and invitation/email templates need their own configuration backup or reproducible setup documentation.

## Photograph protection

Database backups normally protect only photograph metadata, not the image files. Damage photographs therefore need a separate process:

- Use a private bucket; never a public URL or predictable shared path.
- Prefix or otherwise bind every object to its business and delivery.
- Permit access only through tenant-aware authorization or short-lived signed links.
- Enable encryption, versioning or protected copies, retention rules, and deletion logging.
- Back up objects to a separate protected location or use provider-supported replication.
- Record and periodically verify a SHA-256 checksum for every object.
- Ensure a database restore and object restore can be reconciled using `damage_photos.object_key` and `sha256`.

Photographs must not be included in application logs, analytics, test fixtures, or source control.

## Restore procedure

At least quarterly, and before a major migration:

1. Restore the database into an isolated non-production environment.
2. Restore a representative private photograph set without making it public.
3. Verify table counts, tenant separation, membership access, conversion rules, and movement totals.
4. Recalculate inventory balances from movements and compare them with the pre-backup control totals.
5. Verify that a sample of photograph metadata matches object checksums.
6. Test sign-in and role restrictions using non-production accounts.
7. Record elapsed time, lost-data window, errors, and corrective actions.
8. Destroy the temporary restoration safely after the evidence is retained.

A backup is not considered reliable until this restore procedure succeeds.

## Operational safeguards

- Never use a production backup in local development without approved sanitization.
- Never place database credentials, recovery keys, invite tokens, or signed photograph URLs in the repository.
- Separate production, test, and classroom-demo data.
- Require approval and logging for backup deletion or retention changes.
- Review restore access after staff or vendor changes.
