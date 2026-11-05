# ContextVault

ContextVault gives existing agents versioned workspaces through an authenticated HTTP service.
Agents use ordinary files beside their own processes.
ContextVault controls access, accepted revisions, finalize, abort, and recovery.

Git and S3 store immutable revision contents behind the same ports.
A transactional SQLite catalog holds the authoritative current revision.
Changing a storage adapter preserves the client protocol.

## Start here

1. Read the [service setup](docs/DEVELOPMENT.md#start-an-isolated-service).
2. Install a client using the [local artifact quickstart](docs/quickstart/clients.md).
3. Choose an [agent environment](docs/quickstart/hosts.md).
4. Follow the [operations guide](docs/quickstart/operations.md) before migrating existing data.

The service requires durable private catalog and content storage.
S3 stores revision bytes; it does not replace the catalog.
Application workers, containers, local CLIs, and remote agents keep their existing execution environments.
AgentCore and S3 Files mounts are possible future adapters.

## Workspace lifecycle

1. Open a scoped run against an accepted revision.
2. Give your existing agent the client-local workspace path.
3. Renew the lease while the agent works.
4. Stop every writer before capturing the workspace.
5. Finalize the complete snapshot, or abort the active run.
6. Reconcile an uncertain outcome using the retained command identity.
7. Clean local files after a known terminal outcome.

A snapshot contains regular files and explicit directories.
Omitted paths mean deletion.
ContextVault verifies bytes and hashes before publication.
A stale run cannot overwrite a newer accepted revision.

Publication and cleanup have separate outcomes.
A lost response can leave publication uncertain even when the server accepted it.
Private client journals retain the original request, key, capture, and known operation ID.
Current credentials remain necessary for reconciliation.

## Clients and environments

| Component | Declared minimum | Interface |
|---|---|---|
| TypeScript SDK | Node.js 18 | Installed package and client-local workspace sessions |
| Python SDK | Python 3.8 | Installed wheel; POSIX local materialization |
| PHP SDK | PHP 8.0 | Composer dependencies, `ext-curl`, and `ext-json` |
| CLI | Node.js 18 | JSON commands and durable private session state |
| MCP | Node.js 20 | Stdio tools backed by the authenticated TypeScript client |
| Service and test controller | Verified on Node.js 22 | Fastify HTTP API and native SQLite |

Use the repository's local package artifacts.
Registry publication is separate from these installation instructions.
The [client guide](docs/SDK_PLAN.md) describes package versions and recovery behavior.

Container and remote-boundary checks use isolated Docker filesystems and networks.
Native application workers retain their host user's permissions.
Untrusted agents need isolation supplied by their host.
Physical remote hardware, Windows, AWS IAM, and hosted CI require separate verification.

## Architecture

| Responsibility | Owner |
|---|---|
| Identity, grants, revocation, accepted head, and binding | Transactional catalog and access policy |
| Run, submission, publication, abort, and recovery | Application services |
| Immutable revision bytes | Git or S3 revision adapter |
| Uploaded immutable file attempts | Local or S3 submission adapter |
| Temporary files beside an agent | Installed client materializer |
| Agent execution and process isolation | Existing application or agent host |

See [architecture](docs/ARCHITECTURE.md), [storage](docs/STORAGE_LAYER.md), and [security](docs/SECURITY_MODEL.md).

## HTTP and compatibility

The `/v1` API exposes backend-neutral runs, submissions, operations, accepted revisions, and administration.
Responses use opaque revision IDs and omit private storage locations.
The interactive API description is available at `/docs`.

Retained unversioned routes preserve selected compatibility shapes.
Legacy push replaces the complete snapshot.
Legacy sandbox sessions remain explicitly colocated with the server.
Git wire reads project accepted Git history; canonical Git push is disabled.

See the [HTTP reference](docs/REST_API.md) and [consumer migration guide](docs/api/compatibility.md).

## Verification

```sh
npm test
npm run build
npm run test:docs -- --self-test
npm run test:docs -- --backend git
npm run test:docs -- --backend s3 --s3-provider localstack
npm run verify:workspace-release -- --s3-provider localstack --require-all-hosts --require-all-sdks
```

The S3 commands require an explicitly selected nonproduction target.
The [development guide](docs/DEVELOPMENT.md#verification) describes setup, separate suites, and evidence limits.
Missing required tools, services, or suites prevent release closure.
Component tests do not establish complete release readiness.
