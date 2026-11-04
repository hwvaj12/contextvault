import type { Action, AuthorizationPrecondition, CustomerScope, ErrorCode, Principal, WorkspaceScope } from "../domain";

export type AccessDecision =
  | { allowed: true; precondition: AuthorizationPrecondition }
  | { allowed: false; code: Extract<ErrorCode, "FORBIDDEN" | "CREDENTIAL_REVOKED" | "WORKSPACE_NOT_FOUND">; message: string };

export interface AccessPolicy {
  /** Resolve catalog-backed grants and revocation epochs for this explicit authenticated identity. */
  evaluate(principal: Principal, action: Action, scope: CustomerScope | WorkspaceScope): Promise<AccessDecision>;
}
