"""Executed only by the clean installed Python 3.8 consumer outside the repository."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

import requests
from contextvault import Client, AuthError, ConflictError, ExpiredError, OutcomeUnknownError, ValidationError
from contextvault.files import canonical_manifest_bytes, capture_workspace


def client(key=None, url=None):
    return Client(key or os.environ["CV_KEY_A"], url or os.environ["CV_URL"], poll_timeout=5)


def workspace(cv=None):
    cv = cv or client()
    return cv.workspaces.create(os.environ["CV_CUSTOMER_A"], "python-installed", idempotency_key=os.urandom(16).hex())["id"]


def opened(cv=None, wid=None, **kwargs):
    cv = cv or client()
    return cv.open_workspace(wid or workspace(cv), **kwargs)


def expect(kind, call):
    try:
        call()
    except kind as error:
        return error
    raise AssertionError("Expected " + kind.__name__)


class Proxy:
    """Real HTTP forwarding with one-shot response loss or explicit rejection."""
    def __init__(self):
        self.drop = None
        self.reject = None
        self.reject_status = 403
        self.reject_code = "FORBIDDEN"
        self.fail_upload_after_accept = False
        self.corrupt_receipt = False
        self.hold = None
        self.corrupt_download = False
        self.truncate_rejection = False
        self.held = threading.Event()
        self.release = threading.Event()
        self.requests = []
        self.statuses = []
        self.delay_mode = None
        self.defer_creation_poll = False
        self.creation_accepted = threading.Event()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.forward()
            def do_POST(self):
                self.forward()
            def do_PUT(self):
                self.forward()
            def forward(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection")}
                owner.requests.append((self.command, self.path, headers.get("Idempotency-Key"), data))
                if owner.reject and owner.reject(self.command, self.path):
                    self.send_response(owner.reject_status)
                    if owner.truncate_rejection:
                        self.send_header("Content-Length", "1000")
                    self.end_headers()
                    self.wfile.write(json.dumps(dict(error=dict(code=owner.reject_code, message="test denial"))).encode())
                    return
                response = requests.request(self.command, os.environ["CV_URL"] + self.path, headers=headers, data=data, timeout=15)
                owner.statuses.append((self.command, self.path, response.status_code))
                if owner.fail_upload_after_accept and self.command == "PUT" and "/files?" in self.path:
                    owner.fail_upload_after_accept = False
                    assert response.status_code == 201
                    payload = b'{"error":{"code":"UPSTREAM_ERROR","message":"ambiguous upstream failure"}}'
                    self.send_response(500)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if owner.defer_creation_poll and self.command == "POST" and self.path == "/v1/workspaces":
                    if response.status_code == 201:
                        owner.creation_accepted.set()
                    elif response.status_code == 202:
                        assert owner.creation_accepted.wait(timeout=10)
                if owner.hold and owner.hold(self.command, self.path):
                    owner.held.set()
                    owner.release.wait(timeout=20)
                if owner.drop and owner.drop(self.command, self.path):
                    owner.drop = None
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                content = response.content
                if owner.corrupt_receipt and self.command == "PUT" and "/files?" in self.path and response.status_code == 201:
                    receipt = response.json()
                    receipt["sha256"] = "0" * 64
                    content = json.dumps(receipt, separators=(",", ":")).encode()
                    response.headers["Content-Length"] = str(len(content))
                if owner.corrupt_download and self.command == "GET" and "/workspace/files?" in self.path and content:
                    content = content[:-1] + bytes([content[-1] ^ 255])
                delayed = self.command == "GET" and self.path.startswith("/v1/operations/")
                if delayed and owner.delay_mode == "headers":
                    time.sleep(0.6)
                self.send_response(response.status_code)
                for name, value in response.headers.items():
                    if name.lower() not in ("transfer-encoding", "connection", "keep-alive", "proxy-connection", "content-encoding"):
                        self.send_header(name, value)
                try:
                    self.end_headers()
                    if delayed and owner.delay_mode == "body":
                        time.sleep(0.6)
                    if delayed and owner.delay_mode == "trickle":
                        for offset in range(0, len(content), 32):
                            self.wfile.write(content[offset:offset + 32])
                            self.wfile.flush()
                            time.sleep(0.02)
                    else:
                        self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Consumer cancellation and process crashes are deliberate faults.
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_address[1])
    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def installed():
    import contextvault
    assert sys.version_info[:2] == (3, 8), sys.version
    assert "/site-packages/contextvault/" in contextvault.__file__, contextvault.__file__
    import importlib.util
    assert importlib.util.find_spec("src") is None, "Legacy src must not pollute installed packages"
    cv = client()
    assert cv.runs and cv.submissions and cv.receipts and cv.operations
    assert callable(cv.open_workspace) and callable(cv.resume_workspace)
    assert not any(name.startswith("AWS_") or name in ("CV_DATA_DIR", "CONTEXTVAULT_API_KEY") for name in os.environ)


def lifecycle():
    cv = client()
    handle = opened(cv)
    path = Path(handle.path)
    assert path.is_absolute() and handle.run["workspaceId"] == handle.workspace_id
    assert os.path.commonpath([handle.private_state_path, handle.path]) != handle.path
    assert stat.S_IMODE(os.stat(handle.private_state_path).st_mode) == 0o700
    fixture = json.loads(Path("/proof/canonical.json").read_text())
    for name, value in fixture["files"].items():
        (path / name).write_bytes(bytes.fromhex(value["hex"]))
    (path / "empty").mkdir()
    (path / ".git").mkdir()
    (path / ".git" / "config").write_text("excluded")
    (path / ".contextvault").mkdir()
    before = handle.run["version"]
    heartbeat = handle.heartbeat()
    assert heartbeat["version"] == before and heartbeat["leaseVersion"] > 1
    result = handle.finalize(writers_stopped=True)
    assert result["result"]["runState"] == "finalized"
    reader = opened(cv, handle.workspace_id, mode="read-only")
    assert cv.runs.manifest(reader.run["id"]) == json.loads(fixture["canonical"])
    for name, value in fixture["files"].items():
        assert (Path(reader.path) / name).read_bytes() == bytes.fromhex(value["hex"])
    assert (Path(reader.path) / "empty").is_dir()
    assert not (Path(reader.path) / ".git").exists()
    other = client(os.environ["CV_KEY_B"])
    from contextvault import NotFoundError
    expect(NotFoundError, lambda: other.runs.get(handle.run["id"]))
    expect(NotFoundError, lambda: other.operations.get(result["id"]))
    deletion = opened(cv, handle.workspace_id)
    for item in Path(deletion.path).iterdir():
        shutil.rmtree(str(item)) if item.is_dir() else item.unlink()
    deletion.finalize(writers_stopped=True)
    # A read-only run completes against its pinned older revision after head advances.
    reader.finalize(writers_stopped=True)
    verify = opened(cv, handle.workspace_id)
    assert list(Path(verify.path).iterdir()) == []
    (Path(verify.path) / "discard").write_text("not published")
    verify.abort("discard", writers_stopped=True, cleanup=True)
    assert not Path(verify.path).exists()
    check = opened(cv, handle.workspace_id)
    assert list(Path(check.path).iterdir()) == []
    check.abort("done", writers_stopped=True, cleanup=True)
    for value in (handle, reader, deletion):
        value.cleanup(writers_stopped=True)
    own_b = other.workspaces.create(os.environ["CV_CUSTOMER_B"], "tenant-b", idempotency_key=os.urandom(16).hex())
    local_b = other.open_workspace(own_b["id"])
    expect(NotFoundError, lambda: cv.runs.get(local_b.run["id"]))
    local_b.abort("done", writers_stopped=True, cleanup=True)


def failures():
    cv = client()
    first = opened(cv)
    stale = opened(cv, first.workspace_id)
    (Path(first.path) / "x").write_text("one")
    first.finalize(writers_stopped=True)
    error = expect(ConflictError, lambda: stale.finalize(writers_stopped=True))
    assert error.code == "REVISION_CONFLICT" and Path(stale.path).exists()
    assert stale.status()["state"] == "conflicted"
    expiry = opened(cv)
    time.sleep(4.5)
    error = expect(ExpiredError, expiry.heartbeat)
    assert error.code == "RUN_EXPIRED" and Path(expiry.path).exists()
    cleanup = opened(cv)
    cleanup.abort("done", writers_stopped=True)
    outside = Path(tempfile.mkdtemp())
    (outside / "kept").write_text("safe")
    (Path(cleanup.path) / "link").symlink_to(outside, target_is_directory=True)
    expect(ValidationError, lambda: cleanup.cleanup(writers_stopped=True))
    assert (outside / "kept").read_text() == "safe"
    assert cleanup.status()["state"] == "aborted"
    (Path(cleanup.path) / "link").unlink()
    cleanup.cleanup(writers_stopped=True)
    for value in (first, stale, expiry):
        value.cleanup(writers_stopped=True)
    shutil.rmtree(str(outside))


def filesystem():
    fixture = json.loads(Path("/proof/canonical.json").read_text())
    assert canonical_manifest_bytes(fixture["input"]).decode() == fixture["canonical"]
    assert hashlib.sha256(canonical_manifest_bytes(fixture["input"])).hexdigest() == fixture["sha256"]
    invalid = ["../x", "C:x", "a\\b", "nul", "a/COM¹", "a/.GIT/x", "a/.contextvault", "a.", "e\u0301"]
    for name in invalid:
        expect(ValidationError, lambda: canonical_manifest_bytes({"schemaVersion": 1, "entries": [{"path": name, "kind": "directory"}]}))
    expect(ValidationError, lambda: canonical_manifest_bytes({"schemaVersion": 1, "entries": [{"path": "A", "kind": "directory"}, {"path": "a/b", "kind": "directory"}]}))
    root = Path(tempfile.mkdtemp())
    private = Path(tempfile.mkdtemp())
    (root / "x").write_bytes(b"bytes")
    os.link(str(root / "x"), str(root / "hard"))
    expect(ValidationError, lambda: capture_workspace(str(root), str(private)))
    (root / "hard").unlink()
    (root / "sym").symlink_to(root / "x")
    expect(ValidationError, lambda: capture_workspace(str(root), str(private)))
    (root / "sym").unlink()
    os.mkfifo(str(root / "fifo"))
    expect(ValidationError, lambda: capture_workspace(str(root), str(private)))
    (root / "fifo").unlink()
    expect(ValidationError, lambda: capture_workspace(str(root), str(private), {"maxFileBytes": 2}))
    # The capture must reject a file whose source identity changes while bytes are copied.
    (root / "large").write_bytes(b"x" * (16 * 1024 * 1024))
    stop = threading.Event()
    started = threading.Event()
    def mutate():
        with (root / "large").open("r+b", buffering=0) as source:
            counter = 0
            while not stop.is_set():
                source.seek(0)
                source.write(bytes([counter % 256]))
                counter += 1
                started.set()
                time.sleep(0.0002)
    thread = threading.Thread(target=mutate)
    thread.start()
    assert started.wait(timeout=2)
    try:
        error = expect(ConflictError, lambda: capture_workspace(str(root), str(private)))
        assert error.code == "CAPTURE_CHANGED"
    finally:
        stop.set()
        thread.join(timeout=5)
    shutil.rmtree(str(root)); shutil.rmtree(str(private))


def checkpoint():
    proxy = Proxy()
    cv = client(url=proxy.url)
    handle = opened(cv)
    original_path = handle.path
    original_run = handle.run["id"]
    (Path(handle.path) / "one").write_text("checkpoint")
    # Publication succeeds, but the next run cannot yet be opened.
    proxy.reject = lambda method, path: method == "POST" and path.endswith("/runs")
    expect(AuthError, lambda: handle.checkpoint(writers_stopped=True))
    assert handle.recovery_status == "published-needs-reopen"
    assert handle.run["id"] == original_run
    state = json.loads(Path(handle.private_state_path, "state.json").read_text())
    key = state["session"]["pendingCommand"]["idempotencyKey"]
    # Another writer advances the head before reopen. Resumption must hydrate the new pinned base.
    competing = opened(client(), handle.workspace_id)
    (Path(competing.path) / "other").write_text("new head")
    competing.finalize(writers_stopped=True)
    proxy.reject = None
    resumed = cv.resume_workspace(handle.private_state_path)
    resumed.reconcile()
    assert resumed.path == original_path and resumed.run["id"] != original_run
    assert (Path(resumed.path) / "other").read_text() == "new head"
    assert [r[2] for r in proxy.requests if r[1].endswith("/runs")][-1] == key
    assert len([r for r in proxy.requests if r[1].endswith("/finalize")]) == 1
    (Path(resumed.path) / "two").write_text("second")
    resumed.checkpoint(writers_stopped=True)
    assert resumed.path == original_path
    resumed.abort("done", writers_stopped=True, cleanup=True)
    competing.cleanup(writers_stopped=True)
    proxy.close()


def worker():
    _, _, action, url, private, wid = sys.argv
    cv = client(url=url)
    if action == "create":
        expect(OutcomeUnknownError, lambda: cv.create_workspace(os.environ["CV_CUSTOMER_A"], "durable-create", private_state_path=private))
    elif action == "open":
        expect(OutcomeUnknownError, lambda: cv.open_workspace(wid, private_state_path=private))
    elif action == "resume":
        handle = cv.resume_workspace(private)
        handle.reconcile()
        assert handle.run["id"] and handle.path
        handle.abort("done", writers_stopped=True, cleanup=True)
    elif action == "finalize":
        handle = cv.resume_workspace(private)
        expect(OutcomeUnknownError, lambda: handle.finalize(writers_stopped=True))
    elif action == "capture-crash":
        import contextvault.local as local
        original = local.capture_workspace
        def crash_after_capture(*args, **kwargs):
            original(*args, **kwargs)
            os._exit(61)
        local.capture_workspace = crash_after_capture
        cv.resume_workspace(private).finalize(writers_stopped=True)
        raise AssertionError("Crash barrier did not execute")
    elif action == "resume-finalize":
        handle = cv.resume_workspace(private)
        result = handle.reconcile()
        assert result["result"]["runState"] == "finalized"
    else:
        raise AssertionError(action)


def child(action, proxy, private, wid=""):
    result = subprocess.run([sys.executable, __file__, "worker", action, proxy.url, private, wid], text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def identity_recovery():
    for action in ("create", "open"):
        proxy = Proxy()
        private = tempfile.mkdtemp()
        os.rmdir(private)
        wid = workspace() if action == "open" else ""
        proxy.drop = lambda method, path: method == "POST" and (path == "/v1/workspaces" if action == "create" else path.endswith("/runs"))
        child(action, proxy, private, wid)
        saved = json.loads(Path(private, "state.json").read_text())
        pending = saved["session"]["pendingCommand"]
        assert pending and saved["session"]["sessionId"]
        assert saved["session"]["run"] is None
        if action == "create":
            assert saved["session"]["workspaceId"] is None
        child("resume", proxy, private, wid)
        matching = [r for r in proxy.requests if r[1] == pending["request"]["path"] and r[0] == "POST"]
        assert len(matching) == 2 and matching[0][2:] == matching[1][2:]
        proxy.close()
        shutil.rmtree(private)


def publication_recovery():
    for stage in ("/finalize", "/seal", "/files?path=source.bin"):
        recover_publication_stage(stage)


def recover_publication_stage(stage):
    proxy = Proxy()
    cv = client(url=proxy.url)
    handle = opened(cv)
    (Path(handle.path) / "source.bin").write_bytes(b"original\x00\xff")
    proxy.drop = lambda method, path: path.endswith(stage)
    child("finalize", proxy, handle.private_state_path)
    saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
    command = saved["session"]["pendingCommand"]
    assert command["kind"] in ("finalize", "submission:seal", "submission:file") and command["phase"] == "outcome-unknown"
    assert "cv_key" not in json.dumps(saved)
    assert os.environ["CV_KEY_A"] not in json.dumps(saved)
    (Path(handle.path) / "source.bin").write_bytes(b"changed after uncertainty")
    proxy.reject = lambda method, path: path.endswith(stage)
    resumed = cv.resume_workspace(handle.private_state_path)
    expect(OutcomeUnknownError, resumed.reconcile)
    after = json.loads(Path(handle.private_state_path, "state.json").read_text())
    assert after["session"]["pendingCommand"]["idempotencyKey"] == command["idempotencyKey"]
    assert Path(handle.path).exists() and after["progress"]["capture"]
    expect(OutcomeUnknownError, lambda: resumed.abort("unsafe", writers_stopped=True, cleanup=True))
    proxy.reject = None
    child("resume-finalize", proxy, handle.private_state_path)
    replay = [r for r in proxy.requests if r[1].endswith(stage)]
    assert len({r[2] for r in replay}) == 1 and len({r[3] for r in replay}) == 1
    reader = opened(client(), handle.workspace_id)
    assert (Path(reader.path) / "source.bin").read_bytes() == b"original\x00\xff"
    reader.abort("done", writers_stopped=True, cleanup=True)
    cv.resume_workspace(handle.private_state_path).cleanup(writers_stopped=True)
    proxy.close()


def dispatch_crash():
    proxy = Proxy()
    private = tempfile.mkdtemp()
    os.rmdir(private)
    wid = workspace()
    proxy.hold = lambda method, path: method == "POST" and path.endswith("/runs")
    process = subprocess.Popen([sys.executable, __file__, "worker", "open", proxy.url, private, wid], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert proxy.held.wait(timeout=10), "Remote command did not reach the response barrier"
        process.kill()
        process.wait(timeout=5)
        saved = json.loads(Path(private, "state.json").read_text())
        command = saved["session"]["pendingCommand"]
        assert command["phase"] == "dispatched" and saved["session"]["run"] is None
        proxy.release.set()
        proxy.hold = None
        proxy.reject = lambda method, path: path.endswith("/runs")
        resumed = client(url=proxy.url).resume_workspace(private)
        expect(OutcomeUnknownError, resumed.reconcile)
        assert json.loads(Path(private, "state.json").read_text())["session"]["pendingCommand"]["idempotencyKey"] == command["idempotencyKey"]
        proxy.reject = None
        child("resume", proxy, private, wid)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        proxy.close()
        shutil.rmtree(private)


def known_failed_reconciliation():
    proxy = Proxy()
    cv = client(url=proxy.url)
    stale = opened(cv)
    winner = opened(client(), stale.workspace_id)
    (Path(winner.path) / "winner").write_text("new head")
    winner.finalize(writers_stopped=True)
    proxy.drop = lambda method, path: path.endswith("/finalize")
    expect(OutcomeUnknownError, lambda: stale.finalize(writers_stopped=True))
    resumed = cv.resume_workspace(stale.private_state_path)
    expect(ConflictError, resumed.reconcile)
    assert resumed.recovery_status == "conflicted"
    resumed.cleanup(writers_stopped=True)
    winner.cleanup(writers_stopped=True)
    proxy.close()


def hydration_restart():
    seed = opened()
    (Path(seed.path) / "binary.bin").write_bytes(b"pinned\x00\xff")
    seed.finalize(writers_stopped=True)
    proxy = Proxy()
    private = tempfile.mkdtemp()
    os.rmdir(private)
    proxy.hold = lambda method, path: method == "GET" and "/workspace/files?" in path
    process = subprocess.Popen([sys.executable, __file__, "worker", "open", proxy.url, private, seed.workspace_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert proxy.held.wait(timeout=10)
        process.kill()
        process.wait(timeout=5)
        saved = json.loads(Path(private, "state.json").read_text())
        assert saved["progress"]["phase"] == "hydrating"
        assert saved["session"]["state"] == "provisioning"
        proxy.hold = None
        proxy.release.set()
        resumed = client(url=proxy.url).resume_workspace(private)
        resumed.reconcile()
        assert (Path(resumed.path) / "binary.bin").read_bytes() == b"pinned\x00\xff"
        assert resumed.recovery_status == "ready"
        resumed.abort("done", writers_stopped=True, cleanup=True)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        proxy.close()
        seed.cleanup(writers_stopped=True)
        shutil.rmtree(private)


def polling_authorization():
    for truncated in (False, True):
        recover_polling_authorization(truncated)


def recover_polling_authorization(truncated):
    proxy = Proxy()
    proxy.truncate_rejection = truncated
    cv = client(url=proxy.url)
    handle = opened(cv)
    proxy.reject = lambda method, path: method == "GET" and path.startswith("/v1/operations/")
    expect(OutcomeUnknownError, lambda: handle.finalize(writers_stopped=True))
    saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
    assert saved["session"]["pendingCommand"]["operationId"]
    assert Path(handle.path).exists()
    proxy.reject = None
    handle.reconcile()
    handle.cleanup(writers_stopped=True)
    proxy.close()


def compatibility_wrappers():
    cv = client()
    wid = workspace(cv)
    checkout = cv.workspaces.checkout(wid)
    assert checkout["sandboxPath"] == checkout["path"]
    cv.workspaces.write(wid, "wrapper.bin", b"wrapper\x00\xff")
    first = cv.workspaces.commit(wid, writers_stopped=True)
    assert first["status"] == "merged" and first["commitId"]
    cv.workspaces.write(wid, "second", "next checkpoint")
    second = cv.workspaces.commit(wid, writers_stopped=True)
    assert first["sandboxPath"] == second["sandboxPath"]
    assert cv.workspaces.destroy(wid, writers_stopped=True)["status"] == "cleaned_up"
    assert not list(Path(checkout["privateStatePath"]).glob("capture-*")), "Cleanup must release every completed checkpoint capture"
    read = opened(cv, wid, mode="read-only")
    assert (Path(read.path) / "wrapper.bin").read_bytes() == b"wrapper\x00\xff"
    read.checkpoint(writers_stopped=True)
    read.abort("done", writers_stopped=True, cleanup=True)


def binary_streams():
    seed = opened()
    large = bytes(range(256)) * 8192
    (Path(seed.path) / "large.bin").write_bytes(large)
    (Path(seed.path) / "zero").write_bytes(b"")
    (Path(seed.path) / "é").mkdir()
    (Path(seed.path) / "é" / "😀.bin").write_bytes(b"unicode\x00\xff")
    seed.finalize(writers_stopped=True)
    proxy = Proxy()
    proxy.corrupt_download = True
    cv = client(url=proxy.url)
    private = tempfile.mkdtemp()
    os.rmdir(private)
    try:
        error = expect(ValidationError, lambda: cv.open_workspace(seed.workspace_id, private_state_path=private))
        assert error.code == "RECEIPT_MISMATCH"
        saved = json.loads(Path(private, "state.json").read_text())
        assert saved["session"]["state"] == "provisioning" and saved["progress"]["phase"] == "hydrating"
        proxy.corrupt_download = False
        recovered = cv.resume_workspace(private)
        recovered.reconcile()
        assert (Path(recovered.path) / "large.bin").read_bytes() == large
        assert (Path(recovered.path) / "zero").read_bytes() == b""
        assert (Path(recovered.path) / "é" / "😀.bin").read_bytes() == b"unicode\x00\xff"
        recovered.abort("done", writers_stopped=True, cleanup=True)
    finally:
        seed.cleanup(writers_stopped=True)
        proxy.close()
        shutil.rmtree(private)


def retire(handle):
    if handle is None:
        return
    current = handle.status()
    if current.get("state") == "active":
        client_for_handle = handle.client
        client_for_handle.runs.abort(handle.run["id"], current["version"], "test cleanup", idempotency_key=os.urandom(16).hex())
    handle.cleanup(writers_stopped=True)


def duplicate_checkout():
    cv = client()
    wid = workspace(cv)
    first = cv.workspaces.checkout(wid)
    original = cv.resume_workspace(first["privateStatePath"])
    try:
        cv.workspaces.write(wid, "first.txt", "preserved")
        error = expect(ValidationError, lambda: cv.workspaces.checkout(wid))
        assert error.code == "INVALID_TRANSITION"
        assert cv.workspaces._session(wid).private_state_path == first["privateStatePath"]
        cv.workspaces.commit(wid, writers_stopped=True)
        assert (Path(first["path"]) / "first.txt").read_text() == "preserved"
        cv.workspaces.destroy(wid, writers_stopped=True)
        # Completed cleanup releases wrapper ownership, so a later checkout remains supported.
        next_view = cv.workspaces.checkout(wid)
        assert next_view["sandboxPath"] != first["sandboxPath"]
        cv.workspaces.destroy(wid, writers_stopped=True)
    finally:
        for handle in list(cv.workspaces._sessions.values()) + [original]:
            retire(handle)
    proxy = Proxy()
    proxy.hold = lambda method, path: method == "POST" and path.endswith("/runs")
    concurrent = client(url=proxy.url)
    wid = workspace()
    result = []
    def checkout():
        try:
            result.append(concurrent.workspaces.checkout(wid))
        except Exception as error:
            result.append(error)
    thread = threading.Thread(target=checkout)
    thread.start()
    try:
        assert proxy.held.wait(timeout=5)
        expect(ValidationError, lambda: concurrent.workspaces.checkout(wid))
        assert len([entry for entry in proxy.requests if entry[0] == "POST" and entry[1].endswith("/runs")]) == 1
        proxy.release.set()
        thread.join(timeout=5)
        assert result and isinstance(result[0], dict), result
        concurrent.workspaces.destroy(wid, writers_stopped=True)
    finally:
        proxy.release.set()
        thread.join(timeout=5)
        for handle in concurrent.workspaces._sessions.values():
            retire(handle)
        proxy.close()


def orphan_capture_cleanup():
    handle = opened()
    (Path(handle.path) / "secret.bin").write_bytes(b"exact-private-bytes\x00\xff")
    foreign = Path(handle.private_state_path) / "capture-foreign"
    foreign.mkdir()
    (foreign / "kept").write_text("not owned by capture journal")
    result = subprocess.run([sys.executable, __file__, "worker", "capture-crash", os.environ["CV_URL"], handle.private_state_path, handle.workspace_id], timeout=15)
    assert result.returncode == 61, result.returncode
    owned = [path for path in Path(handle.private_state_path).glob("capture-*") if path != foreign]
    assert owned and any(path.read_bytes() == b"exact-private-bytes\x00\xff" for root in owned for path in root.iterdir() if path.is_file())
    recovered = client().resume_workspace(handle.private_state_path)
    recovered.abort("discard crashed capture", writers_stopped=True, cleanup=True)
    assert recovered._progress["cleanup"]["state"] == "complete"
    assert not any(root.exists() for root in owned), "Owned private bytes survived successful cleanup"
    assert (foreign / "kept").read_text() == "not owned by capture journal"


def abort_failed_hydration():
    seed = opened()
    (Path(seed.path) / "source.bin").write_bytes(b"real binary\x00\xff")
    seed.finalize(writers_stopped=True)
    proxy = Proxy()
    proxy.corrupt_download = True
    private = tempfile.mkdtemp()
    os.rmdir(private)
    recovered = None
    try:
        cv = client(url=proxy.url)
        expect(ValidationError, lambda: cv.open_workspace(seed.workspace_id, private_state_path=private))
        recovered = cv.resume_workspace(private)
        assert recovered.recovery_status == "hydrating" and recovered.state["pendingCommand"] is None
        aborted = recovered.abort("discard partial hydration", writers_stopped=True, cleanup=True)
        assert aborted["state"] == "aborted"
        assert not Path(recovered.path).exists()
        assert recovered.status()["state"] == "aborted"
    finally:
        if recovered is not None:
            retire(recovered)
        seed.cleanup(writers_stopped=True)
        proxy.close()
        shutil.rmtree(private)


def overlapping_creation():
    proxy = Proxy()
    # Exercise real overlapping 202 creation, with polling after the other caller's acceptance.
    proxy.defer_creation_poll = True
    try:
        pending_seen = False
        for attempt in range(3):
            key = os.urandom(16).hex()
            barrier = threading.Barrier(2)
            results, errors = [], []
            def create():
                cv = client(url=proxy.url)
                try:
                    barrier.wait(timeout=5)
                    results.append(cv.workspaces.create(os.environ["CV_CUSTOMER_A"], "overlap-creation", idempotency_key=key))
                except Exception as error:
                    errors.append(error)
                finally:
                    cv.close()
            threads = [threading.Thread(target=create) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
                assert not thread.is_alive()
            pending_seen = any(status == 202 for method, path, status in proxy.statuses if method == "POST" and path == "/v1/workspaces")
            assert not errors, [(type(error).__name__, str(error), repr(error.__cause__), getattr(error.__cause__, "code", None), proxy.statuses) for error in errors]
            assert len(results) == 2 and results[0]["id"] == results[1]["id"]
            assert results[0]["currentRevisionId"] == results[1]["currentRevisionId"]
            if pending_seen:
                break
        assert pending_seen, "The real server did not exercise an overlapping 202 creation"
    finally:
        proxy.close()


def polling_deadline(mode):
    seed = opened()
    operation = seed.finalize(writers_stopped=True)
    proxy = Proxy()
    proxy.delay_mode = mode
    cv = Client(os.environ["CV_KEY_A"], proxy.url, timeout=2, poll_timeout=0.1)
    try:
        started = time.monotonic()
        error = expect(OutcomeUnknownError, lambda: cv.operations.wait(operation["id"]))
        elapsed = time.monotonic() - started
        assert error.operation_id == operation["id"]
        assert elapsed < 0.25, "Polling deadline exceeded: " + str(elapsed)
        until = time.monotonic() + 0.3
        while any(thread.name == "ContextVault-operation-lookup" for thread in threading.enumerate()) and time.monotonic() < until:
            time.sleep(0.005)
        assert not any(thread.name == "ContextVault-operation-lookup" for thread in threading.enumerate()), "Canceled poll worker remained alive"
        assert Path(seed.path).exists()
        proxy.delay_mode = None
        assert cv.operations.wait(operation["id"])["state"] == "succeeded"
    finally:
        cv.close()
        proxy.close()
        seed.cleanup(writers_stopped=True)


def poll_deadline_headers():
    polling_deadline("headers")


def poll_deadline_body():
    polling_deadline("body")


def poll_deadline_trickle():
    polling_deadline("trickle")


def journal_readback_bound():
    # This is a canonical-size metadata/readback probe, not a max-size publication claim.
    import copy
    from contextvault.files import canonical_manifest
    from contextvault.local import atomic_json
    handle = opened()
    original = Path(handle.private_state_path, "state.json").read_bytes()
    names = ["/".join(["a" * 230] * 4 + [("%05d-" % index) + "b" * 44]) for index in range(9990)]
    assert len(names[0].encode("utf-8")) == 974
    manifest = canonical_manifest(dict(schemaVersion=1, entries=[dict(path=name, kind="file", byteLength=0, sha256=hashlib.sha256(b"").hexdigest()) for name in names]))
    receipts = [dict(path=name, receiptId="receipt-" + str(index)) for index, name in enumerate(names)]
    long_private_root = handle.private_state_path + "/" + "/".join(["c" * 230] * 10)
    record = copy.deepcopy(handle.record)
    record["progress"]["capture"] = dict(captureId="a" * 32, directory=long_private_root, directoryIdentity=[1, 2], manifest=manifest,
        files={name: dict(captureId="a" * 32, privateFilePath=long_private_root + "/" + str(index), byteLength=0, sha256=hashlib.sha256(b"").hexdigest()) for index, name in enumerate(names)})
    record["progress"]["receipts"] = receipts
    record["session"]["pendingCommand"] = dict(kind="submission:seal", idempotencyKey="size-probe", phase="prepared", operationId=None, preparedAt="2026-11-04T00:00:00Z",
        request=dict(method="POST", path="/v1/runs/size-probe/submissions/size-probe/seal", body=dict(manifest=manifest, receipts=receipts)))
    try:
        try:
            atomic_json(handle.private_state_path, record)
        except ValidationError as error:
            assert error.code == "QUOTA_EXCEEDED"
            assert Path(handle.private_state_path, "state.json").read_bytes() == original
        else:
            # A successful writer may never produce a journal its own reader rejects.
            client().resume_workspace(handle.private_state_path)
        # The normal compact representation retains every canonical entry without per-file path duplication.
        record["progress"]["capture"].pop("files")
        atomic_json(handle.private_state_path, record)
        loaded = client().resume_workspace(handle.private_state_path)
        assert len(loaded._progress["capture"]["manifest"]["entries"]) == 9990
        assert loaded.state["pendingCommand"]["request"]["body"]["manifest"] == manifest
        before = hashlib.sha256(Path(handle.private_state_path, "state.json").read_bytes()).hexdigest()
        excessive_history = copy.deepcopy(handle.record)
        excessive_history["progress"]["captures"] = [dict(directory=long_private_root, directoryIdentity=[1, 2])] * 30000
        expect(ValidationError, lambda: atomic_json(handle.private_state_path, excessive_history))
        assert hashlib.sha256(Path(handle.private_state_path, "state.json").read_bytes()).hexdigest() == before
        assert len(client().resume_workspace(handle.private_state_path)._progress["capture"]["manifest"]["entries"]) == 9990
    finally:
        # Restore the known live test session before performing real remote cleanup.
        atomic_json(handle.private_state_path, handle.record)
        retire(handle)


def poll_deadline_before_handoff():
    seed = opened()
    operation = seed.finalize(writers_stopped=True)
    proxy = Proxy()
    cv = Client(os.environ["CV_KEY_A"], proxy.url, timeout=2, poll_timeout=0.1)
    original = socket.getaddrinfo
    entered = threading.Event()
    release = threading.Event()
    def delayed_resolution(host, *args, **kwargs):
        if host == "127.0.0.1":
            entered.set()
            assert release.wait(timeout=5)
        return original(host, *args, **kwargs)
    try:
        socket.getaddrinfo = delayed_resolution
        started = time.monotonic()
        error = expect(OutcomeUnknownError, lambda: cv.operations.wait(operation["id"]))
        assert entered.is_set()
        assert time.monotonic() - started < 0.25
        assert error.operation_id == operation["id"]
        release.set()
        until = time.monotonic() + 1
        while any(thread.name == "ContextVault-operation-lookup" for thread in threading.enumerate()) and time.monotonic() < until:
            time.sleep(0.005)
        assert not any(thread.name == "ContextVault-operation-lookup" for thread in threading.enumerate())
        assert proxy.requests == [], "Canceled connection setup issued HTTP after its deadline"
    finally:
        release.set()
        socket.getaddrinfo = original
        cv.close()
        proxy.close()
        seed.cleanup(writers_stopped=True)


def first_definite_upload_rejection():
    proxy = Proxy()
    cv = client(url=proxy.url)
    handle = opened(cv)
    (Path(handle.path) / "two.bin").write_bytes(b"ab")
    try:
        error = expect(ValidationError, lambda: handle.finalize(writers_stopped=True))
        assert error.status_code == 413 and error.code == "QUOTA_EXCEEDED"
        assert any(method == "PUT" and status == 413 for method, path, status in proxy.statuses)
        saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
        command = saved["session"]["pendingCommand"]
        assert command["kind"] == "submission:file" and command["phase"] == "prepared"
        assert Path(command["request"]["capture"]["privateFilePath"]).read_bytes() == b"ab"
        recovered = cv.resume_workspace(handle.private_state_path)
        assert recovered.status()["state"] == "active"
        recovered.abort("discard definitely rejected upload", writers_stopped=True)
        assert recovered.status()["state"] == "aborted"
        assert Path(handle.path, "two.bin").read_bytes() == b"ab"
        assert Path(command["request"]["capture"]["privateFilePath"]).read_bytes() == b"ab"
        assert recovered._progress["rejectedCommand"]["idempotencyKey"] == command["idempotencyKey"]
        assert recovered._progress["rejectedCommand"]["request"] == command["request"]
        recovered.cleanup(writers_stopped=True)
        assert not Path(handle.path).exists()
        assert not Path(command["request"]["capture"]["privateFilePath"]).exists()
    finally:
        # A failed regression must not leave its known active test run behind.
        try:
            direct = client()
            current = direct.runs.get(handle.run["id"])
            if current["state"] == "active":
                direct.runs.abort(current["id"], current["version"], "test cleanup", idempotency_key=os.urandom(16).hex())
        finally:
            proxy.close()


def uncertain_upload_then_same_rejection(mode):
    proxy = Proxy()
    cv = client(url=proxy.url)
    handle = opened(cv)
    (Path(handle.path) / "one.bin").write_bytes(b"x")
    if mode == "loss":
        proxy.drop = lambda method, path: method == "PUT" and "/files?" in path
    elif mode == "receipt":
        proxy.corrupt_receipt = True
    else:
        proxy.fail_upload_after_accept = True
    try:
        initial = expect(ValidationError if mode == "receipt" else OutcomeUnknownError, lambda: handle.finalize(writers_stopped=True))
        if mode == "receipt":
            assert initial.code == "RECEIPT_MISMATCH" and not hasattr(initial, "http_status")
        saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
        original = saved["session"]["pendingCommand"]
        assert original["kind"] == "submission:file"
        assert original["phase"] == ("prepared" if mode == "receipt" else "outcome-unknown")
        expect(OutcomeUnknownError, lambda: cv.resume_workspace(handle.private_state_path).abort("no rejection proof", writers_stopped=True))
        proxy.corrupt_receipt = False
        assert any(method == "PUT" and status == 201 for method, path, status in proxy.statuses), "Original immutable receipt was not accepted"
        capture = original["request"]["capture"]["privateFilePath"]
        assert Path(capture).read_bytes() == b"x"
        (Path(handle.path) / "one.bin").write_bytes(b"changed after uncertainty")
        proxy.reject_status = 413
        proxy.reject_code = "QUOTA_EXCEEDED"
        proxy.reject = lambda method, path: method == "PUT" and "/files?" in path
        recovered = cv.resume_workspace(handle.private_state_path)
        error = expect(OutcomeUnknownError, recovered.reconcile)
        assert isinstance(error.__cause__, ValidationError) and error.__cause__.status_code == 413
        current = json.loads(Path(handle.private_state_path, "state.json").read_text())["session"]["pendingCommand"]
        assert current["phase"] == "outcome-unknown"
        assert current["idempotencyKey"] == original["idempotencyKey"] and current["request"] == original["request"]
        expect(OutcomeUnknownError, lambda: recovered.abort("unsafe discard", writers_stopped=True))
        expect(OutcomeUnknownError, lambda: recovered.cleanup(writers_stopped=True))
        assert Path(handle.path).exists() and Path(capture).read_bytes() == b"x"
        proxy.reject = None
        recovered.reconcile()
        uploads = [row for row in proxy.requests if row[0] == "PUT" and "/files?" in row[1]]
        assert len({row[2] for row in uploads}) == 1 and len({row[3] for row in uploads}) == 1
        reader = opened(cv, handle.workspace_id, mode="read-only")
        assert (Path(reader.path) / "one.bin").read_bytes() == b"x"
        reader.abort("done", writers_stopped=True, cleanup=True)
        recovered.cleanup(writers_stopped=True)
    finally:
        proxy.close()


def lost_upload_then_same_rejection():
    uncertain_upload_then_same_rejection("loss")


def generic_500_then_same_rejection():
    uncertain_upload_then_same_rejection("server-error")


def receipt_mismatch_then_same_rejection():
    uncertain_upload_then_same_rejection("receipt")


def rejected_retry_crash_stays_unknown():
    proxy = Proxy()
    proxy.reject_status = 413
    proxy.reject_code = "QUOTA_EXCEEDED"
    proxy.reject = lambda method, path: method == "PUT" and "/files?" in path
    cv = client(url=proxy.url)
    handle = opened(cv)
    (Path(handle.path) / "one.bin").write_bytes(b"x")
    process = None
    try:
        expect(ValidationError, lambda: handle.finalize(writers_stopped=True))
        original = json.loads(Path(handle.private_state_path, "state.json").read_text())["session"]["pendingCommand"]
        proxy.reject = None
        proxy.hold = lambda method, path: method == "PUT" and "/files?" in path
        process = subprocess.Popen([sys.executable, __file__, "worker", "finalize", proxy.url, handle.private_state_path, handle.workspace_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert proxy.held.wait(timeout=5), "Retry did not reach the real upload receipt barrier"
        process.kill()
        process.wait(timeout=5)
        saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
        assert saved["session"]["pendingCommand"]["phase"] == "dispatched"
        assert not saved["progress"].get("knownRejection"), "Old rejection proof survived retry dispatch"
        proxy.hold = None
        proxy.release.set()
        recovered = cv.resume_workspace(handle.private_state_path)
        expect(OutcomeUnknownError, lambda: recovered.abort("stale proof", writers_stopped=True))
        proxy.reject = lambda method, path: method == "PUT" and "/files?" in path
        expect(OutcomeUnknownError, recovered.reconcile)
        pending = json.loads(Path(handle.private_state_path, "state.json").read_text())["session"]["pendingCommand"]
        assert pending["idempotencyKey"] == original["idempotencyKey"] and pending["request"] == original["request"]
        assert Path(pending["request"]["capture"]["privateFilePath"]).read_bytes() == b"x"
        expect(OutcomeUnknownError, lambda: recovered.cleanup(writers_stopped=True))
        proxy.reject = None
        recovered.reconcile()
        recovered.cleanup(writers_stopped=True)
    finally:
        proxy.release.set()
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        proxy.close()


def rejected_reopen_checkpoint(proxy):
    cv = client(url=proxy.url)
    handle = opened(cv)
    old_run = handle.run["id"]
    (Path(handle.path) / "accepted.bin").write_bytes(b"accepted-checkpoint\x00\xff")
    proxy.reject = lambda method, path: method == "POST" and path.endswith("/runs")
    expect(AuthError, lambda: handle.checkpoint(writers_stopped=True))
    saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
    pending = saved["session"]["pendingCommand"]
    assert pending["kind"] == "run:open" and pending["phase"] == "prepared"
    assert saved["progress"]["knownRejection"]["idempotencyKey"] == pending["idempotencyKey"]
    assert saved["progress"]["lastOperation"]["state"] == "succeeded"
    assert cv.runs.get(old_run)["state"] == "finalized"
    return cv, handle, old_run, saved


def assert_checkpoint_content(cv, handle, operation):
    assert cv.operations.get(operation["id"])["result"] == operation["result"]
    reader = opened(cv, handle.workspace_id, mode="read-only")
    assert reader.run["baseRevisionId"] == operation["result"]["revisionId"]
    assert (Path(reader.path) / "accepted.bin").read_bytes() == b"accepted-checkpoint\x00\xff"
    reader.abort("verify preserved checkpoint", writers_stopped=True, cleanup=True)


def cleanup_definitely_rejected_reopen():
    import copy
    from contextvault.local import atomic_json
    proxy = Proxy()
    cv, handle, old_run, saved = rejected_reopen_checkpoint(proxy)
    original = saved["session"]["pendingCommand"]
    operation = saved["progress"]["lastOperation"]
    try:
        # A changed request proof cannot authorize abandonment.
        damaged = copy.deepcopy(saved)
        damaged["progress"]["knownRejection"]["requestFingerprint"] = "0" * 64
        atomic_json(handle.private_state_path, damaged)
        expect(OutcomeUnknownError, lambda: cv.resume_workspace(handle.private_state_path).cleanup(writers_stopped=True))
        atomic_json(handle.private_state_path, saved)
        # Current read authority remains required even though opening permission is unavailable.
        proxy.reject = lambda method, path: path.endswith("/runs") or (method == "GET" and (path.startswith("/v1/runs/") or path.startswith("/v1/operations/")))
        expect(AuthError, lambda: cv.resume_workspace(handle.private_state_path).cleanup(writers_stopped=True))
        after_denial = json.loads(Path(handle.private_state_path, "state.json").read_text())
        assert after_denial["session"]["pendingCommand"] == original and Path(handle.path).exists()
        proxy.reject = lambda method, path: method == "POST" and path.endswith("/runs")
        # Phase labels cannot establish or defeat the accepted terminal result and exact rejection proof.
        saved["progress"]["phase"] = "ready"
        atomic_json(handle.private_state_path, saved)
        outside = Path(tempfile.mkdtemp())
        (outside / "kept").write_text("foreign")
        (Path(handle.path) / "unsafe").symlink_to(outside, target_is_directory=True)
        recovered = cv.resume_workspace(handle.private_state_path)
        expect(ValidationError, lambda: recovered.cleanup(writers_stopped=True))
        retired = json.loads(Path(handle.private_state_path, "state.json").read_text())
        assert retired["session"]["pendingCommand"] is None
        assert retired["progress"]["abandonedReopen"]["command"] == original
        assert retired["progress"]["lastOperation"] == operation
        assert retired["progress"]["receipts"] == saved["progress"]["receipts"]
        assert retired["progress"]["submission"] == saved["progress"]["submission"]
        assert (outside / "kept").read_text() == "foreign"
        (Path(handle.path) / "unsafe").unlink()
        recovered = cv.resume_workspace(handle.private_state_path)
        expect(ValidationError, recovered.reconcile)
        expect(ValidationError, lambda: recovered.checkpoint(writers_stopped=True))
        recovered.cleanup(writers_stopped=True)
        assert not Path(handle.path).exists()
        assert recovered.status()["state"] == "finalized"
        count = len([entry for entry in proxy.requests if entry[0] == "POST" and entry[1].endswith("/runs")])
        proxy.reject = None
        final = cv.resume_workspace(handle.private_state_path)
        expect(ValidationError, final.reconcile)
        expect(ValidationError, lambda: final.checkpoint(writers_stopped=True))
        assert len([entry for entry in proxy.requests if entry[0] == "POST" and entry[1].endswith("/runs")]) == count
        assert not any(entry[1] == "/v1/runs/" + old_run + "/abort" for entry in proxy.requests)
        assert len([entry for entry in proxy.requests if entry[1].endswith("/finalize")]) == 1
        assert_checkpoint_content(cv, handle, operation)
        shutil.rmtree(str(outside))
    finally:
        proxy.close()


def rejected_reopen_restores_original_key():
    proxy = Proxy()
    cv, handle, old_run, saved = rejected_reopen_checkpoint(proxy)
    original = saved["session"]["pendingCommand"]
    operation = saved["progress"]["lastOperation"]
    try:
        proxy.reject = None
        recovered = cv.resume_workspace(handle.private_state_path)
        recovered.reconcile()
        assert recovered.run["id"] != old_run and recovered.recovery_status == "ready"
        assert recovered.path == handle.path
        opens = [entry for entry in proxy.requests if entry[0] == "POST" and entry[1] == original["request"]["path"]]
        assert opens[-1][2] == opens[-2][2] == original["idempotencyKey"]
        assert opens[-1][3] == opens[-2][3]
        assert len([entry for entry in proxy.requests if entry[1].endswith("/finalize")]) == 1
        expect(ValidationError, lambda: recovered.cleanup(writers_stopped=True))
        assert Path(recovered.path).exists() and recovered.status()["state"] == "active"
        recovered.abort("stop newly opened run", writers_stopped=True, cleanup=True)
        assert_checkpoint_content(cv, handle, operation)
    finally:
        proxy.close()


def accepted_lost_reopen_denial_stays_protected():
    proxy = Proxy()
    cv = client(url=proxy.url)
    handle = opened(cv)
    old_run = handle.run["id"]
    (Path(handle.path) / "accepted.bin").write_bytes(b"accepted-checkpoint\x00\xff")
    proxy.drop = lambda method, path: method == "POST" and path.endswith("/runs")
    try:
        expect(OutcomeUnknownError, lambda: handle.checkpoint(writers_stopped=True))
        saved = json.loads(Path(handle.private_state_path, "state.json").read_text())
        original = saved["session"]["pendingCommand"]
        operation = saved["progress"]["lastOperation"]
        assert original["kind"] == "run:open" and original["phase"] == "outcome-unknown"
        proxy.reject = lambda method, path: method == "POST" and path.endswith("/runs")
        recovered = cv.resume_workspace(handle.private_state_path)
        expect(OutcomeUnknownError, recovered.reconcile)
        expect(OutcomeUnknownError, lambda: recovered.cleanup(writers_stopped=True))
        expect(OutcomeUnknownError, lambda: recovered.abort("unsafe abandonment", writers_stopped=True))
        assert Path(handle.path).exists()
        still = json.loads(Path(handle.private_state_path, "state.json").read_text())["session"]["pendingCommand"]
        assert still["idempotencyKey"] == original["idempotencyKey"] and still["request"] == original["request"]
        proxy.reject = None
        recovered.reconcile()
        assert recovered.run["id"] != old_run and recovered.status()["state"] == "active"
        opens = [entry for entry in proxy.requests if entry[0] == "POST" and entry[1] == original["request"]["path"]][1:]
        assert len({entry[2] for entry in opens}) == 1 and len({entry[3] for entry in opens}) == 1
        expect(ValidationError, lambda: recovered.cleanup(writers_stopped=True))
        recovered = client(url=proxy.url).resume_workspace(handle.private_state_path)
        recovered.abort("stop reconciled run", writers_stopped=True, cleanup=True)
        assert_checkpoint_content(cv, handle, operation)
    finally:
        proxy.close()


if __name__ == "__main__":
    if sys.argv[1] == "worker":
        worker()
    else:
        scenario = sys.argv[1]
        globals()[scenario]()
        print("PASS " + scenario + " Python " + str(sys.version_info.major) + "." + str(sys.version_info.minor))
