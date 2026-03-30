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
from contextvault import Client

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

# Compare two commits
diff = cv.workspaces.diff(workspace["id"], from_commit="abc123", to_commit="def456")

# Clean up
cv.workspaces.destroy(workspace["id"])
cv.workspaces.delete(workspace["id"])
```

## API Reference

### Workspaces

| Method | Description |
|--------|-------------|
| `cv.workspaces.create(customer_id, name)` | Create a new workspace |
| `cv.workspaces.list(customer_id=None)` | List workspaces, optionally filtered by customer |
| `cv.workspaces.get(workspace_id)` | Get a single workspace by ID |
| `cv.workspaces.delete(workspace_id)` | Soft-delete a workspace |
| `cv.workspaces.bulk_delete(workspace_ids)` | Hard-delete multiple workspaces |
| `cv.workspaces.clone(workspace_id, target_customer_id, name=None)` | Clone a workspace |

### Sandbox Operations

| Method | Description |
|--------|-------------|
| `cv.workspaces.checkout(workspace_id)` | Create a sandbox for editing |
| `cv.workspaces.commit(workspace_id, message=None, author=None, agent_id=None, task_id=None, tags=None)` | Commit sandbox changes |
| `cv.workspaces.destroy(workspace_id)` | Destroy sandbox (keeps workspace) |

### Version Control

| Method | Description |
|--------|-------------|
| `cv.workspaces.pull(workspace_id, version=None)` | Pull files from latest or specific commit |
| `cv.workspaces.get_file(workspace_id, file_path)` | Get a single file |
| `cv.workspaces.history(workspace_id, limit=None)` | Get commit history |
| `cv.workspaces.diff(workspace_id, from_commit, to_commit)` | Compare two commits |

### Webhooks

| Method | Description |
|--------|-------------|
| `cv.webhooks.register(customer_id, url, events, secret=None)` | Register a webhook endpoint |
| `cv.webhooks.list(customer_id)` | List webhooks for a customer |
| `cv.webhooks.delete(webhook_id)` | Delete a webhook |

### API Keys

| Method | Description |
|--------|-------------|
| `cv.api_keys.create(customer_id, name)` | Create an API key (plain key returned once) |
| `cv.api_keys.list()` | List API keys |
| `cv.api_keys.revoke(key_id)` | Revoke an API key |

## Error Handling

The SDK raises typed exceptions so you can handle specific failure modes:

```python
from contextvault import Client, NotFoundError, AuthError, ValidationError, NetworkError

cv = Client(api_key="cv_key_xxx")

try:
    workspace = cv.workspaces.get("nonexistent-id")
except NotFoundError:
    print("Workspace does not exist")
except AuthError:
    print("Invalid or missing API key")
except ValidationError:
    print("Bad request parameters")
except NetworkError:
    print("Connection failed or timed out (retries exhausted)")
```

All exceptions inherit from `ContextVaultError`, which you can use as a catch-all:

```python
from contextvault import ContextVaultError

try:
    cv.workspaces.get("some-id")
except ContextVaultError as e:
    print(f"API error ({e.status_code}): {e.message}")
```

### Common Errors

| Exception | HTTP Status | When |
|-----------|-------------|------|
| `NotFoundError` | 404 | Workspace or resource does not exist |
| `AuthError` | 401, 403 | Invalid or missing API key |
| `ValidationError` | 400, 422 | Bad request parameters |
| `NetworkError` | -- | Connection refused, timeout, DNS failure |
| `ContextVaultError` | Any other | Server error or unexpected status code |

---

## Patterns

### Pattern 1: Single-Agent Session

A single agent uses a workspace as its memory for one task or conversation.

```
Agent --> checkout --> [work in sandbox] --> commit --> destroy
```

**When to use:** One agent handling a standalone task. No other agent needs this workspace.

```python
from contextvault import Client

cv = Client(api_key="cv_key_xxx")

# Start: pull latest context
state = cv.workspaces.pull(workspace_id)

# Agent works, produces results...

# Save: checkout, write files to sandbox, commit
cv.workspaces.checkout(workspace_id)
# (agent writes files into the sandbox path)
cv.workspaces.commit(workspace_id, message="Task complete", author="agent-1")
cv.workspaces.destroy(workspace_id)
```

---

### Pattern 2: Multi-Agent Handoff

Agent A creates and populates a workspace. Agent B later pulls that workspace and continues from where A left off.

```
Agent A --> create --> checkout --> commit --> destroy
                                                  |
Agent B --> pull --> checkout --> commit --> destroy
```

**When to use:** Sequential handoffs. Agent A does research, Agent B acts on it.

**Key behavior:**
- `pull()` with no `version` returns HEAD (latest commit)
- Each commit is immutable -- Agent B always sees a complete snapshot
- Agent B's commits stack on top -- Agent A's history is preserved

```python
from contextvault import Client

cv = Client(api_key="cv_key_xxx")

