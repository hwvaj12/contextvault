import type { ControlStore, RevisionStore, SubmissionStore, AccessPolicy, WorkspaceMaterializer, AcceptRevisionInput, ReadOnlyCompletionInput, PrepareRevisionInput, WriteSubmissionFileInput, SwitchStorageBindingInput } from "../../src/ports";
import type { WorkspaceScope, RunScope, Principal, WorkspaceId, RevisionId } from "../../src/domain/model";
import type { RunView } from "../../src/domain/http";
import type { LocalClientSessionState } from "../../src/domain/model";

declare const control: ControlStore;
declare const revisions: RevisionStore;
declare const submissions: SubmissionStore;
declare const policy: AccessPolicy;
declare const materializer: WorkspaceMaterializer;
declare const publication: AcceptRevisionInput;
declare const readOnly: ReadOnlyCompletionInput;
declare const prepare: PrepareRevisionInput;
declare const upload: WriteSubmissionFileInput;
declare const scope: WorkspaceScope;
declare const runScope: RunScope;
declare const principal: Principal;
declare const revisionId: RevisionId;
declare const workspaceId: WorkspaceId;
declare const migrationSwitch: SwitchStorageBindingInput;
declare const publicRun: RunView;
declare const clientSession: LocalClientSessionState;

void control.acceptRevision(publication);
void control.completeReadOnly(readOnly);
void control.switchStorageBinding(migrationSwitch);
void control.listWorkspaces({ customerId: scope.customerId });
void revisions.prepare(prepare);
void submissions.writeFile(upload);
void policy.evaluate(principal, "workspace:read", scope);
void materializer.create({ session: clientSession, run: publicRun });

// @ts-expect-error Publication requires versions, expected head, current authorization, and a finalizer fence.
void control.acceptRevision({ scope });
// @ts-expect-error Workspace and revision identifiers are separate opaque values.
const wrongRevision: RevisionId = workspaceId;
// @ts-expect-error No missing-identity administrator sentinel is allowed.
const absentPrincipal: Principal = null;
// @ts-expect-error Read-only completion does not accept a submission.
void control.completeReadOnly({ ...readOnly, submissionId: "submission" });
// @ts-expect-error Read-only completion must not compare a pinned read with the current head or content version.
void control.completeReadOnly({ ...readOnly, expectedWorkspaceVersion: 1 });
// @ts-expect-error Cutover requires verified revision copies, expected versions, and a migration fence.
void control.switchStorageBinding({ scope });
// @ts-expect-error File payloads use byte streams rather than JSON text.
void submissions.writeFile({ ...upload, bytes: "content" });
// @ts-expect-error A revision adapter cannot publish an authoritative head.
void revisions.publish(publication);
