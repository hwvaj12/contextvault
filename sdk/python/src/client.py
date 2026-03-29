"""ContextVault SDK client."""

from __future__ import annotations

from .workspaces import Workspaces

DEFAULT_BASE_URL = "http://localhost:3000"


class Client:
    """Top-level client for the ContextVault API.

    Usage::

        from src import Client

        cv = Client(api_key="cv_key_xxx")
        workspaces = cv.workspaces.list(customer_id="cust_123")

    Args:
        api_key: Your ContextVault API key.
        base_url: API base URL. Defaults to ``http://localhost:3000``.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")

        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.workspaces = Workspaces(self.base_url, self.api_key)
