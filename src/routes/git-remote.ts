import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

const WORKSPACES_DIR = path.join(process.cwd(), "data", "workspaces");
const META_DIR = path.join(process.cwd(), "data", "workspace-meta");

fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

const VALID_KEY = process.env.API_KEY || "cv-test-api-key-123";

function authGitRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  // Check X-API-Key header
  const apiKey = request.headers["x-api-key"];
  if (apiKey === VALID_KEY) return true;

  // Check Basic auth: git embeds credentials in URL as http://user:pass@host
  // The API key can be in either the username OR password portion
  const auth = request.headers["authorization"];
  if (auth && auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const [user, pass] = decoded.split(":");
    if (user === VALID_KEY || pass === VALID_KEY) return true;
  }

  reply
    .code(401)
    .header("WWW-Authenticate", 'Basic realm="ContextVault"')
    .send("Unauthorized");
  return false;
}

function pktLine(data: string): string {
  const len = data.length + 4;
  return len.toString(16).padStart(4, "0") + data;
}

function getRepoPath(id: string): string | null {
  const repoPath = path.join(WORKSPACES_DIR, id);
  if (fs.existsSync(path.join(repoPath, ".git"))) return repoPath;
  return null;
}

function runGitProcess(
  args: string[],
  cwd: string,
  stdin?: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args[0]} exited ${code}: ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    proc.on("error", reject);

    if (stdin && stdin.length > 0) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

type IdParams = { id: string };
type ServiceQuery = { service?: string };

async function handleInfoRefs(
  request: FastifyRequest<{ Params: IdParams; Querystring: ServiceQuery }>,
  reply: FastifyReply
) {
  if (!authGitRequest(request, reply)) return;

  const { id } = request.params;
  const service = request.query.service;

  if (!service || !["git-upload-pack", "git-receive-pack"].includes(service)) {
    return reply.code(400).send("Missing or invalid service parameter");
  }

  const repoPath = getRepoPath(id);
  if (!repoPath) {
    return reply.code(404).send("Repository not found");
  }

  const gitCmd = service === "git-upload-pack" ? "upload-pack" : "receive-pack";

  try {
    const advertiseOutput = await runGitProcess(
      [gitCmd, "--stateless-rpc", "--advertise-refs", "."],
      repoPath
    );

    // Build smart HTTP info/refs response
    const serviceLine = pktLine("# service=" + service + "\n");
    const flush = "0000";

    const header = Buffer.from(serviceLine + flush, "utf-8");
    const body = Buffer.concat([header, advertiseOutput]);

    reply.header("Content-Type", `application/x-${service}-advertisement`);
    reply.header("Cache-Control", "no-cache");
    reply.send(body);
  } catch (err) {
    request.log.error(err, "info/refs error");
    reply.code(500).send("Internal server error");
  }
}

async function handleUploadPack(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  if (!authGitRequest(request, reply)) return;

  const { id } = request.params;
  const repoPath = getRepoPath(id);
  if (!repoPath) {
    return reply.code(404).send("Repository not found");
  }

  try {
    const body = request.body as Buffer;
    const result = await runGitProcess(
      ["upload-pack", "--stateless-rpc", "."],
      repoPath,
      body
    );

    reply.header("Content-Type", "application/x-git-upload-pack-result");
    reply.header("Cache-Control", "no-cache");
    reply.send(result);
  } catch (err) {
    request.log.error(err, "upload-pack error");
    reply.code(500).send("Internal server error");
  }
}

async function handleReceivePack(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  if (!authGitRequest(request, reply)) return;

  const { id } = request.params;
  const repoPath = getRepoPath(id);
  if (!repoPath) {
    return reply.code(404).send("Repository not found");
  }

  try {
    const body = request.body as Buffer;
    const result = await runGitProcess(
      ["receive-pack", "--stateless-rpc", "."],
      repoPath,
      body
    );

    reply.header("Content-Type", "application/x-git-receive-pack-result");
    reply.header("Cache-Control", "no-cache");
    reply.send(result);
  } catch (err) {
    request.log.error(err, "receive-pack error");
    reply.code(500).send("Internal server error");
  }
}

export async function gitRemoteRoutes(fastify: FastifyInstance) {
  // Register raw body parser for git binary content types
  fastify.addContentTypeParser(
    "application/x-git-upload-pack-request",
    { parseAs: "buffer" },
    (_req: unknown, body: Buffer, done: (err: null, body: Buffer) => void) => {
      done(null, body);
    }
  );

  fastify.addContentTypeParser(
    "application/x-git-receive-pack-request",
    { parseAs: "buffer" },
    (_req: unknown, body: Buffer, done: (err: null, body: Buffer) => void) => {
      done(null, body);
    }
  );

  // Info refs - both upload and receive pack
  fastify.get<{ Params: IdParams; Querystring: ServiceQuery }>(
    "/repos/:id/info/refs",
    handleInfoRefs
  );

  // Upload pack (clone/fetch)
  fastify.post<{ Params: IdParams }>(
    "/repos/:id/git-upload-pack",
    handleUploadPack
  );

  // Receive pack (push)
  fastify.post<{ Params: IdParams }>(
    "/repos/:id/git-receive-pack",
    handleReceivePack
  );
}
