"""Host-only controller. Installed Python 3.8 sees artifacts and HTTP credentials only."""
import json
from contextlib import contextmanager
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[3]


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop("timeout", 180), text=True, capture_output=True, **kwargs)


@pytest.fixture(scope="session")
def installed():
    with tempfile.TemporaryDirectory(prefix="cv-python-proof-") as directory:
        artifact = Path(directory).resolve()
        package = artifact / "package"
        shutil.copytree(ROOT / "sdk/python", package, ignore=shutil.ignore_patterns(".test-env", "build", "dist", "*.egg-info", "__pycache__", ".pytest_cache"))
        wheelhouse = artifact / "wheels"
        run([sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", str(wheelhouse), str(package)])
        # Download the dependency resolution for the minimum runtime, not the host Python.
        run([sys.executable, "-m", "pip", "download", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:", "--python-version", "3.8", "--platform", "any", "--implementation", "py", "--abi", "none", "--dest", str(wheelhouse), "requests>=2.20,<3"])
        shutil.rmtree(package)  # The runtime mount contains no SDK source checkout.
        shutil.copy2(Path(__file__).with_name("consumer.py"), artifact / "consumer.py")
        shutil.copy2(ROOT / "tests/fixtures/workspaces/canonical.v1.json", artifact / "canonical.json")
        name = "cv-python-proof-" + uuid.uuid4().hex
        run(["docker", "run", "--detach", "--name", name, "--add-host=host.docker.internal:host-gateway", "--mount", "type=bind,src={},dst=/proof,readonly".format(artifact), "python:3.8-slim", "sleep", "3600"])
        try:
            run(["docker", "exec", name, "sh", "-c", "python -m pip install --no-index --find-links=/proof/wheels contextvault && mkdir /consumer"])
            yield name
        finally:
            run(["docker", "rm", "--force", name], timeout=30)


@contextmanager
def workspace_server(backend, lease_ttl_ms):
    if backend == "s3":
        assert os.environ.get("CV_TEST_S3_PROVIDER") == "localstack", "Explicit selected LocalStack target is required; no backend fallback"
        for name in ("CV_TEST_S3_ENDPOINT", "CV_TEST_S3_BUCKET", "CV_TEST_S3_REGION", "CV_TEST_S3_PREFIX"):
            assert os.environ.get(name), "Missing " + name
    node = os.environ.get("CV_TEST_SERVER_NODE", "node")
    process = subprocess.Popen([node, str(ROOT / "tests/helpers/workspace-server.mjs"), "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy())
    count = 0

    def command(name, **kwargs):
        nonlocal count
        count += 1
        process.stdin.write(json.dumps(dict(id=count, command=name, **kwargs)) + "\n")
        process.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            assert selector.select(60), "Controller timed out"
            line = process.stdout.readline()
        finally:
            selector.close()
        assert line, "Controller exited"
        result = json.loads(line)
        assert result.get("ok"), result
        return result
    started = False
    try:
        descriptor = command("start", backend=backend, serverNode=node, serverEnv={"CV_LEASE_TTL_MS": str(lease_ttl_ms), "CV_MAINTENANCE_INTERVAL_MS": "100"})["client"]
        started = True
        descriptor["baseUrl"] = descriptor["baseUrl"].replace("127.0.0.1", "host.docker.internal")
        yield descriptor
    finally:
        try:
            if process.poll() is None and started:
                command("dispose")
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=45)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            assert process.returncode == 0, process.stderr.read()[-2000:]


@pytest.fixture(scope="module", params=["git", "s3"])
def server(request):
    # Ordinary journeys must not inherit the deliberately short expiry-test lease.
    with workspace_server(request.param, 30000) as descriptor:
        yield descriptor


@pytest.fixture(scope="module", params=["git", "s3"])
def expiry_server(request):
    with workspace_server(request.param, 4000) as descriptor:
        yield descriptor


def installed_consumer(installed, server):
    def execute(scenario):
        environment = {"CV_URL": server["baseUrl"], "CV_KEY_A": server["keyA"], "CV_KEY_B": server["keyB"], "CV_CUSTOMER_A": server["customerA"], "CV_CUSTOMER_B": server["customerB"]}
        arguments = ["docker", "exec", "--workdir", "/consumer"]
        for key, value in environment.items():
            arguments += ["--env", key + "=" + value]
        result = subprocess.run(arguments + [installed, "python", "/proof/consumer.py", scenario], text=True, capture_output=True, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "PASS " + scenario + " Python 3.8" in result.stdout, result.stdout
    return execute


@pytest.fixture
def consumer(installed, server):
    return installed_consumer(installed, server)


@pytest.fixture
def expiry_consumer(installed, expiry_server):
    return installed_consumer(installed, expiry_server)
