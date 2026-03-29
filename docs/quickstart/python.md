# Python Quickstart

Get up and running with ContextVault in Python in under 5 minutes.

## Install

```bash
pip install contextvault
```

## Initialize the Client

```python
from contextvault import Client

cv = Client(
    api_key="cv-test-api-key-123",
    base_url="http://localhost:3000",  # optional, this is the default
)
```

## Create a Workspace

```python
workspace = cv.workspaces.create(
    customer_id="customer-123",
    name="agent-memory",
)

print(workspace["id"])
```

## Checkout, Write, and Commit

```python
# 1. Checkout a sandbox
sandbox = cv.workspaces.checkout(workspace["id"])
print(sandbox["path"])  # writable directory path

# 2. Your agent writes files to sandbox["path"]
# (use open(), pathlib, or any file-writing method)

# 3. Commit the changes
commit = cv.workspaces.commit(
    workspace_id=workspace["id"],
    message="Save agent session data",
    author="my-agent",
)

print(commit["commitId"])

# 4. Cleanup
cv.workspaces.destroy(workspace["id"])
```

## Read Files

```python
# Get all files from latest commit
files = cv.workspaces.pull(workspace["id"])
for f in files:
    print(f["path"], f["content"])

# Get a single file
file = cv.workspaces.get_file(workspace["id"], "profile/summary.md")
print(file)
```

## View History

```python
history = cv.workspaces.history(workspace["id"])
for entry in history:
    print(entry["commitId"])
```

## Error Handling

```python
from contextvault.exceptions import (
    NotFoundError,
    AuthError,
    ValidationError,
    NetworkError,
)

try:
    ws = cv.workspaces.get("nonexistent")
except NotFoundError:
    print("Workspace not found")
except AuthError:
    print("Invalid API key")
except ValidationError as e:
    print(f"Bad request: {e}")
except NetworkError as e:
    print(f"Connection failed: {e}")
```

The Python SDK automatically retries failed requests (up to 3 times) with exponential backoff on connection errors and timeouts.

## Next Steps

- [Full Workspaces API Reference](../api/workspaces.md)
- [Basic Examples](../examples/basic/python.md)
- [TypeScript Quickstart](typescript.md) | [PHP Quickstart](php.md)
