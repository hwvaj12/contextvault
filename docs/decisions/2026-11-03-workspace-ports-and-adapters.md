# Approved workspace architecture

Date: 2026-11-03, America/Chicago.
Source: explicit design approval in chat 01a1a255-17c8-7dd0-b1b7-5d4af16d854f.

The user approved Git and S3 revision adapters behind common ports.
ContextVault retains access control, accepted revisions, finalize, abort, audit, and recovery.
A transactional catalog holds the authoritative revision; immutable storage contains prepared and retained content.
Existing agents run in application workers, containers, local CLIs, and separate machines.
A workspace client materializes temporary files beside each agent.
AgentCore and S3 Files mounts are optional future adapters.

The initial approval requested an implementation plan.
The user subsequently approved implementation through the dependency waves with subagents.

Design: [approved design](../plans/2026-11-03-workspace-ports-and-adapters-design.md).
Plan: [implementation plan](../plans/2026-11-03-workspace-ports-and-adapters-implementation.md).

No ContextVault project exists among the available decision-ledger projects.
No decision was recorded in an unrelated project ledger.
