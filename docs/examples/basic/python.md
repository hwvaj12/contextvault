# Python Basic Example

A complete example that creates a workspace, writes files, commits, reads them back, and cleans up.

## Full Workflow

```python
import os
from contextvault import Client
from contextvault.exceptions import NotFoundError

def main():
    # Initialize client
    cv = Client(
        api_key="cv-test-api-key-123",
        base_url="http://localhost:3000",
    )

    customer_id = "customer-123"

    # --- Create a workspace ---
    workspace = cv.workspaces.create(
        customer_id=customer_id,
        name="demo-workspace",
    )
    workspace_id = workspace["id"]
    print(f"Created workspace: {workspace_id}")

    # --- Checkout a sandbox ---
    sandbox = cv.workspaces.checkout(workspace_id)
    sandbox_path = sandbox["path"]
    print(f"Sandbox path: {sandbox_path}")

    # --- Write files to the sandbox ---
    if sandbox_path:
        notes_dir = os.path.join(sandbox_path, "notes")
        os.makedirs(notes_dir, exist_ok=True)

        with open(os.path.join(notes_dir, "meeting.md"), "w") as f:
            f.write("# Meeting Notes\n\n- Discussed project timeline\n- Agreed on milestones\n")

        with open(os.path.join(sandbox_path, "config.json"), "w") as f:
            f.write('{\n  "theme": "dark",\n  "language": "en"\n}')

    # --- Commit changes ---
    commit = cv.workspaces.commit(
        workspace_id=workspace_id,
        message="Add meeting notes and config",
        author="demo-agent",
    )
    print(f"Committed: {commit['commitId']}")

    # --- Destroy the sandbox ---
    cv.workspaces.destroy(workspace_id)
    print("Sandbox destroyed")

    # --- Pull files back ---
    files = cv.workspaces.pull(workspace_id)
    print("\nFiles in workspace:")
    for f in files:
        print(f"  {f['path']} ({len(f['content'])} bytes)")

    # --- Get a single file ---
    meeting = cv.workspaces.get_file(workspace_id, "notes/meeting.md")
    print("\nMeeting notes content:")
    print(meeting)

    # --- View history ---
    history = cv.workspaces.history(workspace_id)
    print("\nCommit history:")
    for entry in history:
        print(f"  {entry['commitId']}")

    # --- List all workspaces for this customer ---
    workspaces = cv.workspaces.list(customer_id=customer_id)
    print(f"\nCustomer has {len(workspaces)} workspace(s)")

    # --- Cleanup: delete the workspace ---
    cv.workspaces.delete(workspace_id)
    print("Workspace deleted")

    # --- Verify deletion ---
    try:
        cv.workspaces.get(workspace_id)
    except NotFoundError:
        print("Confirmed: workspace no longer exists")


if __name__ == "__main__":
    main()
```

## Run It

```bash
python example.py
```
