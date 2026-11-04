export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CREDENTIAL_REVOKED: 403,
  WORKSPACE_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  OPERATION_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  REVISION_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  STALE_FENCE: 409,
  STORAGE_BINDING_CHANGED: 409,
  WORKSPACE_INACTIVE: 409,
  FINALIZATION_IN_PROGRESS: 409,
  INVALID_TRANSITION: 409,
  SUBMISSION_SEALED: 409,
  CAPTURE_CHANGED: 409,
  UNSUPPORTED_CAPABILITY: 409,
  RUN_EXPIRED: 410,
  QUOTA_EXCEEDED: 413,
  INVALID_MANIFEST: 422,
  RECEIPT_MISMATCH: 422,
  PUBLICATION_OUTCOME_UNKNOWN: 503,
  STORAGE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ErrorBody {
  error: { code: ErrorCode; message: string; operationId?: string; retryable?: boolean };
}

export class WorkspaceError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: { operationId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.statusCode = ERROR_STATUS[code];
  }

  toJSON(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}
