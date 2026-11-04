import type { FastifyInstance, FastifyRequest, FastifyReply, FastifySchema } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { canonicalJson, canonicalizeManifest, validatePortablePath, verifyFileStream, WorkspaceError, type Principal, type Run, type RunScope, type WorkspaceScope, type CustomerScope, type OperationId, type RunId, type SubmissionId } from "../../domain";
import { StreamLimiter } from "../../application/files";
import type { ResourceLookupContext } from "../../ports/control-store";
import type { WorkspaceRuntime } from "../../config/runtime";
import { operationView, receiptView, runView, submissionView, workspaceView } from "./views";

const text = z.string().min(1).max(255);
const version = z.number().int().positive();
const createSchema = z.object({ customerId: text, name: text }).strict();
const openSchema = z.object({ mode: z.enum(["read-only", "read-write"]), agentLabel: z.string().min(1).max(4096), task: z.string().min(1).max(4096), reason: z.string().min(1).max(4096) }).strict();
const finalizeSchema = z.object({ expectedRunVersion: version, submissionId: text.optional() }).strict();
const abortSchema = z.object({ expectedRunVersion: version, reason: z.string().min(1).max(4096) }).strict();
const heartbeatSchema = z.object({ expectedLeaseVersion: version }).strict();
const sealSchema = z.object({ manifest: z.unknown(), receipts: z.array(z.object({ path: z.string(), receiptId: text }).strict()) }).strict();
const emptySchema = z.object({}).strict();
const pathSchema = z.object({ path: z.string() }).strict();
const tag = { schema: { tags: ["Workspace lifecycle"] } };

/** Documentation-only conversion leaves strict handler validation and streaming parsers authoritative. */
export function documentV1Schema(schema: FastifySchema, url: string, methods: string | string[]): FastifySchema {
  if (!url.startsWith("/v1/")) return schema;
  const method = Array.isArray(methods) ? methods[0] : methods;
  const bodies: Record<string, z.ZodType> = { "POST /v1/workspaces": createSchema, "POST /v1/workspaces/:id/runs": openSchema,
    "POST /v1/runs/:id/submissions": emptySchema, "POST /v1/runs/:id/submissions/:sid/seal": sealSchema,
    "POST /v1/runs/:id/finalize": finalizeSchema, "POST /v1/runs/:id/abort": abortSchema, "POST /v1/runs/:id/heartbeat": heartbeatSchema };
  const result = { ...schema };
  const body = bodies[`${method} ${url}`];
  if (body) { const { $schema, ...json } = z.toJSONSchema(body, { target: "draft-7" }); result.body = json; }
  if (["POST", "PUT"].includes(method)) result.headers = { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 256 } } };
  if (url.endsWith("/files")) {
    result.querystring = { type: "object", required: ["path"], properties: { path: { type: "string" } } };
    if (method === "PUT") { result.body = { type: "string", format: "binary" }; result.consumes = ["application/octet-stream"]; result.headers = { type: "object", required: ["idempotency-key", "x-content-sha256"], properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 256 }, "x-content-sha256": { type: "string", pattern: "^[a-f0-9]{64}$" }, "content-length": { type: "string", pattern: "^(0|[1-9][0-9]*)$" } } }; }
  }
  return result;
}

