# Workspace runtime authority clarifications

Date: 2026-11-03, America/Chicago.
Scope: implementation clarifications within the approved workspace architecture.
Source: integration reviews and the lead's current-authority interpretation.

Configured administrator key rotation invalidates older configured credentials for future publication.
Startup synchronizes catalog-backed configuration authority before starting automatic recovery.
Authentication cannot rotate that stored configuration backward or recreate revoked authority.
Configured-key synchronization must not revoke unrelated external or service credentials.
The catalog stores provenance and fingerprints, rather than plaintext keys.
CV-11 owns the synchronization hook; CV-16 owns startup ordering.

The caller stops agent writers before local capture and cleanup.
Existing agents retain execution and process-isolation ownership.
An explicit cleanup call follows agent completion or a confirmed stop.
The client does not infer process termination from a run's terminal catalog state.
Server staging stays private and is never mounted into agent workspaces.
Filesystem validation does not claim containment of hostile concurrent processes sharing the host identity.
If the caller cannot establish the precondition, the client retains the workspace and reports pending cleanup.
Uncertain publication still requires reconciliation before cleanup or abort.

Maintenance reads remain catalog operations.
Collection verification, frozen outbox recipients, and cleanup targets must receive explicit port seams before CV-17 uses them.
Application services must not query SQLite directly or infer acceptance from storage objects.

The user selected LocalStack for S3 verification on 2026-11-04.
The release matrix retains all-host requirements against that selected target.
Reports identify LocalStack evidence and leave AWS service parity unverified.
