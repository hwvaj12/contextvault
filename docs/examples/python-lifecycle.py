"""Run from a consumer project with the ContextVault wheel installed."""
import json
import os
import sys
import tempfile
from pathlib import Path
from contextvault import Client


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


for variable in ("CV_API_URL", "CV_API_KEY", "CV_CUSTOMER_ID"):
    if not os.environ.get(variable):
        raise RuntimeError(variable + " is required")
client = Client(api_key=os.environ["CV_API_KEY"], base_url=os.environ["CV_API_URL"])
parent = tempfile.mkdtemp(prefix="contextvault-example-", dir=os.path.realpath(os.getcwd()))
payload = b"\x00\xff\x80\n"
session = None


def options(name):
    return dict(private_state_path=os.path.join(parent, name), local_parent=parent,
                agent_label="python-example", task=name, reason="Run the documented lifecycle")


try:
    session = client.create_workspace(os.environ["CV_CUSTOMER_ID"], "Python documentation example", **options("publish"))
    workspace_id = session.workspace_id
    Path(session.path, "output.bin").write_bytes(payload)
    Path(session.path, "remove.txt").write_text("This file is removed in the next revision.")
    Path(session.path, "empty").mkdir()
    # The application stops every agent writer before this explicit publication.
    check(session.finalize(writers_stopped=True)["state"] == "succeeded", "Publication failed")
    session.cleanup(writers_stopped=True)

    session = client.open_workspace(workspace_id, **options("delete"))
    check(Path(session.path, "output.bin").read_bytes() == payload, "Binary bytes changed")
    Path(session.path, "remove.txt").unlink()
    check(session.finalize(writers_stopped=True)["state"] == "succeeded", "Deletion failed")
    session.cleanup(writers_stopped=True)

    session = client.open_workspace(workspace_id, **options("abort"))
    Path(session.path, "discarded.txt").write_text("This edit is never published.")
    check(session.abort("Demonstrate explicit abort", writers_stopped=True)["state"] == "aborted", "Abort failed")
    session.cleanup(writers_stopped=True)

    session = client.open_workspace(workspace_id, mode="read-only", **options("verify"))
    check(Path(session.path, "output.bin").read_bytes() == payload, "Binary bytes changed")
    check(not Path(session.path, "remove.txt").exists(), "Deletion was not retained")
    check(not Path(session.path, "discarded.txt").exists(), "Aborted edit was published")
    check(Path(session.path, "empty").is_dir(), "Empty directory was lost")
    check(session.finalize(writers_stopped=True)["state"] == "succeeded", "Read-only completion failed")
    recovery = session.private_state_path
    session.cleanup(writers_stopped=True)
    print(json.dumps(dict(language="python", workspaceId=workspace_id, privateStatePath=recovery,
                         binary=True, deletion=True, abort=True, cleanup=True)))
except Exception as error:
    # Retain files and the exact journal when an outcome needs reconciliation.
    print(json.dumps(dict(error=getattr(error, "code", "EXAMPLE_FAILED"),
                          privateStatePath=getattr(error, "private_state_path", getattr(session, "private_state_path", None)))), file=sys.stderr)
    sys.exit(1)
finally:
    client.close()
