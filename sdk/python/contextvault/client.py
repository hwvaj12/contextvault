"""ContextVault SDK entry point."""
from .apikeys import ApiKeys
from .files import limits as workspace_limits
from .local import LocalWorkspace
from .resources import Operations, Receipts, Runs, Submissions
from .transport import Transport
from .webhooks import Webhooks
from .workspaces import Workspaces

DEFAULT_BASE_URL = "http://localhost:3000"


class Client:
    def __init__(self, api_key, base_url=DEFAULT_BASE_URL, *, timeout=30, poll_timeout=30, poll_interval=0.05, limits=None):
        if not api_key:
            raise ValueError("api_key is required")
        self._transport = Transport(base_url, api_key, timeout)
        self.api_key = api_key
        self.base_url = self._transport.origin
        self.limits = workspace_limits(limits)
        self.operations = Operations(self._transport, poll_timeout, poll_interval)
        self.receipts = Receipts()
        self.runs = Runs(self._transport, self.operations, self.limits)
        self.submissions = Submissions(self._transport, self.receipts, self.limits)
        self.workspaces = Workspaces(self)
        self.webhooks = Webhooks(self.base_url, api_key)
        self.api_keys = ApiKeys(self.base_url, api_key)

    def open_workspace(self, workspace_id, **options):
        return LocalWorkspace.provision(self, workspace_id=workspace_id, **options)

    def create_workspace(self, customer_id, name, **options):
        """Create and open with durable pre-ID state. Save a chosen private_state_path before calling."""
        return LocalWorkspace.provision(self, create=dict(customerId=customer_id, name=name), **options)

    def resume_workspace(self, private_state_path):
        """Load without dispatch. Call reconcile() to resume the original command."""
        return LocalWorkspace(self, private_state_path)

    def close(self):
        self._transport.close()
        self.api_keys._session.close()
        self.webhooks._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
