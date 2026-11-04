import pytest


def test_duplicate_and_concurrent_checkout_preserves_ownership(consumer):
    consumer("duplicate_checkout")


def test_capture_crash_recovery_cleans_owned_bytes_and_keeps_foreign_paths(consumer):
    consumer("orphan_capture_cleanup")


def test_known_active_partial_hydration_can_explicitly_abort(consumer):
    consumer("abort_failed_hydration")


def test_overlapping_same_key_creation_returns_canonical_workspace(consumer):
    consumer("overlapping_creation")


@pytest.mark.parametrize("stage", ["headers", "body", "trickle"])
def test_polling_bounds_http_to_remaining_deadline(consumer, stage):
    consumer("poll_deadline_" + stage)


def test_canonical_size_journal_writes_remain_readable_or_preserve_prior_state(consumer):
    consumer("journal_readback_bound")


def test_poll_deadline_cancellation_before_socket_handoff(consumer):
    consumer("poll_deadline_before_handoff")


@pytest.fixture(scope="module", params=["git", "s3"])
def limited_rejection_server(request):
    """A separate normal server with a one-byte quota, controlled only by the host."""
    import json
    import os
    from pathlib import Path
    import selectors
    import subprocess
    root = Path(__file__).resolve().parents[3]
    if request.param == "s3":
        assert os.environ.get("CV_TEST_S3_PROVIDER") == "localstack"
        for name in ("CV_TEST_S3_ENDPOINT", "CV_TEST_S3_BUCKET", "CV_TEST_S3_REGION", "CV_TEST_S3_PREFIX"):
            assert os.environ.get(name), "Missing explicit LocalStack target: " + name
    node = os.environ.get("CV_TEST_SERVER_NODE", "/usr/local/bin/node")
    process = subprocess.Popen([node, str(root / "tests/helpers/workspace-server.mjs"), "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy())
    counter = 0
    def command(name, **options):
        nonlocal counter
        counter += 1
        process.stdin.write(json.dumps(dict(id=counter, command=name, **options)) + "\n")
        process.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            assert selector.select(60), "Quota controller timed out"
            result = json.loads(process.stdout.readline())
        finally:
            selector.close()
        assert result.get("ok"), result
        return result
    started = False
    try:
        client = command("start", backend=request.param, serverNode=node, serverEnv={"CV_LEASE_TTL_MS": "10000", "CV_MAINTENANCE_INTERVAL_MS": "100", "CV_WORKSPACE_LIMITS": json.dumps(dict(maxFileBytes=1))})["client"]
        started = True
        client["baseUrl"] = client["baseUrl"].replace("127.0.0.1", "host.docker.internal")
        yield client
    finally:
        try:
            if process.poll() is None and started:
                command("dispose")
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=45)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            assert process.returncode == 0, process.stderr.read()[-2000:]


@pytest.fixture
def limited_rejection_consumer(installed, limited_rejection_server):
    import subprocess
    def execute(scenario):
        client = limited_rejection_server
        environment = dict(CV_URL=client["baseUrl"], CV_KEY_A=client["keyA"], CV_KEY_B=client["keyB"], CV_CUSTOMER_A=client["customerA"], CV_CUSTOMER_B=client["customerB"])
        arguments = ["docker", "exec", "--workdir", "/consumer"]
        for name, value in environment.items():
            arguments += ["--env", name + "=" + value]
        result = subprocess.run(arguments + [installed, "python", "/proof/consumer.py", scenario], text=True, capture_output=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "PASS " + scenario + " Python 3.8" in result.stdout
    return execute


def test_first_definite_http_rejection_allows_explicit_abort(limited_rejection_consumer):
    limited_rejection_consumer("first_definite_upload_rejection")


def test_same_http_rejection_after_response_loss_stays_unknown(limited_rejection_consumer):
    limited_rejection_consumer("lost_upload_then_same_rejection")


def test_generic_500_then_same_http_rejection_stays_unknown(limited_rejection_consumer):
    limited_rejection_consumer("generic_500_then_same_rejection")


def test_local_receipt_mismatch_cannot_prove_http_rejection(limited_rejection_consumer):
    limited_rejection_consumer("receipt_mismatch_then_same_rejection")


def test_prior_rejection_proof_clears_before_retry_dispatch(limited_rejection_consumer):
    limited_rejection_consumer("rejected_retry_crash_stays_unknown")


def test_known_rejected_reopen_allows_durable_local_abandonment(consumer):
    consumer("cleanup_definitely_rejected_reopen")


def test_reopen_permission_restoration_reuses_original_command(consumer):
    consumer("rejected_reopen_restores_original_key")


def test_accepted_lost_reopen_then_denial_blocks_abandonment(consumer):
    consumer("accepted_lost_reopen_denial_stays_protected")
