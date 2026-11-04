# Selected S3 verification target

The user selected LocalStack on 2026-11-04.
This selection replaces the earlier real-AWS requirement for this milestone.
All agent environments must still complete the required Git and S3 journeys.
Reports identify LocalStack evidence separately from AWS service parity.

The lead started an isolated `localstack/localstack:4.14.0` Community container.
Image digest: `sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a`.
The service uses a dedicated Docker network and a loopback-only ephemeral host port.
The container has no Docker socket mount.
Its local bucket is `contextvault-tests-01a1a255`, in the emulator's `us-east-1` region.
The unique test prefix starts with `contextvault-tests/01a1a255-`.
The local service uses the documented dummy `test` credentials.
The runtime endpoint, prefix, container identity, and network are recorded in `.lead/localstack.json`.

Preflight created an empty object with conditional creation, SHA-256, and `AES256` encryption.
The service rejected the repeated conditional creation with `PreconditionFailed`.
Head-object returned the expected SHA-256, encryption, and zero length.
The lead deleted that preflight object after checking it.
These probes do not establish adapter or lifecycle completion.

CV-14 adds explicit `--s3-provider localstack|aws` gate selection.
The optional `--require-real-s3` gate must reject LocalStack and require AWS.
LocalStack-backed release checks must record their provider and image version.
Missing services, configuration, or required host capacity must fail the selected gate.
The final report must leave unperformed AWS verification unclaimed.

The [official release announcement](https://blog.localstack.cloud/localstack-for-aws-release-v-4-14-0/) documents this Community image.
The [SDK configuration guide](https://docs.localstack.cloud/aws/integrations/aws-sdks/javascript/) describes endpoint configuration and path-style S3 addressing.
