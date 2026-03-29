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
    # Public API (matches TypeScript SDK exactly)
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
            "/workspaces",
            json={"customerId": customer_id, "name": name},
        )

    def list(self, customer_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all workspaces, optionally filtered by customer.

        Args:
            customer_id: Optional customer ID to filter by.

        Returns:
            A list of workspace objects.
        """
        params: Optional[Dict[str, Any]] = None
        if customer_id is not None:
            params = {"customerId": customer_id}
        return self._request("GET", "/workspaces", params=params)

    def get(self, workspace_id: str) -> Dict[str, Any]:
        """Get a single workspace by ID.

        Args:
            workspace_id: The workspace ID.

        Returns:
            The workspace object.
        """
        return self._request("GET", f"/workspaces/{workspace_id}")

    def delete(self, workspace_id: str) -> None:
        """Soft-delete a workspace.

        Args:
            workspace_id: The workspace ID.
        """
        self._request("DELETE", f"/workspaces/{workspace_id}")

    def checkout(self, workspace_id: str) -> Dict[str, Any]:
        """Checkout a workspace (create a sandbox for editing).

        POST /workspaces/{id}/sandbox

        Args:
            workspace_id: The workspace ID.

        Returns:
            Sandbox details including sandboxId and path.
        """
        return self._request("POST", f"/workspaces/{workspace_id}/sandbox")

    def commit(
        self,
        workspace_id: str,
        message: Optional[str] = None,
        author: Optional[str] = None,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Commit sandbox changes back to the workspace.

        POST /workspaces/{id}/sandbox/commit

        Args:
            workspace_id: The workspace ID.
            message: Optional commit message.
            author: Optional author name/identifier.
            agent_id: Optional agent ID.
            task_id: Optional task ID.
            tags: Optional list of tags.

        Returns:
            Commit entry details.
        """
        body: Dict[str, Any] = {}
        if message is not None:
            body["message"] = message
        if author is not None:
            body["author"] = author
        if agent_id is not None:
            body["agentId"] = agent_id
        if task_id is not None:
            body["taskId"] = task_id
        if tags is not None:
            body["tags"] = tags
        return self._request(
            "POST",
            f"/workspaces/{workspace_id}/sandbox/commit",
            json=body if body else None,
        )

    def destroy(self, workspace_id: str) -> Dict[str, Any]:
        """Destroy (tear down) the sandbox for a workspace.

        DELETE /workspaces/{id}/sandbox

        Args:
            workspace_id: The workspace ID.

        Returns:
            Destroy result.
        """
        return self._request("DELETE", f"/workspaces/{workspace_id}/sandbox")

    def pull(self, workspace_id: str, version: Optional[str] = None) -> Dict[str, Any]:
        """Pull the latest committed state (all files) for a workspace.

        GET /workspaces/{id}/pull

        Args:
            workspace_id: The workspace ID.
            version: Optional specific commit version to pull.

        Returns:
            Pull result with files array.
        """
        params: Optional[Dict[str, Any]] = None
        if version is not None:
            params = {"version": version}
        return self._request("GET", f"/workspaces/{workspace_id}/pull", params=params)

    def get_file(self, workspace_id: str, file_path: str) -> Dict[str, Any]:
        """Get a single file from the latest commit of a workspace.

        GET /workspaces/{id}/pull?path=filePath

        Args:
            workspace_id: The workspace ID.
            file_path: Path to the file within the workspace.

        Returns:
            File entry with path and content.
        """
        return self._request(
            "GET",
            f"/workspaces/{workspace_id}/pull",
            params={"path": file_path},
        )

    def history(
        self, workspace_id: str, limit: Optional[int] = None
    ) -> Dict[str, Any]:
        """Get the commit history for a workspace.

        GET /workspaces/{id}/history

        Args:
            workspace_id: The workspace ID.
            limit: Optional limit on number of entries to return.

        Returns:
            History result with commits array and count.
        """
        params: Optional[Dict[str, Any]] = None
        if limit is not None:
            params = {"limit": limit}
        return self._request(
            "GET", f"/workspaces/{workspace_id}/history", params=params
        )
