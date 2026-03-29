# ContextVault Python SDK

Official Python SDK for [ContextVault](https://github.com/contextvault) -- persistent, versioned context storage for AI agents.

## Installation

```bash
pip install contextvault
```

Or install from source:

```bash
cd sdk/python
pip install -e .
```

## Quickstart

```python
from src import Client

# Initialize the client
cv = Client(api_key="cv_key_xxx")

# Create a workspace
workspace = cv.workspaces.create(
    customer_id="cust_123",
    name="onboarding-context",
)
print(workspace["id"])

# List workspaces for a customer
workspaces = cv.workspaces.list(customer_id="cust_123")

# Checkout a sandbox, make changes, then commit
cv.workspaces.checkout(workspace["id"])
cv.workspaces.commit(workspace["id"], message="Initial data", author="agent-1")

# Pull all files
files = cv.workspaces.pull(workspace["id"])

# Get a single file
file = cv.workspaces.get_file(workspace["id"], "profile/summary.md")

# View commit history
history = cv.workspaces.history(workspace["id"])

# Clean up
cv.workspaces.destroy(workspace["id"])
cv.workspaces.delete(workspace["id"])
```

## Error Handling

The SDK raises typed exceptions so you can handle specific failure modes:

```python
from src import Client, NotFoundError, AuthError, ValidationError

cv = Client(api_key="cv_key_xxx")

try:
    workspace = cv.workspaces.get("nonexistent-id")
except NotFoundError:
    print("Workspace does not exist")
except AuthError:
    print("Invalid or missing API key")
except ValidationError:
    print("Bad request parameters")
```

All exceptions inherit from `ContextVaultError`, which you can use as a catch-all:

```python
from src import ContextVaultError

try:
    cv.workspaces.get("some-id")
except ContextVaultError as e:
    print(f"API error ({e.status_code}): {e.message}")
```

## Features

- Auto-retry with exponential backoff on network errors (max 3 retries)
- Typed exception hierarchy for clean error handling
- Full type hints for IDE support
- Minimal dependencies (only `requests`)

## Requirements

- Python 3.8+
- `requests` library
