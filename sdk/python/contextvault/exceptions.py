"""Stable HTTP, filesystem, conflict, expiry and uncertainty errors."""


class ContextVaultError(Exception):
    def __init__(self, message="ContextVault error", status_code=0, code="UNKNOWN", operation_id=None, retryable=False):
        self.message = message
        self.status_code = status_code
        self.code = code
        self.operation_id = operation_id
        self.retryable = retryable
        super().__init__(message)


class NotFoundError(ContextVaultError):
    def __init__(self, message="Resource not found", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 404), **kwargs)


class AuthError(ContextVaultError):
    def __init__(self, message="Authentication failed", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 401), **kwargs)


class NetworkError(ContextVaultError):
    pass


class ValidationError(ContextVaultError):
    def __init__(self, message="Validation failed", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 422), **kwargs)


class ConflictError(ContextVaultError):
    def __init__(self, message="Workspace conflict", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 409), **kwargs)


class ExpiredError(ContextVaultError):
    def __init__(self, message="Run expired", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 410), **kwargs)


class OutcomeUnknownError(ContextVaultError):
    """Retain the exact pending command and local bytes until reconciliation."""
    def __init__(self, message="Publication outcome is unknown", **kwargs):
        super().__init__(message, status_code=kwargs.pop("status_code", 503), code=kwargs.pop("code", "PUBLICATION_OUTCOME_UNKNOWN"), **kwargs)


class CleanupError(ContextVaultError):
    """Local cleanup failed independently of the remote run outcome."""
