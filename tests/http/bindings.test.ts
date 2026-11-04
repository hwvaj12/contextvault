import { expect, it } from "vitest";
import { mkdir, symlink, realpath, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfiguration } from "../../src/config";
import { create, finalize, fixture, json, open, submit } from "./helpers";

const retained = (profile: any) => { const { configurationRef, storeId, ...physical } = profile; return physical; };

it("resolves revision and staging stores from persisted bindings after a default switch and restart", async () => {
  const context = await fixture(); const key = await context.key(); const originalConfiguration = loadConfiguration(context.env);
  const workspace = await create(context, key); const run = await open(context, workspace.id, key);
  const submission = await submit(context, run, key, { "original.bin": Buffer.from([0, 255]) });
  await context.stop();
  const isS3 = process.env.CV_TEST_BACKEND === "s3";
  await context.start(isS3 ? { CV_STORAGE_BACKEND: "git" } : { CV_GIT_ROOT: join(context.directory, "second-git"), CV_SUBMISSION_ROOT: join(context.directory, "second-staging"), CV_STORAGE_PROFILES: JSON.stringify(originalConfiguration.profiles.map(retained)) });
  const later = await create(context, key); const laterRun = await open(context, later.id, key);
  const laterSubmission = await submit(context, laterRun, key, { "later.bin": Buffer.from([128, 0]) });
  expect((await finalize(context, laterRun, key, laterSubmission.id)).state).toBe("succeeded");
  expect((await finalize(context, run, key, submission.id)).state).toBe("succeeded");
  await context.stop(); await context.start();
  for (const [id, name, expected] of [[workspace.id, "original.bin", Buffer.from([0, 255])], [later.id, "later.bin", Buffer.from([128, 0])]] as const) {
    const read = await open(context, id, key, "read-only"); const response = await context.request("GET", `/v1/runs/${read.id}/workspace/files?path=${name}`, undefined, key); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
  }
});

it("refuses to retarget accepted bindings when their original physical configuration is absent", async () => {
  const context = await fixture(); const key = await context.key(); const original = loadConfiguration(context.env);
  const workspace = await create(context, key); const run = await open(context, workspace.id, key, "read-only"); await context.stop();
  const changed = process.env.CV_TEST_BACKEND === "s3" ? { CV_S3_PREFIX: `${context.env.CV_S3_PREFIX}new-default/` } : { CV_GIT_ROOT: join(context.directory, "new-default") };
  await context.start(changed);
  expect((await context.request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, key)).status).toBe(503);
  await context.stop(); await context.start({ CV_STORAGE_PROFILES: JSON.stringify(original.profiles.map(retained)) });
  expect((await json(await context.request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, key), 200)).entries).toEqual([]);
});

it("starts and publishes with a restricted inherited command search path", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-http-tools-")); const bin = join(directory, "bin"); await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  if (process.env.CV_TEST_BACKEND !== "s3") await symlink("/usr/bin/git", join(bin, "git"));
  try {
    const context = await fixture({ PATH: bin }); const key = await context.key(); const workspace = await create(context, key); const run = await open(context, workspace.id, key);
    const submission = await submit(context, run, key, { "selected.bin": Buffer.from([0, 255]) }); expect((await finalize(context, run, key, submission.id)).state).toBe("succeeded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
