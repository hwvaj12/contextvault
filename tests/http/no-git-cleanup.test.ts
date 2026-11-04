import { afterEach, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function responder(respond: (url: string, response: ServerResponse) => void) {
  const server = createServer((request, response) => respond(request.url!, response)); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
}
const owned = () => {
  const id = randomUUID();
  return { bucket: "contextvault-fixture-owned", prefix: `contextvault-tests/cleanup-fixture/no-git-${id}/`, name: `cv-no-git-${id}` };
};
async function cleanup(options: Record<string, unknown>) {
  const { cleanupNoGitFixture } = await import("./no-git-server.mjs");
  return cleanupNoGitFixture(options);
}

it("aborts a stalled owned S3 cleanup request within one shared deadline", async () => {
  const client = await responder(() => {}); const started = Date.now();
  try { await expect(cleanup({ ...owned(), client, timeoutMs: 150 })).rejects.toThrow(/cleanup.*timed out/i); }
  finally { client.destroy(); }
  expect(Date.now() - started).toBeLessThan(1500);
});

it("rejects a repeating S3 page without an unbounded cleanup loop", async () => {
  let requests = 0; const target = owned();
  const client = await responder((_url, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${target.bucket}</Bucket><IsTruncated>true</IsTruncated><NextKeyMarker>${target.prefix}repeat</NextKeyMarker><NextUploadIdMarker>repeat</NextUploadIdMarker></ListMultipartUploadsResult>`);
  });
  try { await expect(cleanup({ ...target, client, timeoutMs: 1000 })).rejects.toThrow(/did not advance/i); }
  finally { client.destroy(); }
  expect(requests).toBe(2);
});

it("refuses a foreign key before sending a destructive cleanup request", async () => {
  let requests = 0; const target = owned();
  const client = await responder((url, response) => {
    requests++; response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(url.includes("uploads") ? "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>" : "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>foreign/canary</Key></Contents></ListBucketResult>");
  });
  try { await expect(cleanup({ ...target, client, timeoutMs: 1000 })).rejects.toThrow(/owned prefix/i); }
  finally { client.destroy(); }
  expect(requests).toBe(2);
});

it("bounds container removal within the shared cleanup deadline", async () => {
  let requests = 0; const calls: unknown[][] = [];
  const client = await responder((url, response) => {
    requests++; response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(url.includes("uploads") ? "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>" : "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  });
  const started = Date.now();
  try {
    await expect(cleanup({ ...owned(), client, created: true, timeoutMs: 200, docker: (...args: unknown[]) => { calls.push(args); return new Promise(() => {}); } })).rejects.toThrow(/container.*timed out/i);
  } finally { client.destroy(); }
  expect(Date.now() - started).toBeLessThan(1500);
  expect(calls).toHaveLength(1);
  expect(requests).toBe(0);
});
