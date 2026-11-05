# Installed-client host acceptance

Run each backend explicitly:

```sh
npm run test:hosts -- --backend git
npm run test:hosts -- --backend s3 --s3-provider localstack
```

The S3 command requires `CV_TEST_S3_BUCKET`, `CV_TEST_S3_REGION`, `CV_TEST_S3_PREFIX`, and `CV_TEST_S3_ENDPOINT`.
Select an isolated LocalStack service with a mapped local endpoint.
Set `CV_TEST_S3_CONTAINER` when the container name differs from `cv-localstack-01a1a255`.
The root runner selects dummy emulator credentials and rejects an implicit provider.

The controller requires Node22+, Docker, Python3 with venv, PHP8+, and Composer2.
`CV_TEST_PYTHON_BINARY`, `CV_TEST_PHP_BINARY`, and `CV_TEST_COMPOSER_BINARY` override controller executables.
Dependency downloads occur before isolated execution.

| Environment | Installed clients | Boundary |
|---|---|---|
| Application worker | TypeScript, Python, PHP | Independent cooperating host processes |
| Container | TypeScript, Python, PHP | Private shared client directory; internal API network |
| Separate machine simulation | TypeScript, Python, PHP | Private named volume; isolated container and network |
| Local CLI | TypeScript SDK and separate CLI package | Installed executable; private durable session directory |

Container SDK cells use Node18, Python3.8, and PHP8.0 images.
Native workers report their actual supported host runtimes separately.
The supplied Dockerfile also exercises its Node24 client image.
These runtimes provide separate minimum and current-host evidence.

Each SDK cell launches an independent shell agent against ordinary files.
It verifies exact binary bytes, deletions, empty directories, Unicode paths, checkpoint, finalize, abort, and cleanup.
The API relay truncates an actual accepted response after its headers.
The controller retains its original command, then dies through `SIGKILL`.
A fresh process reconciles that command and restores its immutable captured bytes after deliberate local tampering.

The relay fixes its upstream API origin and rejects alternate destinations, CONNECT, and upgrades.
S3 container cells test direct connections to the actual storage-container IP and actual host endpoint.
On Linux, the host probe uses the inspected gateway of the owned API network.
On macOS, the host probe resolves Docker Desktop's `host.docker.internal` address.
They also inspect mounts and networks and verify an unmounted host sentinel remains inaccessible.
Agents receive no canonical storage credentials, server source, server volumes, or Docker socket.
Native worker and CLI cells do not establish hostile same-user containment.
The separate-machine simulation does not claim physical remote hardware or production AWS IAM evidence.

The CLI suite also verifies separate submit and publication, documented exits, concurrent-controller refusal, and a killed opening before stdout.
Only an explicit stopped-controller assertion permits retiring a leftover cooperative marker.
That assertion preserves the SDK journal, original key, and capture.

Ignored `tooling/` contains built packages, dependency installations, and runtime evidence.
Package caches use source and tool fingerprints and publish their ready marker after installation completes.
`tooling/evidence/<backend>-<environment>-<language>.json` records each SDK cell's runtime, OS, image, artifact, and outcome.
Separate files record the CLI and supplied container example.
Evidence from a focused run proves only its selected cells.
Full acceptance requires both explicit backend commands to pass without exclusions.
