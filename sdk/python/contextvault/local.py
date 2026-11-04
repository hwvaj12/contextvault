"""Durable client-local sessions. Writers must stop before capture, checkpoint, or cleanup."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import stat
import tempfile
import uuid
from urllib.parse import urlencode

from .exceptions import (ConflictError, ContextVaultError, ExpiredError,
                         NetworkError, OutcomeUnknownError, ValidationError)
from .files import (canonical_manifest_bytes, capture_workspace, identity, open_regular,
                    portable_path, remove_workspace, safe_directory, sync_directory)
from .resources import check_operation, resource
from .transport import error_from_body


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


MAX_STATE_BYTES = 64 * 1024 * 1024
COMMAND_HEADROOM_BYTES = 64 * 1024


def atomic_json(directory, record, reserve_bytes=0):
    safe_directory(directory)
    temporary = os.path.join(directory, ".state-" + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            count = 0
            encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            for fragment in encoder.iterencode(record):
                encoded = fragment.encode("utf-8")
                count += len(encoded)
                if count > MAX_STATE_BYTES - reserve_bytes:
                    raise ValidationError("Session state exceeds its resumable journal budget", code="QUOTA_EXCEEDED")
                output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, os.path.join(directory, "state.json"))
        sync_directory(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class LocalWorkspace:
    """Owned local path and durable command journal, excluding credentials and submitted metadata."""
    def __init__(self, client, private_state_path):
        self.client = client
        self.private_state_path = os.path.abspath(private_state_path)
        self.record = self._load()

    @classmethod
    def provision(cls, client, workspace_id=None, create=None, private_state_path=None,
                  local_parent=None, mode="read-write", agent_label="python-sdk", task="workspace", reason="agent workspace"):
        if mode not in ("read-only", "read-write"):
            raise ValidationError("Expected read-only or read-write mode", code="INVALID_REQUEST")
        local_parent = os.path.abspath(local_parent or os.path.realpath(tempfile.gettempdir()))
        safe_directory(local_parent)
        if private_state_path is None:
            private_state_path = tempfile.mkdtemp(prefix="contextvault-session-", dir=local_parent)
        else:
            private_state_path = os.path.abspath(private_state_path)
            safe_directory(os.path.dirname(private_state_path))
            os.mkdir(private_state_path, 0o700)
        os.chmod(private_state_path, 0o700)
        path = tempfile.mkdtemp(prefix="contextvault-workspace-", dir=local_parent)
        os.chmod(path, 0o700)
        session = dict(schemaVersion=1, sessionId=uuid.uuid4().hex, serverOrigin=client.base_url,
                       workspaceId=workspace_id, run=None, path=path, privateStatePath=private_state_path,
                       state="provisioning", pendingCommand=None)
        record = dict(session=session, progress=dict(phase="creating" if create else "opening", create=create,
                      openBody=dict(mode=mode, agentLabel=agent_label, task=task, reason=reason),
                      pathIdentity=list(identity(os.lstat(path))), capture=None, captures=[], receipts=[], uploadIndex=0,
                      runView=None, checkpoint=False, lastOperation=None, cleanup=dict(state="pending", lastError=None)))
        sync_directory(local_parent)
        atomic_json(private_state_path, record)
        value = cls(client, private_state_path)
        try:
            value.reconcile()
        except Exception as error:
            error.private_state_path = private_state_path
            error.session_id = session["sessionId"]
            raise
        return value

    def _load(self):
        safe_directory(self.private_state_path)
        if stat.S_IMODE(os.stat(self.private_state_path).st_mode) != 0o700:
            raise ValidationError("Private session directory requires mode 0700", code="INVALID_REQUEST")
        with open_regular(os.path.join(self.private_state_path, "state.json")) as source:
            if stat.S_IMODE(os.fstat(source.fileno()).st_mode) != 0o600:
                raise ValidationError("Private session state requires mode 0600", code="INVALID_REQUEST")
            data = source.read(MAX_STATE_BYTES + 1)
            if len(data) > MAX_STATE_BYTES:
                raise ValidationError("Session state exceeds limit", code="QUOTA_EXCEEDED")
            record = json.loads(data.decode("utf-8"))
        session = record["session"]
        if session["schemaVersion"] != 1 or session["serverOrigin"] != self.client.base_url or session["privateStatePath"] != self.private_state_path:
            raise ValidationError("Session origin or private path differs from this client", code="INVALID_REQUEST")
        path = session["path"]
        if not path or not os.path.isabs(path) or os.path.commonpath((path, self.private_state_path)) in (path, self.private_state_path):
            raise ValidationError("Private state and submitted contents must be separate", code="INVALID_REQUEST")
        return record

    @property
    def _session(self):
        return self.record["session"]
    @property
    def _progress(self):
        return self.record["progress"]
    @property
    def workspace_id(self):
        return self._session["workspaceId"]
    @property
    def path(self):
        return self._session["path"]
    @property
    def run(self):
        return self._progress["runView"] or self._session["run"]
    @property
    def recovery_status(self):
        return self._progress["phase"]
    @property
    def state(self):
        """Language-neutral LocalClientSessionState; recovery progress is in the private journal."""
        return json.loads(json.dumps(self._session))

    def _save(self, reserve_bytes=0):
        atomic_json(self.private_state_path, self.record, reserve_bytes)

    def _capture(self):
        def own(capture_identity):
            self._progress.setdefault("captures", []).append(capture_identity)
            self._save(COMMAND_HEADROOM_BYTES)
        captured = capture_workspace(self.path, self.private_state_path, self.client.limits, on_owned=own)
        # Canonical entry indexes already identify immutable private filenames.
        # Persist no per-file duplicate hashes, logical paths, or absolute private paths.
        return {key: value for key, value in captured.items() if key != "files"}

    @contextmanager
    def _locked(self):
        safe_directory(self.private_state_path)
        lock_path = os.path.join(self.private_state_path, "lock")
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise ValidationError("Unsafe session lock", code="INVALID_REQUEST")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            self.record = self._load()
            yield
        finally:
            os.close(descriptor)

    def _owned_path(self):
        safe_directory(self.path)
        if list(identity(os.lstat(self.path))) != self._progress["pathIdentity"]:
            raise ValidationError("Owned workspace directory identity changed", code="INVALID_MANIFEST")

    @staticmethod
    def _stopped(writers_stopped):
        if writers_stopped is not True:
            raise ValidationError("Stop agent writers and pass writers_stopped=True", code="INVALID_REQUEST")

    def _set_run(self, value):
        self._progress["runView"] = value
        self._session["run"] = {key: value[key] for key in ("id", "workspaceId", "baseRevisionId", "version", "mode")}

    @staticmethod
    def _request_fingerprint(request):
        exact = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        return hashlib.sha256(exact).hexdigest()

    def _definitely_rejected(self, pending):
        proof = self._progress.get("knownRejection") or {}
        return bool(pending and pending["phase"] == "prepared" and pending["operationId"] is None
                    and proof.get("idempotencyKey") == pending["idempotencyKey"]
                    and proof.get("requestFingerprint") == self._request_fingerprint(pending["request"])
                    and 400 <= proof.get("httpStatus", 0) < 500)

    def _require_retained_session(self):
        if self._progress.get("abandonedReopen"):
            raise ValidationError("This local session explicitly abandoned its rejected reopen", code="INVALID_TRANSITION")

    def _accepted_checkpoint_operation(self, remote):
        saved = self._progress.get("lastOperation") or {}
        if remote["state"] != "finalized" or saved.get("kind") != "finalize" or not saved.get("id"):
            raise ValidationError("Abandonment requires an accepted terminal checkpoint", code="INVALID_TRANSITION")
        # Both reads use current scoped authority. Cached phase labels cannot authorize cleanup.
        operation = self.client.operations.get(saved["id"])
        result = operation.get("result") or {}
        outcome = remote.get("outcome") or {}
        if (operation.get("state") != "succeeded" or operation.get("kind") != "finalize"
                or operation.get("runId") != remote["id"] or operation.get("workspaceId") != self.workspace_id
                or remote.get("workspaceId") != self.workspace_id or remote.get("operationId") != operation["id"]
                or result.get("kind") != "finalize" or result.get("runState") != "finalized"
                or outcome.get("state") != "finalized" or result.get("revisionId") != outcome.get("revisionId")
                or result.get("changed") != outcome.get("changed")):
            raise ValidationError("Run and operation do not confirm the same accepted checkpoint", code="INVALID_TRANSITION")
        return operation

    def _retire_rejected_reopen(self, pending, remote):
        expected = dict(method="POST", path="/v1/workspaces/" + resource(self.workspace_id) + "/runs", body=self._progress["openBody"])
        if pending["kind"] != "run:open" or not self._definitely_rejected(pending) or pending["request"] != expected:
            raise OutcomeUnknownError("Reconcile the original reopen before cleanup")
        operation = self._accepted_checkpoint_operation(remote)
        self._progress["abandonedReopen"] = dict(command=pending, proof=self._progress["knownRejection"],
            acceptedOperationId=operation["id"], revisionId=operation["result"]["revisionId"], runId=remote["id"], retiredAt=now())
        self._session["pendingCommand"] = None
        self._progress.pop("knownRejection", None)
        self._progress.pop("commandAttempt", None)
        self._progress["phase"] = "abandoned"
        self._progress["checkpoint"] = False
        self._set_run(remote)
        # Commit abandonment before deleting files, so cleanup interruption cannot resurrect a run.
        self._save(COMMAND_HEADROOM_BYTES)

    def _prepare(self, kind, path, body=None, capture=None):
        self._require_retained_session()
        current = self._session["pendingCommand"]
        if current:
            if kind != "abort" or not self._definitely_rejected(current):
                raise OutcomeUnknownError("Reconcile the existing command before starting another")
            # Preserve the rejected input, and replace it with the explicit abort atomically.
            # A crash must never turn a requested abort into a new upload/publication command.
            self._progress["rejectedCommand"] = current
        request = dict(method="PUT" if capture else "POST", path=path)
        request["capture" if capture else "body"] = capture if capture else body
        pending = dict(kind=kind, idempotencyKey=uuid.uuid4().hex, request=request, phase="prepared", operationId=None, preparedAt=now())
        if kind == "finalize":
            pending["mode"] = self.run["mode"]
            selected = self._progress.get("submission")
            pending["selectedSubmission"] = dict(submissionId=selected["id"], manifestDigest=selected["manifestDigest"]) if selected else None
        self._session["pendingCommand"] = pending
        self._progress["commandAttempt"] = dict(idempotencyKey=pending["idempotencyKey"],
                                                requestFingerprint=self._request_fingerprint(pending["request"]), dispatched=False)
        self._progress.pop("knownRejection", None)
        self._save(COMMAND_HEADROOM_BYTES)  # Reserve room for the bounded command result before dispatch.

    def _dispatch(self):
        pending = self._session["pendingCommand"]
        attempt = self._progress.get("commandAttempt") or {}
        first_dispatch = (pending["phase"] == "prepared" and attempt.get("dispatched") is False
                          and attempt.get("idempotencyKey") == pending["idempotencyKey"]
                          and attempt.get("requestFingerprint") == self._request_fingerprint(pending["request"]))
        uncertain = not (first_dispatch or self._definitely_rejected(pending))
        pending["phase"] = "dispatched"
        # Remove the previous rejection proof before dispatch, including before process interruption.
        self._progress.pop("knownRejection", None)
        self._progress["commandAttempt"] = dict(idempotencyKey=pending["idempotencyKey"],
                                                requestFingerprint=self._request_fingerprint(pending["request"]), dispatched=True)
        self._save()
        try:
            if pending["operationId"]:
                response = self.client.operations.wait(pending["operationId"])
            else:
                request = pending["request"]
                if pending["kind"] == "submission:file":
                    capture = request["capture"]
                    file_path = capture["privateFilePath"]
                    capture_root = self._progress["capture"]["directory"]
                    if os.path.dirname(file_path) != capture_root or os.path.dirname(capture_root) != self.private_state_path:
                        raise ValidationError("Capture path escapes private session", code="INVALID_MANIFEST")
                    entry = dict(path=self._progress["capture"]["manifest"]["entries"][self._progress["uploadIndex"]]["path"], kind="file",
                                 byteLength=capture["byteLength"], sha256=capture["sha256"])
                    response = self.client.submissions.upload_path(request["path"], entry, file_path, pending["idempotencyKey"])
                else:
                    response = self.client._transport.request(request["method"], request["path"], pending["idempotencyKey"], request["body"])
                if pending["kind"] in ("finalize", "workspace:create") and response.get("kind") in ("finalize", "workspace:create"):
                    pending["operationId"] = response["id"]
                    self._save()
                    response = self.client.operations.wait(response["id"])
            self._accept(pending, response)
            self._session["pendingCommand"] = None
            self._save()  # Result, next phase and cleared pending command share one atomic write.
            return response
        except (OutcomeUnknownError, NetworkError) as error:
            pending["phase"] = "outcome-unknown"
            if getattr(error, "operation_id", None):
                pending["operationId"] = error.operation_id
            self._save()
            raise OutcomeUnknownError("Retain local state and reconcile the original command", operation_id=pending["operationId"]) from error
        except ContextVaultError as error:
            if getattr(error, "operation_id", None):
                pending["operationId"] = error.operation_id
            if error.code == "INVALID_TRANSITION" and self._session["run"] and not uncertain:
                remote = self.client.runs.get(self.run["id"])
                if remote["state"] == "expired":
                    self._set_run(remote)
                    error = ExpiredError("Run lease has expired", code="RUN_EXPIRED")
            if (uncertain or pending["operationId"] or error.status_code >= 500) and not getattr(error, "outcome_known", False):
                pending["phase"] = "outcome-unknown"
                self._save()
                raise OutcomeUnknownError("Current authorization or transport cannot reconcile the earlier unknown outcome", operation_id=pending["operationId"]) from error
            pending["phase"] = "prepared"
            http_status = getattr(error, "http_status", 0)
            if 400 <= http_status < 500:
                self._progress["knownRejection"] = dict(idempotencyKey=pending["idempotencyKey"],
                    requestFingerprint=self._request_fingerprint(pending["request"]), httpStatus=http_status, code=error.code)
            if getattr(error, "outcome_known", False) or (pending["kind"] != "run:open" and isinstance(error, (ConflictError, ExpiredError))):
                self._progress["phase"] = "expired" if isinstance(error, ExpiredError) else "conflicted" if isinstance(error, ConflictError) else "failed"
                self._progress["failedCommand"] = pending
                self._session["pendingCommand"] = None
                self._session["state"] = "failed"
                self._progress["error"] = dict(error=dict(code=error.code, message=error.message, operationId=error.operation_id), status=error.status_code)
            self._save()
            raise error

    def _accept(self, pending, value):
        kind = pending["kind"]
        progress = self._progress
        if kind == "workspace:create":
            self._session["workspaceId"] = value["result"]["workspaceId"] if value.get("kind") == "workspace:create" else value["id"]
            progress["phase"] = "opening"
        elif kind == "run:open":
            self._set_run(value)
            progress["phase"] = "hydrating"
            self._session["state"] = "provisioning"
        elif kind == "submission:create":
            progress["submission"] = value
            progress["phase"] = "uploading"
        elif kind == "submission:file":
            progress["receipts"].append(dict(path=value["path"], receiptId=value["id"]))
            progress["uploadIndex"] += 1
        elif kind == "submission:seal":
            expected = hashlib.sha256(canonical_manifest_bytes(progress["capture"]["manifest"], self.client.limits)).hexdigest()
            if value["manifestDigest"] != expected or value["state"] != "sealed":
                raise ValidationError("Sealed manifest differs from captured content", code="RECEIPT_MISMATCH")
            progress["submission"] = value
            progress["phase"] = "finalizing"
        elif kind == "finalize":
            check_operation(value)
            progress["lastOperation"] = value
            progress["phase"] = "published-needs-reopen" if progress["checkpoint"] else "finalized"
            if progress["runView"]:
                progress["runView"]["state"] = "finalized"
        elif kind == "abort":
            self._set_run(value)
            progress["phase"] = "aborted"
        elif kind == "run:heartbeat":
            self._set_run(value)

    def _hydrate(self):
        self._owned_path()
        progress = self._progress
        base = self.run["baseRevisionId"]
        published = (progress.get("lastOperation") or {}).get("result", {}).get("revisionId")
        if progress.get("checkpoint") and progress.get("capture") and base == published:
            # The stopped workspace still has the published bytes; confirm against immutable capture.
            current = self._capture()
            try:
                if current["manifest"] == progress["capture"]["manifest"]:
                    progress["phase"] = "ready"
                    progress["checkpoint"] = False
                    self._session["state"] = "ready"
                    self._save()
                    return
            finally:
                remove_workspace(current["directory"])
        manifest = self.client.runs.manifest(self.run["id"])
        # A durable hydration marker distinguishes an interrupted replacement from a ready workspace.
        # Only caller-stopped checkpoint work reaches this path after agents have started.
        progress["hydration"] = dict(baseRevisionId=base, manifest=manifest)
        self._save()
        # Preserve the owned root identity across interrupted replacement and restart.
        remove_workspace(self.path, preserve_root=True)
        for entry in manifest["entries"]:
            destination = os.path.join(self.path, *entry["path"].split("/"))
            safe_directory(os.path.dirname(destination), create=True)
            if entry["kind"] == "directory":
                safe_directory(destination, create=True)
            else:
                self.client.runs.download(self.run["id"], entry, destination)
        sync_directory(self.path)
        progress["hydratedBaseRevisionId"] = base
        progress["hydration"] = None
        progress["phase"] = "ready"
        progress["checkpoint"] = False
        self._session["state"] = "ready"
        self._save()

    def _advance(self):
        self._require_retained_session()
        while True:
            if self._session["pendingCommand"]:
                result = self._dispatch()
                if self._progress["phase"] == "ready":
                    return result
                continue
            phase = self._progress["phase"]
            if phase == "creating":
                self._prepare("workspace:create", "/v1/workspaces", self._progress["create"])
            elif phase in ("opening", "published-needs-reopen"):
                self._prepare("run:open", "/v1/workspaces/" + resource(self.workspace_id) + "/runs", self._progress["openBody"])
            elif phase == "hydrating":
                self._hydrate()
            elif phase == "submission-create":
                self._prepare("submission:create", "/v1/runs/" + resource(self.run["id"]) + "/submissions", {})
            elif phase == "uploading":
                entries = self._progress["capture"]["manifest"]["entries"]
                index = self._progress["uploadIndex"]
                if index >= len(entries):
                    self._progress["phase"] = "sealing"
                    self._save()
                elif entries[index]["kind"] == "directory":
                    self._progress["uploadIndex"] += 1
                    self._save()
                else:
                    name = entries[index]["path"]
                    path = "/v1/runs/" + resource(self.run["id"]) + "/submissions/" + resource(self._progress["submission"]["id"]) + "/files?" + urlencode({"path": name})
                    snapshot = self._progress["capture"]
                    entry = entries[index]
                    immutable = dict(captureId=snapshot["captureId"], privateFilePath=os.path.join(snapshot["directory"], str(index)),
                                     byteLength=entry["byteLength"], sha256=entry["sha256"])
                    self._prepare("submission:file", path, capture=immutable)
            elif phase == "sealing":
                path = "/v1/runs/" + resource(self.run["id"]) + "/submissions/" + resource(self._progress["submission"]["id"]) + "/seal"
                self._prepare("submission:seal", path, dict(manifest=self._progress["capture"]["manifest"], receipts=self._progress["receipts"]))
            elif phase == "finalizing":
                body = dict(expectedRunVersion=self.run["version"])
                if self.run["mode"] == "read-write":
                    body["submissionId"] = self._progress["submission"]["id"]
                self._prepare("finalize", "/v1/runs/" + resource(self.run["id"]) + "/finalize", body)
            else:
                failure = self._progress.get("error")
                if phase in ("conflicted", "failed", "expired") and failure:
                    raise error_from_body(failure, failure["status"])
                return self._progress.get("lastOperation") or self

    def reconcile(self):
        """Resume the exact durable command. Never recapture current files after uncertainty."""
        with self._locked():
            return self._advance()

    def status(self):
        with self._locked():
            if not self._session["run"]:
                return self.state
            value = self.client.runs.get(self.run["id"])
            self._set_run(value)
            self._save()
            return value

    def heartbeat(self):
        with self._locked():
            if self._session["pendingCommand"]:
                raise OutcomeUnknownError("Reconcile the pending command before heartbeat")
            self._prepare("run:heartbeat", "/v1/runs/" + resource(self.run["id"]) + "/heartbeat", dict(expectedLeaseVersion=self.run["leaseVersion"]))
            return self._dispatch()

    def _finalize(self, checkpoint):
        self._require_retained_session()
        if self._session["pendingCommand"] or self._progress["phase"] not in ("ready", "finalized"):
            return self._advance()
        if self._progress["phase"] == "finalized":
            return self._progress["lastOperation"]
        self._owned_path()
        self._progress["checkpoint"] = checkpoint
        if self.run["mode"] == "read-write":
            self._progress["capture"] = self._capture()
            self._progress.update(phase="submission-create", receipts=[], uploadIndex=0, submission=None)
        else:
            self._progress["phase"] = "finalizing"
        self._save()
        return self._advance()

    def finalize(self, *, writers_stopped=False):
        self._stopped(writers_stopped)
        with self._locked():
            return self._finalize(False)

    def checkpoint(self, *, writers_stopped=False):
        self._stopped(writers_stopped)
        with self._locked():
            previous = self._progress.get("lastOperation")
            self._finalize(True)
            return self._progress.get("lastOperation") or previous

    def abort(self, reason="caller aborted", *, writers_stopped=False, cleanup=False):
        self._stopped(writers_stopped)
        with self._locked():
            pending = self._session["pendingCommand"]
            if pending and not self._definitely_rejected(pending):
                raise OutcomeUnknownError("Reconcile the pending command before abort or cleanup")
            if self._progress["phase"] != "aborted":
                if not self._session["run"]:
                    raise ValidationError("A known settled run is required before abort", code="INVALID_TRANSITION")
                remote = self.client.runs.get(self.run["id"])
                if remote["state"] != "active":
                    raise ValidationError("Only a known active run can abort", code="INVALID_TRANSITION")
                self._set_run(remote)
                self._prepare("abort", "/v1/runs/" + resource(self.run["id"]) + "/abort", dict(expectedRunVersion=self.run["version"], reason=reason))
                self._dispatch()
            result = self.run
        if cleanup:
            self.cleanup(writers_stopped=True)
        return result

    def cleanup(self, *, writers_stopped=False):
        self._stopped(writers_stopped)
        with self._locked():
            pending = self._session["pendingCommand"]
            if pending and (pending["kind"] != "run:open" or not self._definitely_rejected(pending) or not self._session["run"]):
                raise OutcomeUnknownError("Reconcile the pending command before cleanup")
            if self._progress["cleanup"]["state"] == "complete":
                return dict(self._progress["cleanup"])
            # Read current authority before deleting agent contents; a ready client journal is insufficient.
            remote = self.client.runs.get(self.run["id"])
            if pending:
                self._retire_rejected_reopen(pending, remote)
            elif self._progress.get("abandonedReopen"):
                operation = self._accepted_checkpoint_operation(remote)
                abandoned = self._progress["abandonedReopen"]
                if (abandoned["runId"] != remote["id"] or abandoned["acceptedOperationId"] != operation["id"]
                        or abandoned["revisionId"] != operation["result"]["revisionId"]):
                    raise ValidationError("Abandonment does not match the accepted checkpoint", code="INVALID_TRANSITION")
            if remote["state"] not in ("finalized", "aborted", "conflicted", "failed", "expired"):
                raise ValidationError("Cleanup requires a known terminal run", code="INVALID_TRANSITION")
            self._set_run(remote)
            retrying = self._progress["cleanup"]["state"] in ("running", "failed")
            self._progress["cleanup"] = dict(state="running", lastError=None)
            self._save()
            try:
                if os.path.lexists(self.path) or not retrying:
                    self._owned_path()
                    remove_workspace(self.path)
                for capture in self._progress.get("captures", []):
                    directory = capture["directory"]
                    if os.path.dirname(directory) != self.private_state_path or not os.path.basename(directory).startswith("capture-"):
                        raise ValidationError("Capture cleanup escaped its private session", code="INVALID_MANIFEST")
                    if os.path.lexists(directory):
                        safe_directory(directory)
                        if list(identity(os.lstat(directory))) != capture["directoryIdentity"]:
                            raise ValidationError("Private capture identity changed", code="INVALID_MANIFEST")
                        remove_workspace(directory)
                self._progress["capture"] = None
                self._progress["captures"] = []
                self._progress["cleanup"] = dict(state="complete", lastError=None)
                self._save()
                return dict(self._progress["cleanup"])
            except (OSError, ContextVaultError) as error:
                self._progress["cleanup"] = dict(state="failed", lastError=str(error))
                self._save()
                raise

    def write(self, file_path, content):
        """Convenience writer for local sessions. External agents can also edit path directly."""
        with self._locked():
            if self._progress["phase"] != "ready" or self.run["mode"] != "read-write":
                raise ValidationError("A ready writable session is required", code="INVALID_TRANSITION")
            portable_path(file_path, self.client.limits)
            self._owned_path()
            destination = os.path.join(self.path, *file_path.split("/"))
            safe_directory(os.path.dirname(destination), create=True)
            if os.path.lexists(destination):
                with open_regular(destination):
                    pass
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(content.encode("utf-8") if isinstance(content, str) else content)
                output.flush()
                os.fsync(output.fileno())
            sync_directory(os.path.dirname(destination))


WorkspaceSession = LocalWorkspace
