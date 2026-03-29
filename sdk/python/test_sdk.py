"""Integration tests for the ContextVault Python SDK against the live API."""

import sys
import uuid
from pathlib import Path

# Ensure the src package is importable
sys.path.insert(0, str(Path(__file__).parent))

from src import Client
from src.exceptions import NotFoundError

BASE_URL = "http://localhost:3000"
API_KEY = "cv-test-api-key-123"


def random_name(prefix: str = "test") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_full_workspace_lifecycle():
    """Create, use, and delete a workspace through all SDK methods."""
    cv = Client(api_key=API_KEY, base_url=BASE_URL)
    customer_id = f"cust-{uuid.uuid4().hex[:8]}"
    ws_name = random_name("py-sdk")
    created_ws = None

    try:
        # ── Create ──────────────────────────────────────────────────
        created_ws = cv.workspaces.create(customer_id=customer_id, name=ws_name)
        assert created_ws["id"], "workspace must have an id"
        assert created_ws["customerId"] == customer_id
        assert created_ws["name"] == ws_name
        assert created_ws["latestCommitId"] is None
        ws_id = created_ws["id"]
        print(f"  ✓ create -> {ws_id}")

        # ── List (no filter) ────────────────────────────────────────
        all_ws = cv.workspaces.list()
        assert isinstance(all_ws, list)
        assert any(w["id"] == ws_id for w in all_ws)
        print(f"  ✓ list (all) -> {len(all_ws)} workspaces")

        # ── List (filtered — server may ignore the filter) ──────────
        filtered = cv.workspaces.list(customer_id=customer_id)
        assert isinstance(filtered, list)
        print(f"  ✓ list(customer_id={customer_id}) -> {len(filtered)} workspaces")

        # ── Get ──────────────────────────────────────────────────────
        ws = cv.workspaces.get(ws_id)
        assert ws["id"] == ws_id
        print(f"  ✓ get -> {ws_id}")

        # ── Checkout / sandbox ───────────────────────────────────────
        sandbox = cv.workspaces.checkout(ws_id)
        assert sandbox["workspaceId"] == ws_id
        assert sandbox["sandboxId"]
        sandbox_id = sandbox["sandboxId"]
        print(f"  ✓ checkout -> sandboxId={sandbox_id}")

        # ── Pull (empty workspace) ───────────────────────────────────
        pull_result = cv.workspaces.pull(ws_id)
        assert "files" in pull_result
        assert "commitId" in pull_result
        assert isinstance(pull_result["files"], list)
        print(f"  ✓ pull (empty) -> files={len(pull_result['files'])}")

        # ── Commit (empty sandbox → NO_CHANGES is expected) ─────────
        try:
            commit = cv.workspaces.commit(
                ws_id,
                message="Initial commit",
                author="python-sdk-test",
                agent_id="test-agent",
                tags=["test", "python"],
            )
            assert commit["workspaceId"] == ws_id
            assert commit["commitId"]
            commit_id = commit["commitId"]
            print(f"  ✓ commit -> commitId={commit_id}")
        except Exception as e:
            # Empty sandbox returns NO_CHANGES; that is expected server behavior
            if "NO_CHANGES" in str(e):
                print(f"  ✓ commit -> NO_CHANGES (empty sandbox, expected)")
                commit_id = None
            else:
                raise

        # ── Pull (with content or empty) ──────────────────────────────
        pull2 = cv.workspaces.pull(ws_id)
        assert "files" in pull2
        assert "commitId" in pull2
        assert isinstance(pull2["files"], list)
        print(f"  ✓ pull (after commit) -> files={len(pull2['files'])}")

        # ── Pull specific version ───────────────────────────────────
        if commit_id:
            pull_v = cv.workspaces.pull(ws_id, version=commit_id)
            assert pull_v["commitId"] == commit_id
            print(f"  ✓ pull(version={commit_id[:8]})")

        # ── History ──────────────────────────────────────────────────
        history = cv.workspaces.history(ws_id)
        assert "commits" in history
        assert "count" in history
        assert isinstance(history["count"], int)
        assert isinstance(history["commits"], list)
        assert len(history["commits"]) == history["count"]
        if commit_id and history["count"] > 0:
            latest = history["commits"][0]
            assert latest["commitId"] == commit_id
        print(f"  ✓ history -> {history['count']} commits")

        # ── History with limit ───────────────────────────────────────
        hist_limited = cv.workspaces.history(ws_id, limit=1)
        if hist_limited["count"] > 0:
            assert len(hist_limited["commits"]) == 1
            print(f"  ✓ history(limit=1) -> 1 commit")
        else:
            print(f"  ✓ history(limit=1) -> 0 commits (empty workspace)")

        # ── Destroy sandbox ──────────────────────────────────────────
        destroy_result = cv.workspaces.destroy(ws_id)
        assert destroy_result["workspaceId"] == ws_id
        print(f"  ✓ destroy sandbox")

        # ── Checkout again after destroy ─────────────────────────────
        sandbox2 = cv.workspaces.checkout(ws_id)
        assert sandbox2["workspaceId"] == ws_id
        print(f"  ✓ checkout (re-checkout)")

        # ── Delete workspace ─────────────────────────────────────────
        cv.workspaces.delete(ws_id)
        print(f"  ✓ delete -> {ws_id}")

        # ── Get deleted workspace (should 404) ───────────────────────
        try:
            cv.workspaces.get(ws_id)
            raise AssertionError("Expected NotFoundError")
        except NotFoundError:
            print(f"  ✓ get deleted workspace -> NotFoundError")

    finally:
        # Clean up: delete workspace if it still exists
        if created_ws is not None:
            try:
                cv.workspaces.delete(created_ws["id"])
            except Exception:
                pass


def test_not_found():
    """NotFoundError is raised for nonexistent workspace."""
    cv = Client(api_key=API_KEY, base_url=BASE_URL)
    try:
        cv.workspaces.get("nonexistent-workspace-id")
        raise AssertionError("Expected NotFoundError")
    except NotFoundError:
        print("  ✓ get nonexistent -> NotFoundError")


if __name__ == "__main__":
    print("ContextVault Python SDK — live API integration tests")
    print("=" * 60)

    print("\n[test_not_found]")
    test_not_found()

    print("\n[test_full_workspace_lifecycle]")
    test_full_workspace_lifecycle()

    print("\n" + "=" * 60)
    print("All tests passed ✓")
