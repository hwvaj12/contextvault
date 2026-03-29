/** Base error class for all ContextVault SDK errors. */
export class ContextVaultError extends Error {
  public readonly statusCode: number | undefined;
  public readonly responseBody: unknown;

  constructor(message: string, statusCode?: number, responseBody?: unknown) {
    super(message);
    this.name = "ContextVaultError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
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

/**
 * Map an HTTP status code and response body to the appropriate error class.
 */
export function mapResponseToError(status: number, body: unknown): ContextVaultError {
  const message = extractMessage(body);

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
