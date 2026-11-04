import type {
  ControlStore, WorkspaceMaterializer, ClaimFinalizationInput, ClaimWorkspaceCreationInput,
  AcceptWorkspaceCreationInput, ExpireActiveRunInput, ResourceLookupContext,
} from "../../src/ports";
import type {
  FinalizationOperation, WorkspaceCreationOperation, LocalClientSessionState,
  PendingClientCommand, ClientSessionId, Principal, RunId, OperationId, WorkspaceScope,
  Operation,
} from "../../src/domain/model";
import type { RunView } from "../../src/domain/http";

declare const store: ControlStore;
declare const materializer: WorkspaceMaterializer;
declare const finalizeClaim: ClaimFinalizationInput;
declare const creationClaim: ClaimWorkspaceCreationInput;
declare const creationAcceptance: AcceptWorkspaceCreationInput;
declare const expiry: ExpireActiveRunInput;
declare const lookup: ResourceLookupContext;
declare const runId: RunId;
declare const operationId: OperationId;
declare const publicRun: RunView;
declare const session: LocalClientSessionState;
declare const pending: PendingClientCommand;
declare const finalize: FinalizationOperation;
declare const creation: WorkspaceCreationOperation;
declare const sessionId: ClientSessionId;
declare const administrator: Extract<Principal, { kind: "administrator" }>;
declare const scope: WorkspaceScope;
declare const operation: Operation;

void store.claimFinalization(finalizeClaim);
void store.claimWorkspaceCreation(creationClaim);
void store.acceptWorkspaceCreation(creationAcceptance);
void store.listExpiredActiveRuns({ now: "2026-11-03T00:05:00.000Z", limit: 100 });
void store.expireActiveRun(expiry);
void store.resolveRun(lookup, runId);
void store.resolveOperation(lookup, operationId);
void materializer.createSession({ sessionId, serverOrigin: "https://vault.example.invalid" });
void materializer.savePrivateState({ ...session, pendingCommand: pending });
void materializer.create({ session, run: publicRun });
const mode: "read-only" | "read-write" = finalize.intent.mode;
const requestName: string = creation.intent.request.body.name;
const exactKey: string = pending.idempotencyKey;
const unknownServerIds: LocalClientSessionState = { ...session, workspaceId: null, run: null, path: null };
if (operation.kind === "finalize") {
  const storedMode: "read-only" | "read-write" = operation.intent.mode;
}

// @ts-expect-error Finalization recovery must retain the selected sealed source or explicit read-only selection.
const noIntent: FinalizationOperation = { ...finalize, intent: null };
// @ts-expect-error Initial revision acceptance requires a previously persisted creation operation and fence.
void store.acceptWorkspaceCreation({ scope });
// @ts-expect-error A client materializer cannot require server-private bindings.
void materializer.create({ session, scope: { ...scope, storageBindingId: "binding", bindingGeneration: 1 }, baseRevisionId: "revision" });
// @ts-expect-error Client-local handles must not expose internal storage scope.
void session.run?.storageBindingId;
// @ts-expect-error Administrator lookups must select one tenant and provide current authorization.
void store.resolveRun({ kind: "administrator", principal: administrator }, runId);
// @ts-expect-error Processing finalizations cannot become active-run expiry candidates.
void store.expireActiveRun({ ...expiry, expectedState: "finalizing" });
// @ts-expect-error Pending commands require their original idempotency key before HTTP dispatch.
const noRetryKey: PendingClientCommand = { kind: "workspace:create", request: creation.intent.request, operationId: null, phase: "prepared", preparedAt: "2026-11-03T00:00:00.000Z" };
// @ts-expect-error Read-only command state must never select or send a submission.
const readOnlyWithSubmission: PendingClientCommand = { kind: "finalize", mode: "read-only", selectedSubmission: null, idempotencyKey: "key", request: { method: "POST", path: "/v1/runs/run/finalize", body: { expectedRunVersion: 1, submissionId: "sub" } }, operationId: null, phase: "prepared", preparedAt: "2026-11-03T00:00:00.000Z" };

// @ts-expect-error A finalization cannot contain an abort result.
const wrongFinalizeResult: FinalizationOperation = { ...finalize, result: { kind: "abort", runState: "aborted", revisionId: null, changed: false } };
// @ts-expect-error Workspace creation cannot contain a restore result.
const wrongCreationResult: WorkspaceCreationOperation = { ...creation, result: { kind: "restore", revisionId: creation.intent.candidateIdentity.revisionId, changed: true } };
