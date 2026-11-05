import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("quickstart children receive private HOME and scoped credentials without inherited server authority", async () => {
  const module = process.env.CV_DOCS_HARNESS_FILE ?? new URL("../../scripts/verify-workspace-docs.mjs", import.meta.url).href;
  const { runQuickstart } = await import(module);
  const root = await mkdtemp(path.join(tmpdir(), "cv-docs-env-"));
  const names = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "CV_DATA_DIR", "CONTEXTVAULT_API_KEY"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "private-server-sentinel";
    await writeFile(path.join(root, "quickstart.md"), "```sh cv-check:isolated\nnode isolated.mjs\n```\n");
    await runQuickstart(root, { file: "quickstart.md", block: "isolated", display: "node isolated.mjs", command: [process.execPath, "-e", "const a=require('node:assert/strict');for(const n of ['AWS_ACCESS_KEY_ID','AWS_PROFILE','CV_DATA_DIR','CONTEXTVAULT_API_KEY'])a.equal(process.env[n],undefined);a.equal(process.env.HOME,process.cwd());a.equal(process.env.CV_API_KEY,'scoped-fixture-key');"] }, { environment: { CV_API_KEY: "scoped-fixture-key" } });
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
