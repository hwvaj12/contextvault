# LangChain + ContextVault — TypeScript

A LangChain agent that reads and writes files inside a ContextVault sandbox. The agent has no knowledge of ContextVault — it just sees a local filesystem. Your application code handles the sandbox lifecycle.

## Pattern

1. **Checkout** — create an ephemeral sandbox with a writable path
2. **Agent** — give LangChain filesystem tools scoped to that path
3. **Commit** — persist the agent's work back to ContextVault
4. **Destroy** — tear down the sandbox

## Prerequisites

```bash
npm install @contextvault/sdk langchain @langchain/openai @langchain/community
```

## Full Example

```typescript
import { ContextVaultClient } from '@contextvault/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
import {
  ReadFileTool,
  WriteFileTool,
  ListDirectoryTool,
} from '@langchain/community/tools/fs';
import { NodeFileStore } from 'langchain/stores/file/node';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  // ── 1. Create workspace & checkout sandbox ──────────────────────────
  const cv = new ContextVaultClient({
    apiKey: process.env.CONTEXTVAULT_API_KEY!,
    baseUrl: process.env.CONTEXTVAULT_URL ?? 'http://localhost:3000',
  });

  const workspace = await cv.workspaces.create({
    customerId: 'customer-123',
    name: 'langchain-session',
  });

  const sandbox = await cv.workspaces.checkout(workspace.id);
  console.log('Sandbox ready:', sandbox.path);

  // Seed the sandbox with starter files so the agent has something to work with
  fs.mkdirSync(path.join(sandbox.path, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox.path, 'docs', 'product-brief.md'),
    [
      '# Product Brief',
      '',
      '## Overview',
      'We are building an AI-powered code review tool.',
      '',
      '## Goals',
      '- Reduce review turnaround time by 50%',
      '- Catch common security issues automatically',
      '- Integrate with GitHub and GitLab',
      '',
    ].join('\n')
  );

  try {
    // ── 2. Build LangChain agent scoped to sandbox ──────────────────────
    //    The agent sees only the sandbox path — it knows nothing about
    //    ContextVault, workspaces, or commits.

    const store = new NodeFileStore(sandbox.path);
    const tools = [
      new ReadFileTool({ store }),
      new WriteFileTool({ store }),
      new ListDirectoryTool({ store }),
    ];

    const llm = new ChatOpenAI({
      modelName: 'gpt-4o',
      temperature: 0,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are a technical writer. You have access to a project directory.
Read the existing docs, then create additional documentation files that
would complement them. Write clean, professional Markdown.`,
      ],
      ['human', '{input}'],
      ['placeholder', '{agent_scratchpad}'],
    ]);

    const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
    const executor = new AgentExecutor({ agent, tools, verbose: true });

    // ── 3. Run the agent ────────────────────────────────────────────────
    await executor.invoke({
      input: [
        'List the docs/ directory, read the product brief, then create:',
        '1. docs/architecture.md — a proposed system architecture',
        '2. docs/roadmap.md — a phased delivery roadmap',
      ].join('\n'),
    });

    // ── 4. Commit the agent's work ──────────────────────────────────────
    const commit = await cv.workspaces.commit(workspace.id, {
      message: 'LangChain agent: generated architecture and roadmap docs',
      author: 'langchain-agent',
      agentId: 'lc-writer-v1',
      taskId: 'doc-generation',
      tags: ['langchain', 'auto-generated'],
    });
    console.log('Committed:', commit.commitId);

    // Verify what was saved
    const result = await cv.workspaces.pull(workspace.id);
    console.log('\nFiles in workspace:');
    for (const file of result.files) {
      console.log(`  ${file.path} (${file.content.length} bytes)`);
    }
  } finally {
    // ── 5. Always destroy the sandbox ─────────────────────────────────
    await cv.workspaces.destroy(workspace.id);
    console.log('Sandbox destroyed');
  }
}

main().catch(console.error);
```

## Multi-Turn Conversation

If the agent needs to iterate across multiple user turns, keep the sandbox alive and commit after each turn:

```typescript
async function conversationLoop(
  cv: ContextVaultClient,
  workspaceId: string,
  executor: AgentExecutor,
  userMessages: string[]
) {
  for (const message of userMessages) {
    console.log(`\nUser: ${message}`);
    const result = await executor.invoke({ input: message });
    console.log(`Agent: ${result.output}`);

    // Commit after each turn so progress is never lost
    await cv.workspaces.commit(workspaceId, {
      message: `Turn: ${message.slice(0, 60)}`,
      author: 'langchain-agent',
      tags: ['conversation-turn'],
    });
  }
}
```

## Resuming a Previous Session

Pull files from an existing workspace into a fresh sandbox to continue where the agent left off:

```typescript
async function resumeSession(cv: ContextVaultClient, workspaceId: string) {
  // Checkout creates a new sandbox populated with the latest committed files
  const sandbox = await cv.workspaces.checkout(workspaceId);
  console.log('Resumed at:', sandbox.path);

  // The sandbox already contains files from the previous commit —
  // hand it to a new LangChain agent and keep working.
  return sandbox;
}
```

## Run It

```bash
export CONTEXTVAULT_API_KEY="cv-..."
export OPENAI_API_KEY="sk-..."
npx ts-node example.ts
```