function principal(request: FastifyRequest): Principal {
  if (!request.principal) throw new WorkspaceError("UNAUTHENTICATED", "An authenticated principal is required"); return request.principal;
}
function customer(request: FastifyRequest): CustomerScope {
  const identity = principal(request); const selected = identity.kind === "administrator" ? request.selectedCustomerId : identity.customerId;
  if (!selected) throw new WorkspaceError("FORBIDDEN", "Administrators must select an explicit customer"); return { customerId: selected as CustomerScope["customerId"] };
}
function key(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !value || value.length > 256) throw new WorkspaceError("INVALID_REQUEST", "Idempotency-Key is required"); return value;
}
function params(request: FastifyRequest) { return request.params as Record<string, string>; }
function workspaceScope(request: FastifyRequest): WorkspaceScope { return { ...customer(request), workspaceId: text.parse(params(request).id) as WorkspaceScope["workspaceId"] }; }
async function lookupContext(runtime: WorkspaceRuntime, request: FastifyRequest, action: "run:read" | "operation:read"): Promise<ResourceLookupContext> {
  const identity = principal(request);
  if (identity.kind !== "administrator") return { kind: "tenant", principal: identity };
  const scope = customer(request); const authorization = await runtime.lifecycle.runtime.authorize(identity, action, scope);
  return { kind: "administrator", principal: identity, scope, authorization: { ...authorization, action, scope } };
}
async function run(runtime: WorkspaceRuntime, request: FastifyRequest, own = false): Promise<Run> {
  const value = await runtime.control.resolveRun(await lookupContext(runtime, request, "run:read"), text.parse(params(request).id) as RunId);
  if (!value) throw new WorkspaceError("RUN_NOT_FOUND", "Run does not exist in this customer scope");
  if (own) {
    const identity = principal(request);
    if (identity.actorId !== value.principal.actorId || canonicalJson(identity.credential) !== canonicalJson(value.principal.credential) || identity.permissionEpoch !== value.principal.permissionEpoch) throw new WorkspaceError("FORBIDDEN", "Run belongs to another authenticated identity");
  }
  return value;
}
const scopeOf = (value: Run): RunScope => ({ ...value.scope, runId: value.id });
async function view(runtime: WorkspaceRuntime, value: Run) {
  const cleanup = await runtime.control.getCleanup(value.scope, value.cleanupId);
  if (!cleanup && !["active", "finalizing"].includes(value.state)) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Run cleanup metadata is unavailable");
  // Active runs reserve a cleanup ID; a versioned job is created only when cleanup is scheduled.
  return runView(value, cleanup ?? { state: "pending", version: 0, attempts: 0, lastError: null }, runtime.now());
}
function transferable(runtime: WorkspaceRuntime, value: Run) {
  if (value.state !== "active") throw new WorkspaceError("INVALID_TRANSITION", "Run no longer permits workspace transfer");
  if (value.lease.expiresAt <= runtime.now()) throw new WorkspaceError("RUN_EXPIRED", "Run client lease expired");
}
async function currentReadAuthority(runtime: WorkspaceRuntime, request: FastifyRequest, pinned: Run) {
  await runtime.lifecycle.runtime.authorize(principal(request), "workspace:read", pinned.scope);
  const current = await run(runtime, request, true);
  transferable(runtime, current);
  if (current.baseRevisionId !== pinned.baseRevisionId || canonicalJson(current.scope) !== canonicalJson(pinned.scope)) throw new WorkspaceError("STORAGE_BINDING_CHANGED", "Pinned run binding changed during transfer");
}
async function base(runtime: WorkspaceRuntime, request: FastifyRequest) {
  const value = await run(runtime, request, true);
  await runtime.lifecycle.runtime.authorize(principal(request), "workspace:read", value.scope);
  transferable(runtime, value);
  const revision = await runtime.control.getRevision(value.scope, value.baseRevisionId);
  const binding = await runtime.control.getBinding(value.scope, value.scope.storageBindingId);
  if (!revision || !binding || binding.generation !== value.scope.bindingGeneration || revision.scope.storageBindingId !== binding.id || revision.scope.bindingGeneration !== binding.generation) throw new WorkspaceError("STORAGE_BINDING_CHANGED", "Pinned run binding is unavailable");
  const store = await runtime.revisionStore(binding); const reference = { ...revision, revisionId: revision.id };
  return { value, store, reference };
}
function cancellation(request: FastifyRequest, reply?: FastifyReply) {
  const controller = new AbortController(); const aborted = () => controller.abort(new WorkspaceError("STORAGE_UNAVAILABLE", "Transfer was interrupted"));
  const closed = () => { if (!reply?.raw.writableFinished) aborted(); };
  request.raw.once("aborted", aborted); if (reply) reply.raw.once("close", closed);
  return { signal: controller.signal, cancel(reason: unknown) { controller.abort(reason); }, dispose() { request.raw.removeListener("aborted", aborted); if (reply) reply.raw.removeListener("close", closed); } };
}

