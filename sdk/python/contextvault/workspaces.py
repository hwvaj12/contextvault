"""Workspace metadata and compatibility wrappers using client-local sessions."""
import threading
import uuid
from urllib.parse import urlencode

from .exceptions import ValidationError
from .resources import resource


class Workspaces:
    def __init__(self, client):
        self.client = client
        self.transport = client._transport
        self._sessions = {}
        self._sessions_lock = threading.Lock()
    def create(self, customer_id, name, *, idempotency_key=None):
        """Low-level create. Retain an explicit key for durable caller-managed retries."""
        key = idempotency_key or uuid.uuid4().hex
        value = self.transport.request("POST", "/v1/workspaces", key, dict(customerId=customer_id, name=name))
        if value.get("kind") == "workspace:create":
            operation = self.client.operations.wait(value["id"])
            return self.transport.request("GET", "/v1/workspaces/" + resource(operation["result"]["workspaceId"]))
        return value
    def list(self, customer_id=None):
        query = "?" + urlencode({"customerId": customer_id}) if customer_id else ""
        return self.transport.request("GET", "/workspaces" + query)
    def get(self, workspace_id):
        return self.transport.request("GET", "/workspaces/" + resource(workspace_id))
    def delete(self, workspace_id):
        return self.transport.request("DELETE", "/workspaces/" + resource(workspace_id), body={})
    def bulk_delete(self, workspace_ids):
        return self.transport.request("POST", "/workspaces/bulk-delete", body={"workspaceIds": workspace_ids})
    def clone(self, workspace_id, target_customer_id, name=None):
        body = dict(targetCustomerId=target_customer_id)
        if name is not None:
            body["name"] = name
        return self.transport.request("POST", "/workspaces/" + resource(workspace_id) + "/clone", body=body)
    def checkout(self, workspace_id, **options):
        """Return a local path. No server sandbox path enters an agent process."""
        with self._sessions_lock:
            if workspace_id in self._sessions:
                raise ValidationError("A local checkout already owns this workspace; destroy or resume it first", code="INVALID_TRANSITION")
            self._sessions[workspace_id] = None  # Reserve ownership before network dispatch.
        try:
            session = self.client.open_workspace(workspace_id, **options)
        except Exception as error:
            private_path = getattr(error, "private_state_path", None)
            with self._sessions_lock:
                if private_path:
                    self._sessions[workspace_id] = self.client.resume_workspace(private_path)
                else:
                    del self._sessions[workspace_id]
            raise
        with self._sessions_lock:
            self._sessions[workspace_id] = session
        return self._view(session)
    def _session(self, workspace_id):
        with self._sessions_lock:
            if workspace_id not in self._sessions:
                raise ValidationError("Checkout a local session or resume it explicitly first", code="INVALID_REQUEST")
            session = self._sessions[workspace_id]
            if session is None:
                raise ValidationError("Local checkout is still provisioning", code="INVALID_TRANSITION")
            return session
    @staticmethod
    def _view(session):
        return dict(workspaceId=session.workspace_id, sandboxId=session.run["id"], runId=session.run["id"],
                    path=session.path, sandboxPath=session.path, baseCommit=session.run["baseRevisionId"],
                    privateStatePath=session.private_state_path, status=session.recovery_status)
    def write(self, workspace_id, file_path, content):
        self._session(workspace_id).write(file_path, content)
    def commit(self, workspace_id, message=None, author=None, agent_id=None, task_id=None, tags=None, *, writers_stopped=False):
        """Checkpoint the local session and open its next run, retaining the local path."""
        session = self._session(workspace_id)
        operation = session.checkpoint(writers_stopped=writers_stopped)
        result = self._view(session)
        result.update(commitId=operation["result"]["revisionId"], status="merged", operation=operation)
        return result
    def destroy(self, workspace_id, *, writers_stopped=False):
        session = self._session(workspace_id)
        session.abort("legacy destroy", writers_stopped=writers_stopped, cleanup=True)
        with self._sessions_lock:
            if self._sessions.get(workspace_id) is session:
                del self._sessions[workspace_id]
        return dict(workspaceId=workspace_id, status="cleaned_up", outcome=session.run.get("outcome"))
    def pull(self, workspace_id, version=None):
        query = "?" + urlencode({"version": version}) if version else ""
        return self.transport.request("GET", "/workspaces/" + resource(workspace_id) + "/pull" + query)
    def get_file(self, workspace_id, file_path):
        return self.transport.request("GET", "/workspaces/" + resource(workspace_id) + "/pull?" + urlencode({"path": file_path}))
    def diff(self, workspace_id, from_commit, to_commit):
        return self.transport.request("GET", "/workspaces/" + resource(workspace_id) + "/diff?" + urlencode({"from": from_commit, "to": to_commit}))
    def history(self, workspace_id, limit=None):
        query = "?" + urlencode({"limit": limit}) if limit is not None else ""
        return self.transport.request("GET", "/workspaces/" + resource(workspace_id) + "/history" + query)
    def revisions(self, workspace_id):
        return self.transport.request("GET", "/v1/workspaces/" + resource(workspace_id) + "/revisions")
    def revision_manifest(self, workspace_id, revision_id):
        return self.transport.request("GET", "/v1/workspaces/" + resource(workspace_id) + "/revisions/" + resource(revision_id) + "/manifest")
    def restore(self, workspace_id, revision_id, expected_revision_id, expected_workspace_version, reason, *, idempotency_key):
        return self.transport.request("POST", "/v1/workspaces/" + resource(workspace_id) + "/restore", idempotency_key,
                                      dict(revisionId=revision_id, expectedRevisionId=expected_revision_id, expectedWorkspaceVersion=expected_workspace_version, reason=reason))
