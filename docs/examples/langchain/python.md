# LangChain + ContextVault — Python

A LangChain agent that reads and writes files inside a ContextVault sandbox. The agent has no knowledge of ContextVault — it just sees a local filesystem. Your application code handles the sandbox lifecycle.

## Pattern

1. **Checkout** — create an ephemeral sandbox with a writable path
2. **Agent** — give LangChain filesystem tools scoped to that path
3. **Commit** — persist the agent's work back to ContextVault
4. **Destroy** — tear down the sandbox

## Prerequisites

```bash
pip install contextvault langchain langchain-openai
```

## Full Example

```python
import os
from contextvault import Client
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_openai_functions_agent
from langchain_community.tools.file_management import (
    ReadFileTool,
    WriteFileTool,
    ListDirectoryTool,
)
from langchain_core.prompts import ChatPromptTemplate


def main():
    # ── 1. Create workspace & checkout sandbox ──────────────────────────
    cv = Client(
        api_key=os.environ["CONTEXTVAULT_API_KEY"],
        base_url=os.environ.get("CONTEXTVAULT_URL", "http://localhost:3000"),
    )

    workspace = cv.workspaces.create(
        customer_id="customer-123",
        name="langchain-session",
    )
    workspace_id = workspace["id"]

    sandbox = cv.workspaces.checkout(workspace_id)
    sandbox_path = sandbox["path"]
    print(f"Sandbox ready: {sandbox_path}")

    # Seed the sandbox with starter files so the agent has something to work with
    docs_dir = os.path.join(sandbox_path, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    with open(os.path.join(docs_dir, "product-brief.md"), "w") as f:
        f.write(
            "# Product Brief\n"
            "\n"
            "## Overview\n"
            "We are building an AI-powered code review tool.\n"
            "\n"
            "## Goals\n"
            "- Reduce review turnaround time by 50%\n"
            "- Catch common security issues automatically\n"
            "- Integrate with GitHub and GitLab\n"
        )

    try:
        # ── 2. Build LangChain agent scoped to sandbox ──────────────────
        #    The agent sees only the sandbox path — it knows nothing about
        #    ContextVault, workspaces, or commits.

        tools = [
            ReadFileTool(root_dir=sandbox_path),
            WriteFileTool(root_dir=sandbox_path),
            ListDirectoryTool(root_dir=sandbox_path),
        ]

        llm = ChatOpenAI(model="gpt-4o", temperature=0)

        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a technical writer. You have access to a project directory.\n"
                    "Read the existing docs, then create additional documentation files that\n"
                    "would complement them. Write clean, professional Markdown.",
                ),
                ("human", "{input}"),
                ("placeholder", "{agent_scratchpad}"),
            ]
        )

        agent = create_openai_functions_agent(llm=llm, tools=tools, prompt=prompt)
        executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

        # ── 3. Run the agent ────────────────────────────────────────────
        executor.invoke(
            {
                "input": (
                    "List the docs/ directory, read the product brief, then create:\n"
                    "1. docs/architecture.md — a proposed system architecture\n"
                    "2. docs/roadmap.md — a phased delivery roadmap"
                )
            }
        )

        # ── 4. Commit the agent's work ──────────────────────────────────
        commit = cv.workspaces.commit(
            workspace_id=workspace_id,
            message="LangChain agent: generated architecture and roadmap docs",
            author="langchain-agent",
        )
        print(f"Committed: {commit['commitId']}")

        # Verify what was saved
        result = cv.workspaces.pull(workspace_id)
        print("\nFiles in workspace:")
        for f in result["files"]:
            print(f"  {f['path']} ({len(f['content'])} bytes)")

    finally:
        # ── 5. Always destroy the sandbox ───────────────────────────────
        cv.workspaces.destroy(workspace_id)
        print("Sandbox destroyed")


if __name__ == "__main__":
    main()
```

## Multi-Turn Conversation

If the agent needs to iterate across multiple user turns, keep the sandbox alive and commit after each turn:

```python
def conversation_loop(
    cv: Client,
    workspace_id: str,
    executor: AgentExecutor,
    user_messages: list[str],
):
    for message in user_messages:
        print(f"\nUser: {message}")
        result = executor.invoke({"input": message})
        print(f"Agent: {result['output']}")

        # Commit after each turn so progress is never lost
        cv.workspaces.commit(
            workspace_id=workspace_id,
            message=f"Turn: {message[:60]}",
            author="langchain-agent",
        )
```

## Resuming a Previous Session

Pull files from an existing workspace into a fresh sandbox to continue where the agent left off:

```python
def resume_session(cv: Client, workspace_id: str) -> dict:
    # Checkout creates a new sandbox populated with the latest committed files
    sandbox = cv.workspaces.checkout(workspace_id)
    print(f"Resumed at: {sandbox['path']}")

    # The sandbox already contains files from the previous commit —
    # hand it to a new LangChain agent and keep working.
    return sandbox
```

## Run It

```bash
export CONTEXTVAULT_API_KEY="cv-..."
export OPENAI_API_KEY="sk-..."
python example.py
```
