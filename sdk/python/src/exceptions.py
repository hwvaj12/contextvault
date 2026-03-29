"""ContextVault exception classes."""


class ContextVaultError(Exception):
    """Base exception for all ContextVault errors."""

    def __init__(self, message: str, status_code: int = 0) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)


class NotFoundError(ContextVaultError):
    """Raised when a requested resource is not found (HTTP 404)."""

    def __init__(self, message: str = "Resource not found") -> None:
        super().__init__(message, status_code=404)


class AuthError(ContextVaultError):
    """Raised on authentication/authorization failure (HTTP 401/403)."""

    def __init__(self, message: str = "Authentication failed") -> None:
        super().__init__(message, status_code=401)


class NetworkError(ContextVaultError):
    """Raised when a network-level error occurs (connection refused, timeout, etc.)."""

    def __init__(self, message: str = "Network error") -> None:
        super().__init__(message, status_code=0)


class ValidationError(ContextVaultError):
    """Raised when the server rejects input as invalid (HTTP 400/422)."""

    def __init__(self, message: str = "Validation error") -> None:
        super().__init__(message, status_code=422)
