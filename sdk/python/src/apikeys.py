"""API Keys resource for the ContextVault SDK."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import requests

from .exceptions import (
    AuthError,
    ContextVaultError,
    NetworkError,
    NotFoundError,
    ValidationError,
)

MAX_RETRIES = 3
BACKOFF_BASE = 0.5


class ApiKeys:
    """Provides methods for managing ContextVault API keys."""

    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers.update(
            {
                "X-API-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        last_exc: Optional[Exception] = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = self._session.request(
                    method, url, params=params, json=json, timeout=30
                )
                return self._handle_response(resp)
            except NetworkError:
                raise
            except requests.ConnectionError as exc:
                last_exc = exc
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BACKOFF_BASE * (2**attempt))
                    continue
                raise NetworkError(
                    f"Connection failed after {MAX_RETRIES} retries: {exc}"
                ) from exc
            except requests.Timeout as exc:
                last_exc = exc
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BACKOFF_BASE * (2**attempt))
                    continue
                raise NetworkError(
                    f"Request timed out after {MAX_RETRIES} retries: {exc}"
                ) from exc
            except requests.RequestException as exc:
                raise NetworkError(str(exc)) from exc

        raise NetworkError(str(last_exc))

    @staticmethod
    def _handle_response(resp: requests.Response) -> Any:
        if resp.status_code >= 200 and resp.status_code < 300:
            if not resp.content:
                return None
            try:
                return resp.json()
            except ValueError:
                return resp.text

        message = ""
        try:
            body = resp.json()
            message = body.get("error", body.get("message", ""))
        except (ValueError, AttributeError):
            message = resp.text or ""

        if resp.status_code == 404:
            raise NotFoundError(message or "Resource not found")
        if resp.status_code in (401, 403):
            raise AuthError(message or "Authentication failed")
        if resp.status_code in (400, 422):
            raise ValidationError(message or "Validation error")

        raise ContextVaultError(
            message or f"HTTP {resp.status_code}",
            status_code=resp.status_code,
        )

    def create(self, customer_id: str, name: str) -> Dict[str, Any]:
        """Create a new API key. The plain key is only returned once.

        Args:
            customer_id: The customer who owns the key.
            name: Human-readable name for the key.

        Returns:
            API key object including plainKey (only returned at creation).
        """
        return self._request(
            "POST",
            "/api-keys",
            json={"customerId": customer_id, "name": name},
        )

    def list(self) -> List[Dict[str, Any]]:
        """List API keys for the authenticated customer.

        Returns:
            A list of API key objects (without plain key values).
        """
        result = self._request("GET", "/api-keys")
        return result.get("data", []) if isinstance(result, dict) else result

    def revoke(self, key_id: str) -> None:
        """Revoke (delete) an API key.

        Args:
            key_id: The API key ID to revoke.
        """
        self._request("DELETE", f"/api-keys/{key_id}")
