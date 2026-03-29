"""Workspaces resource for the ContextVault SDK."""

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

# Retry configuration
MAX_RETRIES = 3
BACKOFF_BASE = 0.5  # seconds


class Workspaces:
    """Provides methods for managing ContextVault workspaces."""

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

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Execute an HTTP request with automatic retry and error mapping."""
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
                    time.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                raise NetworkError(f"Connection failed after {MAX_RETRIES} retries: {exc}") from exc
            except requests.Timeout as exc:
                last_exc = exc
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                raise NetworkError(f"Request timed out after {MAX_RETRIES} retries: {exc}") from exc
            except requests.RequestException as exc:
                raise NetworkError(str(exc)) from exc

        # Should not reach here, but just in case
        raise NetworkError(str(last_exc))  # pragma: no cover

    @staticmethod
    def _handle_response(resp: requests.Response) -> Any:
        """Map HTTP status codes to typed exceptions."""
        if resp.status_code >= 200 and resp.status_code < 300:
            if not resp.content:
                return None
            try:
                return resp.json()
            except ValueError:
                return resp.text

        # Try to extract an error message from the response body
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

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create(self, customer_id: str, name: str) -> Dict[str, Any]:
        """Create a new workspace.

        Args:
            customer_id: The customer who owns the workspace.
            name: Human-readable workspace name.

        Returns:
            The created workspace object.
        """
        return self._request(
            "POST",
            "/api/workspaces",
            json={"customerId": customer_id, "name": name},
        )

    def list(self, customer_id: str) -> List[Dict[str, Any]]:
        """List all workspaces for a customer.

        Args:
            customer_id: The customer whose workspaces to list.

        Returns:
            A list of workspace objects.
        """
        return self._request(
            "GET",
            "/api/workspaces",
            params={"customerId": customer_id},
        )

    def get(self, workspace_id: str) -> Dict[str, Any]:
        """Get a single workspace by ID.

        Args:
            workspace_id: The workspace ID.

        Returns:
            The workspace object.
        """
        return self._request("GET", f"/api/workspaces/{workspace_id}")

    def delete(self, workspace_id: str) -> None:
        """Delete a workspace.

        Args:
            workspace_id: The workspace ID.
        """
        self._request("DELETE", f"/api/workspaces/{workspace_id}")

    def checkout(self, workspace_id: str) -> Dict[str, Any]:
        """Checkout a workspace sandbox for editing.

        Args:
            workspace_id: The workspace ID.

        Returns:
            Sandbox details including the working path.
        """
        return self._request("POST", f"/api/workspaces/{workspace_id}/checkout")

    def commit(self, workspace_id: str, message: str, author: str) -> Dict[str, Any]:
        """Commit current sandbox changes.

        Args:
            workspace_id: The workspace ID.
            message: Commit message.
            author: Author name/identifier.

        Returns:
            Commit details.
        """
        return self._request(
            "POST",
            f"/api/workspaces/{workspace_id}/commit",
            json={"message": message, "author": author},
        )

    def destroy(self, workspace_id: str) -> None:
        """Destroy a workspace sandbox without committing.

        Args:
            workspace_id: The workspace ID.
        """
        self._request("POST", f"/api/workspaces/{workspace_id}/destroy")

    def pull(self, workspace_id: str) -> List[Dict[str, Any]]:
        """Pull (list) all files in a workspace.

        Args:
            workspace_id: The workspace ID.

        Returns:
            A list of file objects.
        """
        return self._request("GET", f"/api/workspaces/{workspace_id}/files")

    def get_file(self, workspace_id: str, file_path: str) -> Any:
        """Get the contents of a single file.

        Args:
            workspace_id: The workspace ID.
            file_path: Path to the file within the workspace.

        Returns:
            The file content/metadata.
        """
        # URL-encode the file path as a path segment
        safe_path = file_path.lstrip("/")
        return self._request(
            "GET", f"/api/workspaces/{workspace_id}/files/{safe_path}"
        )

    def history(self, workspace_id: str) -> List[Dict[str, Any]]:
        """Get the commit history for a workspace.

        Args:
            workspace_id: The workspace ID.

        Returns:
            A list of commit/history entries.
        """
        return self._request("GET", f"/api/workspaces/{workspace_id}/history")