# --- Agent A: create and populate ---
workspace = cv.workspaces.create(customer_id="cust_123", name="research")
cv.workspaces.checkout(workspace["id"])
# (Agent A writes research files into sandbox)
cv.workspaces.commit(workspace["id"], message="Research done", author="agent-a")
cv.workspaces.destroy(workspace["id"])

# --- Agent B: resume from Agent A's work ---
state = cv.workspaces.pull(workspace["id"])
# state["files"] contains all of Agent A's work

cv.workspaces.checkout(workspace["id"])
# (Agent B writes action files into sandbox)
cv.workspaces.commit(workspace["id"], message="Actions complete", author="agent-b")
cv.workspaces.destroy(workspace["id"])
```

---

### Pattern 3: Resumable Session

An agent works intermittently across multiple conversations. Each interaction saves state. The next interaction resumes from the last commit.

```
Interaction 1 --> checkout --> commit("in-progress") --> destroy
Interaction 2 --> pull --> checkout --> commit("in-progress") --> destroy
Interaction 3 --> pull --> checkout --> commit("done") --> destroy
```

**When to use:** Long-running tasks spanning multiple sessions. Chatbots, code assistants, research agents.

**Key behavior:**
- Each `commit()` creates a new version on top of the previous
- `pull()` (no version) always gets the latest state
- Tags let you track progress: `in-progress`, `review-needed`, `complete`

```python
from contextvault import Client, NotFoundError

cv = Client(api_key="cv_key_xxx")
workspace_id = "ws_01HXXXXXXXX"

def save_progress(files_written, status="in-progress"):
    """Save agent progress after each interaction."""
    cv.workspaces.commit(
        workspace_id,
        message=f"Session update ({status})",
        author="agent-1",
        tags=[status],
    )
    cv.workspaces.destroy(workspace_id)

def load_progress():
    """Load agent state from last interaction."""
    try:
        state = cv.workspaces.pull(workspace_id)
        return state["files"]
    except NotFoundError:
        return []  # First interaction, no prior state

# Each interaction:
files = load_progress()
# (agent works with restored context...)
cv.workspaces.checkout(workspace_id)
# (agent writes updated files into sandbox)
save_progress(files_written=True, status="in-progress")
```

---

### Pattern 4: Error Recovery

Agents encounter errors. Workspaces and sandboxes persist. Here are common recovery patterns.

#### Workspace not found

```python
from contextvault import Client, NotFoundError

cv = Client(api_key="cv_key_xxx")

try:
    state = cv.workspaces.pull(workspace_id)
except NotFoundError:
    workspace = cv.workspaces.create(
        customer_id="cust_123",
        name="my-workspace",
    )
    # New workspace, no files yet
```

#### Agent crashes mid-session

```python
from contextvault import Client, ContextVaultError

cv = Client(api_key="cv_key_xxx")

# On restart, try to commit any orphaned sandbox work
try:
    cv.workspaces.commit(
        workspace_id,
        message="Crash recovery",
        tags=["crash-recovery"],
    )
except ContextVaultError:
    # No sandbox or nothing to commit -- start fresh
    pass

# Destroy stale sandbox if it exists
try:
    cv.workspaces.destroy(workspace_id)
except ContextVaultError:
    pass  # No sandbox to destroy

# Now safe to checkout fresh
cv.workspaces.checkout(workspace_id)
```

#### Network failures

```python
from contextvault import Client, NetworkError

cv = Client(api_key="cv_key_xxx")

try:
    cv.workspaces.pull(workspace_id)
except NetworkError as e:
    # SDK already retried 3 times with exponential backoff
    print(f"ContextVault unreachable: {e.message}")
    # Fall back to cached state or alert operator
```

---

### Pattern 5: Workspace Per Conversation

Each conversation gets its own workspace. Clean separation, no cross-contamination.

```
Session 1 --> create --> checkout --> commit --> delete
Session 2 --> create --> checkout --> commit --> delete
```

**When to use:** Customer-facing chatbots, per-user memory, per-task workspaces.

```python
from contextvault import Client

cv = Client(api_key="cv_key_xxx")

def start_session(user_id, conversation_id):
    """Create an isolated workspace for this conversation."""
    workspace = cv.workspaces.create(
        customer_id=user_id,
        name=f"chat-{conversation_id}",
    )
    return workspace["id"]

def end_session(workspace_id):
    """Commit final state and clean up."""
    try:
        cv.workspaces.commit(workspace_id, tags=["complete"])
        cv.workspaces.destroy(workspace_id)
    except Exception:
        pass
    # Workspace is preserved for audit even after sandbox is gone
```

---

## Features

- Auto-retry with exponential backoff on network errors (max 3 retries)
- Typed exception hierarchy for clean error handling
- Full type hints for IDE support
- Minimal dependencies (only `requests`)

## Requirements

- Python 3.8+
- `requests` library