export async function v1Routes(app: FastifyInstance) {
  const runtime = app.contextVault;
  const downloads = new StreamLimiter(runtime.configuration.limits.maxConcurrentStreams);
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  app.post("/workspaces", tag, async (request, reply) => {
    const body = createSchema.parse(request.body); const scope = customer(request);
    if (body.customerId !== scope.customerId) throw new WorkspaceError("FORBIDDEN", "Workspace customer differs from authenticated scope");
    const result = await runtime.lifecycle.createWorkspace({ principal: principal(request), idempotencyKey: key(request), request: body });
    return result.status === "accepted" ? reply.code(201).send(workspaceView(result.workspace)) : reply.code(202).send(operationView(result.operation));
  });
  app.get("/workspaces/:id", tag, async request => {
    const scope = workspaceScope(request); await runtime.lifecycle.runtime.authorize(principal(request), "workspace:read", scope);
    const value = await runtime.control.getWorkspace(scope); if (!value) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found"); return workspaceView(value);
  });
  app.post("/workspaces/:id/runs", tag, async (request, reply) => {
    const result = await runtime.lifecycle.openRun({ scope: workspaceScope(request), principal: principal(request), idempotencyKey: key(request), request: openSchema.parse(request.body) });
    return reply.code(201).send(await view(runtime, result.value));
  });
  app.get("/runs/:id", tag, async request => view(runtime, await run(runtime, request)));
  app.get("/runs/:id/workspace/manifest", tag, async request => {
    const selected = await base(runtime, request);
    const manifest = canonicalizeManifest(await selected.store.readManifest(selected.reference), runtime.configuration.limits);
    await currentReadAuthority(runtime, request, selected.value); return manifest;
  });
  app.get("/runs/:id/workspace/files", tag, async (request, reply) => {
    const path = validatePortablePath(pathSchema.parse(request.query).path, runtime.configuration.limits);
    const selected = await base(runtime, request); const manifest = canonicalizeManifest(await selected.store.readManifest(selected.reference), runtime.configuration.limits);
    await currentReadAuthority(runtime, request, selected.value);
    const entry = manifest.entries.find(entry => entry.path === path);
    if (!entry || entry.kind !== "file") throw new WorkspaceError("REVISION_NOT_FOUND", "File does not exist in the pinned revision");
    const abort = cancellation(request, reply); let release = () => {}; let iterator: AsyncIterator<Uint8Array> | undefined;
    const finished = () => { release(); abort.dispose(); };
    try {
      release = await downloads.acquire(abort.signal);
      await currentReadAuthority(runtime, request, selected.value);
      const bytes = await selected.store.openFile(selected.reference, path, { signal: abort.signal });
      const verified = verifyFileStream(entry, bytes, runtime.configuration.limits)[Symbol.asyncIterator](); iterator = verified;
      const closeSource = async () => { try { await verified.return?.(); } finally { finished(); } };
      // Hold only the first bounded chunk so delayed source reads can fail before sending file headers.
      const first = await verified.next();
      await currentReadAuthority(runtime, request, selected.value); abort.signal.throwIfAborted();
      const stream = Readable.from((async function* () {
        try {
          let chunk = first;
          while (!chunk.done) {
            await currentReadAuthority(runtime, request, selected.value); abort.signal.throwIfAborted();
            yield chunk.value;
            chunk = await verified.next();
          }
        } finally { await closeSource(); }
      })(), { objectMode: false });
      stream.once("close", () => { void closeSource().catch(() => {}); });
      return reply.type("application/octet-stream").header("Content-Length", entry.byteLength).header("X-Content-SHA256", entry.sha256).header("Cache-Control", "no-store").send(stream);
    } catch (error) {
      abort.cancel(error);
      try { await iterator?.return?.(); } finally { finished(); }
      throw error;
    }
  });
  app.post("/runs/:id/submissions", tag, async (request, reply) => {
    emptySchema.parse(request.body); const value = await run(runtime, request, true); const scope = scopeOf(value);
    const command = runtime.lifecycle.runtime.command("submission:create", { principal: principal(request), idempotencyKey: key(request), request: {} }, value.scope, value.id);
    const submission = await runtime.lifecycle.runtime.dependencies.submissions.begin({ scope, principal: principal(request), command, submissionId: runtime.lifecycle.runtime.id("submission") as SubmissionId, expiresAt: runtime.lifecycle.runtime.until(command.requestedAt, runtime.lifecycle.runtime.leaseTtlMs) });
    return reply.code(201).send(submissionView(submission));
  });
  app.get("/runs/:id/submissions/:sid", tag, async request => {
    const value = await run(runtime, request, true); const submission = await runtime.lifecycle.runtime.dependencies.submissions.get(scopeOf(value), text.parse(params(request).sid) as SubmissionId);
    if (!submission) throw new WorkspaceError("SUBMISSION_NOT_FOUND", "Submission not found"); return submissionView(submission);
  });
  app.put("/runs/:id/submissions/:sid/files", tag, async (request, reply) => {
    const value = await run(runtime, request, true); const scope = scopeOf(value); const submissionId = text.parse(params(request).sid) as SubmissionId;
    const path = validatePortablePath(pathSchema.parse(request.query).path, runtime.configuration.limits);
    const declaredSha256 = request.headers["x-content-sha256"];
    if (typeof declaredSha256 !== "string" || !/^[a-f0-9]{64}$/.test(declaredSha256)) throw new WorkspaceError("INVALID_MANIFEST", "X-Content-SHA256 requires lowercase SHA-256");
    const length = request.headers["content-length"];
    if (length !== undefined && (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new WorkspaceError("INVALID_REQUEST", "Invalid Content-Length");
    if (!request.body || typeof (request.body as any)[Symbol.asyncIterator] !== "function") throw new WorkspaceError("INVALID_REQUEST", "File uploads require application/octet-stream");
    const declaredByteLength = length === undefined ? undefined : Number(length);
    const payload = { submissionId, path, declaredByteLength: declaredByteLength ?? null, declaredSha256 };
    const command = runtime.lifecycle.runtime.command("submission:file", { principal: principal(request), idempotencyKey: key(request), request: payload }, value.scope, value.id);
    const abort = cancellation(request);
    try {
      const receipt = await runtime.lifecycle.runtime.dependencies.submissions.writeFile({ scope, principal: principal(request), command, submissionId, receiptId: runtime.lifecycle.runtime.id("receipt") as any, path, declaredSha256, ...(declaredByteLength === undefined ? {} : { declaredByteLength }), bytes: request.body as AsyncIterable<Uint8Array>, signal: abort.signal });
      return reply.code(201).send(receiptView(receipt));
    } finally { abort.dispose(); }
  });
  app.post("/runs/:id/submissions/:sid/seal", tag, async request => {
    const body = sealSchema.parse(request.body); const value = await run(runtime, request, true); const submissionId = text.parse(params(request).sid) as SubmissionId;
    const manifest = canonicalizeManifest(body.manifest, runtime.configuration.limits);
    if (body.receipts.length > runtime.configuration.limits.maxEntries) throw new WorkspaceError("QUOTA_EXCEEDED", "Receipt selection limit exceeded");
    const command = runtime.lifecycle.runtime.command("submission:seal", { principal: principal(request), idempotencyKey: key(request), request: { submissionId, ...body } }, value.scope, value.id);
    return submissionView(await runtime.lifecycle.runtime.dependencies.submissions.seal({ scope: scopeOf(value), principal: principal(request), command, submissionId, manifest, receipts: body.receipts as any, sealedAt: runtime.now() }));
  });
  app.post("/runs/:id/finalize", tag, async (request, reply) => {
    const value = await run(runtime, request, true); const result = await runtime.lifecycle.claimFinalization({ scope: scopeOf(value), principal: principal(request), idempotencyKey: key(request), request: finalizeSchema.parse(request.body) });
    runtime.schedule(result.operation, result.replayed); return reply.code(202).send(operationView(result.operation));
  });
  app.post("/runs/:id/abort", tag, async request => {
    const value = await run(runtime, request, true); const result = await runtime.lifecycle.abort({ scope: scopeOf(value), principal: principal(request), idempotencyKey: key(request), request: abortSchema.parse(request.body) }); return view(runtime, result.value);
  });
  app.post("/runs/:id/heartbeat", tag, async request => {
    const value = await run(runtime, request, true); const result = await runtime.lifecycle.heartbeat({ scope: scopeOf(value), principal: principal(request), idempotencyKey: key(request), request: heartbeatSchema.parse(request.body) }); return view(runtime, result.value);
  });
  app.get("/operations/:id", tag, async request => {
    const operation = await runtime.control.resolveOperation(await lookupContext(runtime, request, "operation:read"), text.parse(params(request).id) as OperationId);
    if (!operation) throw new WorkspaceError("OPERATION_NOT_FOUND", "Operation not found in this customer scope"); return operationView(operation);
  });
}
