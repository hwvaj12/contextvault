/**
 * ContextVault Webhook E2E Test
 *
 * Tests webhook registration, listing, deletion, and delivery
 * against a running ContextVault server.
 *
 * Run with:
 *   node tests/e2e/webhooks.test.mjs
 */

import http from "node:http";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "cv-test-api-key-123";
const TEST_CUSTOMER = `wh-e2e-${Date.now()}`;

// A simple HTTP server to receive webhook callbacks
let receivedWebhooks = [];
let webhookServer;
let webhookPort;

async function startWebhookReceiver() {
  return new Promise((resolve) => {
    webhookServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedWebhooks.push({
          headers: req.headers,
          body: JSON.parse(body),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    webhookServer.listen(0, "127.0.0.1", () => {
      webhookPort = webhookServer.address().port;
      resolve();
    });
  });
}

function stopWebhookReceiver() {
  return new Promise((resolve) => {
    if (webhookServer) webhookServer.close(resolve);
    else resolve();
  });
}

async function request(method, path, body) {
  const url = `${API_BASE_URL}${path}`;
  const headers = {
    "X-API-Key": API_KEY,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok && res.status !== 204) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function waitForWebhook(eventType, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = receivedWebhooks.find((w) => w.body.event === eventType);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  console.log(`\n🧪 ContextVault Webhook E2E Test`);
  console.log(`   API: ${API_BASE_URL}`);
  console.log(`   Customer: ${TEST_CUSTOMER}\n`);

  await startWebhookReceiver();
  console.log(`   Webhook receiver on port ${webhookPort}\n`);

  const webhookUrl = `http://127.0.0.1:${webhookPort}/hooks`;

  try {
    // ── Register webhook ─────────────────────────────────────────────
    console.log("1. Register Webhook");

    const wh = await request("POST", "/webhooks", {
      customerId: TEST_CUSTOMER,
      url: webhookUrl,
      events: ["workspace.created", "workspace.deleted", "commit.created"],
      secret: "my-test-secret",
    });
    assert(wh.id.startsWith("wh_"), `Created webhook: ${wh.id}`);
    assert(wh.url === webhookUrl, "Webhook URL matches");
    assert(wh.events.length === 3, "Webhook has 3 subscribed events");
    assert(wh.active === true, "Webhook is active");
    console.log("");

    // ── List webhooks ────────────────────────────────────────────────
    console.log("2. List Webhooks");

    const list = await request("GET", `/webhooks?customerId=${TEST_CUSTOMER}`);
    assert(Array.isArray(list.data), "List returns data array");
    assert(list.data.length === 1, "List has 1 webhook");
    assert(list.data[0].id === wh.id, "Listed webhook matches created one");
    console.log("");

    // ── Trigger workspace.created event ──────────────────────────────
    console.log("3. Trigger workspace.created");

    const ws = await request("POST", "/workspaces", {
      customerId: TEST_CUSTOMER,
      name: "Webhook Test Workspace",
    });
    assert(ws.id.startsWith("ws_"), `Created workspace: ${ws.id}`);

    // Wait for webhook delivery
    const createdHook = await waitForWebhook("workspace.created");
    assert(createdHook !== null, "Received workspace.created webhook");
    if (createdHook) {
      assert(
        createdHook.body.payload.workspaceId === ws.id,
        "Webhook payload has correct workspaceId"
      );
      assert(
        createdHook.headers["x-contextvault-event"] === "workspace.created",
        "Webhook has X-ContextVault-Event header"
      );
      assert(
        typeof createdHook.headers["x-contextvault-signature"] === "string",
        "Webhook has HMAC signature header"
      );
    }
    console.log("");

    // ── Trigger commit.created event ─────────────────────────────────
    console.log("4. Trigger commit.created");

    const push = await request("POST", `/workspaces/${ws.id}/push`, {
      files: [{ path: "test.txt", content: "hello webhooks" }],
    });
    assert(typeof push.commitId === "string", `Push created commit: ${push.commitId.slice(0, 8)}...`);

    const commitHook = await waitForWebhook("commit.created");
    assert(commitHook !== null, "Received commit.created webhook");
    if (commitHook) {
      assert(
        commitHook.body.payload.workspaceId === ws.id,
        "Commit webhook has correct workspaceId"
      );
    }
    console.log("");

    // ── Trigger workspace.deleted event ──────────────────────────────
    console.log("5. Trigger workspace.deleted");

    receivedWebhooks = []; // reset to catch only delete
    await request("DELETE", `/workspaces/${ws.id}`);

    const deletedHook = await waitForWebhook("workspace.deleted");
    assert(deletedHook !== null, "Received workspace.deleted webhook");
    if (deletedHook) {
      assert(
        deletedHook.body.payload.workspaceId === ws.id,
        "Delete webhook has correct workspaceId"
      );
    }
    console.log("");

    // ── Delete webhook ───────────────────────────────────────────────
    console.log("6. Delete Webhook");

    await fetch(`${API_BASE_URL}/webhooks/${wh.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });

    const listAfter = await request(
      "GET",
      `/webhooks?customerId=${TEST_CUSTOMER}`
    );
    assert(listAfter.data.length === 0, "Webhook deleted successfully");
    console.log("");
  } catch (err) {
    console.error(`\n❌ Test error: ${err}`);
    failed++;
  }

  await stopWebhookReceiver();

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("─".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
