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

    // List workspaces (now returns paginated { data, pagination })
    const list = await request("GET", `/workspaces?customerId=${TEST_CUSTOMER}`);
    assert(Array.isArray(list.data), "List returns paginated response with data array");
    assert(list.data.some((w) => w.id === workspaceId), "New workspace appears in list");
    assert(typeof list.pagination === "object", "List returns pagination metadata");
    console.log(`   Pagination: total=${list.pagination.total}, hasMore=${list.pagination.hasMore}`);
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
    assert(Array.isArray(pull.files), "Pull returns files array");
    console.log(`   Pulled ${pull.files.length} files from blank workspace`);
    console.log("");

    // History on empty workspace
    const history = await request("GET", `/workspaces/${workspaceId}/history`);
    assert(Array.isArray(history.commits), "History returns commits array");
    console.log(`   ${history.commits.length} commits in history`);
    console.log("");

    // ── File Diffing ──────────────────────────────────────────────────────
    console.log(`6. File Diffing`);

    // Create a fresh workspace for diff testing
    const diffWs = await request("POST", "/workspaces", {
      customerId: TEST_CUSTOMER,
      name: "E2E Diff Workspace",
    });
    const diffWsId = diffWs.id;

    // Push v1
    const push1 = await request("POST", `/workspaces/${diffWsId}/push`, {
      files: [
        { path: "readme.md", content: "# Hello v1\n" },
        { path: "config.json", content: '{"v":1}' },
      ],
    });
    const commit1 = push1.commitId;
    assert(typeof commit1 === "string" && commit1.length > 0, `Push v1 created commit: ${commit1.slice(0, 8)}...`);

    // Push v2 (modify readme, add notes.txt, config.json removed implicitly)
    const push2 = await request("POST", `/workspaces/${diffWsId}/push`, {
      files: [
        { path: "readme.md", content: "# Hello v2\nUpdated.\n" },
        { path: "notes.txt", content: "new file\n" },
      ],
    });
    const commit2 = push2.commitId;
    assert(typeof commit2 === "string" && commit2.length > 0, `Push v2 created commit: ${commit2.slice(0, 8)}...`);

    // Get diff
    const diff = await request("GET", `/workspaces/${diffWsId}/diff?from=${commit1}&to=${commit2}`);
    assert(diff.from === commit1, "Diff has correct 'from' commit");
    assert(diff.to === commit2, "Diff has correct 'to' commit");
    assert(Array.isArray(diff.files), "Diff returns files array");
    assert(diff.files.length === 3, `Diff has 3 changed files (got ${diff.files.length})`);

    // Verify structured file entries
    const byPath = {};
    for (const f of diff.files) byPath[f.path] = f;

    assert(byPath["config.json"]?.status === "removed", "config.json is removed");
    assert(byPath["notes.txt"]?.status === "added", "notes.txt is added");
    assert(byPath["readme.md"]?.status === "modified", "readme.md is modified");

    assert(typeof byPath["readme.md"]?.additions === "number", "readme.md has additions count");
    assert(typeof byPath["readme.md"]?.deletions === "number", "readme.md has deletions count");
    assert(Array.isArray(byPath["readme.md"]?.hunks), "readme.md has hunks array");
    assert(byPath["readme.md"].hunks.length > 0, "readme.md has at least one hunk");
    assert(typeof byPath["readme.md"].hunks[0].oldStart === "number", "Hunk has oldStart");
    assert(typeof byPath["readme.md"].hunks[0].content === "string", "Hunk has content");

    // Verify summary
    assert(typeof diff.summary === "object", "Diff has summary object");
    assert(diff.summary.filesChanged === 3, `Summary shows 3 files changed (got ${diff.summary.filesChanged})`);
    assert(diff.summary.additions > 0, "Summary shows additions > 0");
    assert(diff.summary.deletions > 0, "Summary shows deletions > 0");

    // Cleanup diff workspace
    await request("DELETE", `/workspaces/${diffWsId}`);
    console.log("");

    // ── Workspace Clone ──────────────────────────────────────────────────
    console.log(`7. Workspace Clone`);

    // Create a workspace with content
    const cloneSrcWs = await request("POST", "/workspaces", {
      customerId: TEST_CUSTOMER,
      name: "Clone Source Workspace",
    });
    const cloneSrcId = cloneSrcWs.id;

    // Push some content to the source workspace
    const clonePush = await request("POST", `/workspaces/${cloneSrcId}/push`, {
      files: [
        { path: "profile.json", content: '{"athlete":"Jordan","sport":"basketball"}' },
        { path: "notes.md", content: "# Training Notes\nDay 1 complete.\n" },
      ],
    });
    assert(typeof clonePush.commitId === "string", `Source has commit: ${clonePush.commitId.slice(0, 8)}...`);

    // Clone to a new customer
    const cloneTargetCustomer = `${TEST_CUSTOMER}-clone`;
    const cloned = await request("POST", `/workspaces/${cloneSrcId}/clone`, {
      targetCustomerId: cloneTargetCustomer,
      name: "Cloned Athlete Profile",
    });
    assert(cloned.id.startsWith("ws_"), `Cloned workspace: ${cloned.id}`);
    assert(cloned.customerId === cloneTargetCustomer, "Clone has correct customerId");
    assert(cloned.name === "Cloned Athlete Profile", "Clone has correct name");

    // Pull both and verify content matches
    const srcPull = await request("GET", `/workspaces/${cloneSrcId}/pull`);
    const clonePull = await request("GET", `/workspaces/${cloned.id}/pull`);

    assert(srcPull.files.length === clonePull.files.length, `Both have ${srcPull.files.length} files`);

    const srcFiles = {};
    for (const f of srcPull.files) srcFiles[f.path] = f.content;
    const cloneFiles = {};
    for (const f of clonePull.files) cloneFiles[f.path] = f.content;

    assert(srcFiles["profile.json"] === cloneFiles["profile.json"], "profile.json content matches");
    assert(srcFiles["notes.md"] === cloneFiles["notes.md"], "notes.md content matches");

    // Cleanup clone workspaces
    await request("DELETE", `/workspaces/${cloneSrcId}`);
    await request("DELETE", `/workspaces/${cloned.id}`);
    console.log("");

    // ── Abort run ────────────────────────────────────────────────────────
    console.log(`8. Run Abort`);

    // Abort requires empty JSON body
    const abort = await request("POST", `/runs/${runId}/abort`, {});
    assert(abort.status === "aborted", "Run status is 'aborted' after abort");
    console.log("");

    // ── Cleanup ─────────────────────────────────────────────────────────
    console.log(`9. Cleanup`);

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

    // ── Multi-tenant Isolation ──────────────────────────────────────────
    console.log(`10. Multi-tenant Isolation`);

    // Create API keys for two different customers
    const customerA = `tenant-a-${Date.now()}`;
    const customerB = `tenant-b-${Date.now()}`;

    const keyA = await request("POST", "/api-keys", { customerId: customerA, name: "Key A" });
    assert(typeof keyA.plainKey === "string" && keyA.plainKey.startsWith("cvk_"), `Created API key for customer A: ${keyA.id}`);
    assert(keyA.customerId === customerA, "Key A belongs to customer A");

    const keyB = await request("POST", "/api-keys", { customerId: customerB, name: "Key B" });
    assert(typeof keyB.plainKey === "string" && keyB.plainKey.startsWith("cvk_"), `Created API key for customer B: ${keyB.id}`);
    assert(keyB.customerId === customerB, "Key B belongs to customer B");

    // Helper: make requests with a specific tenant key
    async function tenantRequest(method, path, body, tenantKey) {
      const url = `${API_BASE_URL}${path}`;
      const headers = {
        "X-API-Key": tenantKey,
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
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, ok: res.ok, data };
    }

    // Customer A creates a workspace using their scoped key
    const wsA = await tenantRequest("POST", "/workspaces", { customerId: customerA, name: "Tenant A Workspace" }, keyA.plainKey);
    assert(wsA.ok && wsA.data.id, `Customer A created workspace: ${wsA.data.id}`);
    const wsAId = wsA.data.id;

    // Customer B creates a workspace using their scoped key
    const wsB = await tenantRequest("POST", "/workspaces", { customerId: customerB, name: "Tenant B Workspace" }, keyB.plainKey);
    assert(wsB.ok && wsB.data.id, `Customer B created workspace: ${wsB.data.id}`);
    const wsBId = wsB.data.id;

    // Customer A lists workspaces — should only see their own
    const listA = await tenantRequest("GET", "/workspaces", undefined, keyA.plainKey);
    assert(listA.ok, "Customer A can list workspaces");
    assert(listA.data.data.some(w => w.id === wsAId), "Customer A sees their own workspace");
    assert(!listA.data.data.some(w => w.id === wsBId), "Customer A does NOT see Customer B's workspace");

    // Customer B lists workspaces — should only see their own
    const listB = await tenantRequest("GET", "/workspaces", undefined, keyB.plainKey);
    assert(listB.ok, "Customer B can list workspaces");
    assert(listB.data.data.some(w => w.id === wsBId), "Customer B sees their own workspace");
    assert(!listB.data.data.some(w => w.id === wsAId), "Customer B does NOT see Customer A's workspace");

    // Customer A tries to get Customer B's workspace — should 404
    const crossGet = await tenantRequest("GET", `/workspaces/${wsBId}`, undefined, keyA.plainKey);
    assert(crossGet.status === 404, "Customer A cannot access Customer B's workspace (404)");

    // Customer A tries to delete Customer B's workspace — should 404
    const crossDelete = await tenantRequest("DELETE", `/workspaces/${wsBId}`, undefined, keyA.plainKey);
    assert(crossDelete.status === 404, "Customer A cannot delete Customer B's workspace (404)");

    // Customer A cannot create workspace for Customer B
    const crossCreate = await tenantRequest("POST", "/workspaces", { customerId: customerB, name: "Sneaky" }, keyA.plainKey);
    assert(crossCreate.status === 403, "Customer A cannot create workspace for Customer B (403)");

    // List API keys (via scoped key)
    const keysA = await tenantRequest("GET", "/api-keys", undefined, keyA.plainKey);
    assert(keysA.ok && keysA.data.data.length >= 1, "Customer A can list their API keys");

    // Cleanup: use admin key to delete test workspaces
    await request("POST", "/workspaces/bulk-delete", { workspaceIds: [wsAId, wsBId] });

    // Revoke keys
    await request("DELETE", `/api-keys/${keyA.id}`);
    await request("DELETE", `/api-keys/${keyB.id}`);
    assert(true, "Cleaned up tenant test data");
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
