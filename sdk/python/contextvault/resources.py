"""Public run, submission, receipt and operation resources."""
import hashlib
import os
import time
from urllib.parse import quote, urlencode

import requests

from .exceptions import ConflictError, ContextVaultError, ExpiredError, NetworkError, OutcomeUnknownError, ValidationError
from .files import VerifiedReader, canonical_manifest, limits, portable_path, safe_directory, sync_directory
from .transport import error_from_body


def resource(value):
    return quote(str(value), safe="")


class Operations:
    def __init__(self, transport, poll_timeout=30, poll_interval=0.05):
        self.transport = transport
        self.poll_timeout = poll_timeout
        self.poll_interval = poll_interval
    def get(self, operation_id, *, deadline=None):
        return self.transport.request("GET", "/v1/operations/" + resource(operation_id), deadline=deadline)
    def wait(self, operation_id):
        deadline = time.monotonic() + self.poll_timeout
        while True:
            if time.monotonic() >= deadline:
                raise OutcomeUnknownError("Operation polling deadline expired", operation_id=operation_id)
            try:
                value = self.get(operation_id, deadline=deadline)
            except ContextVaultError as error:
                raise OutcomeUnknownError("Cannot currently reconcile the durable operation", operation_id=operation_id) from error
            if value["state"] in ("succeeded", "failed"):
                return check_operation(value)
            if time.monotonic() >= deadline:
                raise OutcomeUnknownError("Operation is still processing", operation_id=operation_id)
            time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))


def check_operation(value):
    error = value.get("error")
    if value["state"] == "failed":
        code = (error or {}).get("code", "OPERATION_FAILED")
        status = 409 if code in ("REVISION_CONFLICT", "VERSION_CONFLICT", "STORAGE_BINDING_CHANGED") else 410 if code == "RUN_EXPIRED" else 503
        failure = error_from_body({"error": dict(error or {}, operationId=value["id"])}, status)
        failure.outcome_known = True
        raise failure
    result = value.get("result") or {}
    if result.get("runState") == "conflicted":
        failure = ConflictError("Workspace head changed", code="REVISION_CONFLICT", operation_id=value["id"])
        failure.outcome_known = True
        raise failure
    if result.get("runState") == "failed":
        failure = ContextVaultError("Finalization failed", code="OPERATION_FAILED", operation_id=value["id"])
        failure.outcome_known = True
        raise failure
    return value


