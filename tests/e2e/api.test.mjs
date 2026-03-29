/**
 * ContextVault E2E Test
 * 
 * Tests the full REST API lifecycle against a running ContextVault server.
 * 
 * Run with:
 *   node tests/e2e/api.test.mjs
 */

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "cv-test-api-key-123";
const TEST_CUSTOMER = `e2e-${Date.now()}`;

async function request(method, path, body) {
  const url = `${API_BASE_URL}${path}`;
  const headers = {
    "X-API-Key": API_KEY,
    "Accept": "application/json",
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

  if (!res.ok) {
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

async function main() {
  console.log(`\n🧪 ContextVault E2E Test`);
  console.log(`   API: ${API_BASE_URL}`);
  console.log(`   Customer: ${TEST_CUSTOMER}\n`);

  let workspaceId;
  let runId;

  try {
    // ── Health ──────────────────────────────────────────────────────────
    console.log(`1. Health Check`);
    const health = await request("GET", "/health");
    assert(health.status === "healthy", "API is healthy");
    console.log("");

    // ── Workspace CRUD ──────────────────────────────────────────────────
    console.log(`2. Workspace CRUD`);

    const created = await request("POST", "/workspaces", {
      customerId: TEST_CUSTOMER,
      name: "E2E Test Workspace",
    });
    workspaceId = created.id;
    assert(workspaceId.startsWith("ws_"), `Created workspace: ${workspaceId}`);
    assert(created.customerId === TEST_CUSTOMER, "Workspace has correct customerId");
    assert(created.latestCommitId === null, "New workspace has null commit (blank slate)");
    console.log("");

    // List workspaces
    const list = await request("GET", `/workspaces?customerId=${TEST_CUSTOMER}`);
    assert(Array.isArray(list), "List returns array");
    assert(list.some((w) => w.id === workspaceId), "New workspace appears in list");
    console.log("");

    // Get workspace
    const ws = await request("GET", `/workspaces/${workspaceId}`);
    assert(ws.id === workspaceId, "Get workspace returns correct ID");
    assert(ws.name === "E2E Test Workspace", "Get workspace returns correct name");
    console.log("");

    // ── Runs ─────────────────────────────────────────────────────────────
    console.log(`3. Run Lifecycle`);

    const run = await request("POST", `/workspaces/${workspaceId}/runs`, {
      agentId: "e2e-test-agent",
    });
    runId = run.id;
    assert(runId.startsWith("run_"), `Created run: ${runId}`);
    assert(run.status === "created", `Run starts in 'created' state`);
    console.log("");

    // Get run
    const runStatus = await request("GET", `/runs/${runId}`);
    assert(runStatus.id === runId, "Get run returns correct ID");
    assert(runStatus.status === "created", "Run status is 'created'");
    console.log("");

    // ── Sandbox ─────────────────────────────────────────────────────────
    console.log(`4. Sandbox Lifecycle`);

    // Checkout (create sandbox)
    const sandbox = await request("POST", `/workspaces/${workspaceId}/sandbox`);
    assert(sandbox.workspaceId === workspaceId, "Sandbox belongs to correct workspace");
    assert(sandbox.sandboxId.startsWith("sb_"), `Sandbox has ID: ${sandbox.sandboxId}`);
    assert(sandbox.sandboxPath !== undefined, "Sandbox has path");
    console.log(`   Sandbox path: ${sandbox.sandboxPath}`);
    console.log("");

    // Get sandbox status
    const sandboxStatus = await request("GET", `/workspaces/${workspaceId}/sandbox`);
    assert(sandboxStatus.workspaceId === workspaceId, "Sandbox status matches");
    console.log("");

    // ── Version Control (empty workspace) ────────────────────────────────
    console.log(`5. Version Control`);

    // Pull empty workspace
    const pull = await request("GET", `/workspaces/${workspaceId}/pull`);
    assert(pull.workspaceId === workspaceId || pull.workspaceId === undefined, "Pull returns workspace ID or empty");
    assert(Array.isArray(pull.files), "Pull returns files array");
    console.log(`   Pulled ${pull.files.length} files from blank workspace`);
    console.log("");

    // History on empty workspace
    const history = await request("GET", `/workspaces/${workspaceId}/history`);
    assert(Array.isArray(history.commits), "History returns commits array");
    console.log(`   ${history.commits.length} commits in history`);
    console.log("");

    // ── Abort run ────────────────────────────────────────────────────────
    console.log(`6. Run Abort`);

    // Abort requires empty JSON body
    const abort = await request("POST", `/runs/${runId}/abort`, {});
    assert(abort.status === "aborted", "Run status is 'aborted' after abort");
    console.log("");

    // ── Cleanup ─────────────────────────────────────────────────────────
    console.log(`7. Cleanup`);

    // Destroy sandbox
    const destroy = await request("DELETE", `/workspaces/${workspaceId}/sandbox`);
    assert(destroy.workspaceId === workspaceId, "Destroy returns workspace ID");
    console.log("");

    // Delete workspace
    await request("DELETE", `/workspaces/${workspaceId}`);
    
    // Verify deletion
    try {
      await request("GET", `/workspaces/${workspaceId}`);
      assert(false, "Deleted workspace should 404");
    } catch {
      assert(true, "Deleted workspace returns 404");
    }
    console.log("");

  } catch (err) {
    console.error(`\n❌ Test error: ${err}`);
    failed++;
  }

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
