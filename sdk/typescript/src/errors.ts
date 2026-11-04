/** Base error class for all ContextVault SDK errors. */
export class ContextVaultError extends Error {
  public readonly statusCode: number | undefined;
  public readonly responseBody: unknown;
  public readonly code: string | undefined;
  public readonly operationId: string | undefined;
  public readonly retryable: boolean | undefined;
  /** Present when an initialized durable session can be resumed after this error. */
  public readonly privateStatePath?: string;

  constructor(message: string, statusCode?: number, responseBody?: unknown) {
    super(message);
    this.name = "ContextVaultError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    const detail = errorDetail(responseBody);
    this.code = typeof detail.code === "string" ? detail.code : undefined;
    this.operationId = typeof detail.operationId === "string" ? detail.operationId : undefined;
    this.retryable = typeof detail.retryable === "boolean" ? detail.retryable : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the requested resource is not found (HTTP 404). */
export class NotFoundError extends ContextVaultError {
  constructor(message: string = "Resource not found", responseBody?: unknown) {
    super(message, 404, responseBody);
    this.name = "NotFoundError";
  }
}

/** Thrown when authentication or authorization fails (HTTP 401/403). */
export class AuthError extends ContextVaultError {
  constructor(message: string = "Authentication failed", statusCode: number = 401, responseBody?: unknown) {
    super(message, statusCode, responseBody);
    this.name = "AuthError";
  }
}

/** Thrown when a network error occurs (connection refused, timeout, DNS failure). */
export class NetworkError extends ContextVaultError {
  public readonly cause: Error | undefined;

  constructor(message: string = "Network error", cause?: Error) {
    super(message, undefined, undefined);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** Thrown when the server rejects the request due to invalid input (HTTP 400/422). */
export class ValidationError extends ContextVaultError {
  constructor(message: string = "Validation error", statusCode: number = 400, responseBody?: unknown) {
    super(message, statusCode, responseBody);
    this.name = "ValidationError";
  }
}

/** Thrown when the server returns a conflict (HTTP 409). */
export class ConflictError extends ContextVaultError {
  constructor(message: string = "Conflict", responseBody?: unknown) {
    super(message, 409, responseBody);
    this.name = "ConflictError";
  }
}

export class RunExpiredError extends ContextVaultError {
  constructor(message = "Run expired", body: unknown = { error: { code: "RUN_EXPIRED" } }) {
    super(message, 410, body); this.name = "RunExpiredError";
  }
}

/** The original command must be reconciled. This error never authorizes abort or cleanup. */
export class OutcomeUnknownError extends ContextVaultError {
  public readonly privateStatePath?: string;
  public readonly idempotencyKey?: string;
  constructor(message = "Publication outcome is unknown", details: { operationId?: string; privateStatePath?: string; idempotencyKey?: string } = {}) {
    super(message, undefined, { error: { code: "PUBLICATION_OUTCOME_UNKNOWN", ...details, retryable: true } });
    this.name = "OutcomeUnknownError"; this.privateStatePath = details.privateStatePath; this.idempotencyKey = details.idempotencyKey;
  }
}

export function localError(code: string, message: string): ValidationError {
  return new ValidationError(message, 400, { error: { code, message, retryable: false } });
}

function errorDetail(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const value = body as Record<string, unknown>;
  return value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : value;
}

/**
 * Map an HTTP status code and response body to the appropriate error class.
 */
export function mapResponseToError(status: number, body: unknown): ContextVaultError {
  const message = extractMessage(body);
  const code = errorDetail(body).code;
  if (code === "RUN_EXPIRED") return new RunExpiredError(message, body);
  if (code === "PUBLICATION_OUTCOME_UNKNOWN") return new OutcomeUnknownError(message, errorDetail(body));

  switch (status) {
    case 400:
    case 422:
      return new ValidationError(message || "Validation error", status, body);
    case 401:
    case 403:
      return new AuthError(message || "Authentication failed", status, body);
    case 404:
      return new NotFoundError(message || "Resource not found", body);
    case 409:
      return new ConflictError(message || "Conflict", body);
    default:
      return new ContextVaultError(
        message || `Request failed with status ${status}`,
        status,
        body
      );
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.error === "object" && obj.error !== null) {
      const err = obj.error as Record<string, unknown>;
      if (typeof err.message === "string") return err.message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return undefined;
}