class Runs:
    def __init__(self, transport, operations, configured=None):
        self.transport = transport
        self.operations = operations
        self.limits = limits(configured)
    def open(self, workspace_id, *, idempotency_key, mode="read-write", agent_label="python-sdk", task="workspace", reason="agent workspace"):
        return self.transport.request("POST", "/v1/workspaces/" + resource(workspace_id) + "/runs", idempotency_key,
                                      dict(mode=mode, agentLabel=agent_label, task=task, reason=reason))
    def get(self, run_id):
        return self.transport.request("GET", "/v1/runs/" + resource(run_id))
    def manifest(self, run_id):
        return canonical_manifest(self.transport.request("GET", "/v1/runs/" + resource(run_id) + "/workspace/manifest"), self.limits)
    def download(self, run_id, entry, destination):
        canonical_manifest(dict(schemaVersion=1, entries=[entry]), self.limits)
        if entry["kind"] != "file":
            raise ValidationError("Only regular files have a byte stream", code="INVALID_MANIFEST")
        safe_directory(os.path.dirname(destination))
        response = self.transport.response("GET", "/v1/runs/" + resource(run_id) + "/workspace/files?" + urlencode({"path": entry["path"]}))
        descriptor = None
        try:
            if response.headers.get("X-Content-SHA256") != entry["sha256"] or response.headers.get("Content-Length") != str(entry["byteLength"]):
                raise ValidationError("Download headers differ from manifest", code="RECEIPT_MISMATCH")
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            digest, count = hashlib.sha256(), 0
            with os.fdopen(descriptor, "wb") as output:
                descriptor = None
                for chunk in response.iter_content(self.limits["maxChunkBytes"]):
                    count += len(chunk)
                    if count > entry["byteLength"]:
                        raise ValidationError("Download exceeds declared length", code="RECEIPT_MISMATCH")
                    digest.update(chunk)
                    output.write(chunk)
                if count != entry["byteLength"] or digest.hexdigest() != entry["sha256"]:
                    raise ValidationError("Downloaded bytes differ from manifest", code="RECEIPT_MISMATCH")
                output.flush()
                os.fsync(output.fileno())
            sync_directory(os.path.dirname(destination))
        except requests.RequestException as error:
            raise NetworkError("Download stream was interrupted") from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            response.close()
    def heartbeat(self, run_id, expected_lease_version, *, idempotency_key):
        return self.transport.request("POST", "/v1/runs/" + resource(run_id) + "/heartbeat", idempotency_key, dict(expectedLeaseVersion=expected_lease_version))
    def finalize(self, run_id, expected_run_version, *, idempotency_key, submission_id=None, wait=True):
        body = dict(expectedRunVersion=expected_run_version)
        if submission_id is not None:
            body["submissionId"] = submission_id
        value = self.transport.request("POST", "/v1/runs/" + resource(run_id) + "/finalize", idempotency_key, body)
        return self.operations.wait(value["id"]) if wait else value
    def abort(self, run_id, expected_run_version, reason, *, idempotency_key):
        return self.transport.request("POST", "/v1/runs/" + resource(run_id) + "/abort", idempotency_key, dict(expectedRunVersion=expected_run_version, reason=reason))


class Receipts:
    """Immutable receipt verification. Upload returns the receipt; v1 has no receipt GET route."""
    @staticmethod
    def verify(receipt, entry):
        if any(receipt.get(name) != entry[name] for name in ("path", "byteLength", "sha256")):
            raise ValidationError("Upload receipt differs from captured bytes", code="RECEIPT_MISMATCH")
        return receipt


class Submissions:
    def __init__(self, transport, receipts, configured=None):
        self.transport = transport
        self.receipts = receipts
        self.limits = limits(configured)
    def create(self, run_id, *, idempotency_key):
        return self.transport.request("POST", "/v1/runs/" + resource(run_id) + "/submissions", idempotency_key, {})
    def upload(self, run_id, submission_id, entry, file_path, *, idempotency_key):
        path = "/v1/runs/" + resource(run_id) + "/submissions/" + resource(submission_id) + "/files?" + urlencode({"path": entry["path"]})
        return self.upload_path(path, entry, file_path, idempotency_key)
    def upload_path(self, path, entry, file_path, idempotency_key):
        canonical_manifest(dict(schemaVersion=1, entries=[entry]), self.limits)
        reader = VerifiedReader(file_path, entry, self.limits)
        try:
            headers = {"Content-Type": "application/octet-stream", "Content-Length": str(entry["byteLength"]), "X-Content-SHA256": entry["sha256"]}
            if entry["byteLength"] == 0:
                list(reader)
                data = b""
            else:
                data = reader
            value = self.transport.request("PUT", path, idempotency_key, data=data, headers=headers)
            if not reader.verified:
                # urllib3 can stop exactly at Content-Length without requesting another chunk.
                try:
                    next(reader)
                except StopIteration:
                    pass
                if not reader.verified:
                    raise ValidationError("Upload did not consume the complete source", code="RECEIPT_MISMATCH")
            return self.receipts.verify(value, entry)
        finally:
            reader.close()
    def seal(self, run_id, submission_id, manifest, receipts, *, idempotency_key):
        return self.transport.request("POST", "/v1/runs/" + resource(run_id) + "/submissions/" + resource(submission_id) + "/seal", idempotency_key,
                                      dict(manifest=canonical_manifest(manifest, self.limits), receipts=receipts))
