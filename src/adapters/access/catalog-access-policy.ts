import type { AccessPolicy, AccessDecision } from "../../ports/access-policy";
import type { ControlStore, CredentialAuthority } from "../../ports/control-store";
import type { Action, CustomerScope, Principal, WorkspaceScope } from "../../domain";
export function decideAccess(authority: CredentialAuthority | null, principal: Principal, action: Action, scope: CustomerScope | WorkspaceScope): AccessDecision {
    if (!principal || !principal.credential || !principal.actorId || !scope?.customerId || !["customer", "service", "administrator"].includes(principal.kind)) {
        return { allowed: false, code: "FORBIDDEN", message: "Explicit authenticated identity and customer scope are required" };
    }
    if (principal.kind !== "administrator" && principal.customerId !== scope.customerId)
        return { allowed: false, code: "FORBIDDEN", message: "Customer scope does not match identity" };
    if (!authority || authority.revokedAt || authority.credentialVersion !== principal.credential.version || authority.permissionEpoch !== principal.permissionEpoch) {
        return { allowed: false, code: "CREDENTIAL_REVOKED", message: "Credential is absent, revoked, or stale" };
    }
    if (authority.actorId !== principal.actorId || authority.credentialId !== principal.credential.id ||
        (principal.kind === "administrator" ? authority.customerId !== null : authority.customerId !== scope.customerId)) {
        return { allowed: false, code: "FORBIDDEN", message: "Credential identity does not match catalog authority" };
    }
    if (!authority.grants.some(grant => grant.action === action && grant.customerId === scope.customerId &&
        (grant.workspaceId === null || ("workspaceId" in scope && grant.workspaceId === scope.workspaceId)))) {
        return { allowed: false, code: "FORBIDDEN", message: "Current authority does not grant this action and scope" };
    }
    return { allowed: true, precondition: { principal, scope, action, policyVersion: authority.policyVersion, permissionEpoch: authority.permissionEpoch, credentialVersion: authority.credentialVersion } };
}
const inactiveMetadataActions: ReadonlySet<Action> = new Set(["workspace:admin", "workspace:delete", "credential:manage", "run:read", "operation:read"]);
export class CatalogAccessPolicy implements AccessPolicy {
    constructor(private readonly store: ControlStore) { }
    async evaluate(principal: Principal, action: Action, scope: CustomerScope | WorkspaceScope): Promise<AccessDecision> {
        if (!principal?.credential || !scope?.customerId)
            return { allowed: false, code: "FORBIDDEN", message: "Explicit authenticated identity is required" };
        const decision = decideAccess(await this.store.getAuthority(scope, principal), principal, action, scope);
        if (!decision.allowed)
            return decision;
        if ("workspaceId" in scope) {
            const workspace = await this.store.getWorkspace(scope);
            if (!workspace)
                return { allowed: false, code: "WORKSPACE_NOT_FOUND", message: "Workspace does not exist in this customer scope" };
            if (workspace.status !== "active" && !inactiveMetadataActions.has(action))
                return { allowed: false, code: "FORBIDDEN", message: "Inactive workspaces allow only administrative and durable outcome metadata access" };
        }
        return decision;
    }
}
