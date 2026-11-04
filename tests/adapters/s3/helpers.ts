import { randomUUID } from "node:crypto";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { S3RevisionStore, type S3RevisionStoreOptions } from "../../../src/adapters/revisions/s3";
import { createTestWriterTracking } from "../../recovery/tracking";
export * from "../git/fixtures";

export async function setup(overrides: Partial<S3RevisionStoreOptions> = {}) {
  const provider = process.env.CV_TEST_S3_PROVIDER;
  if (!['localstack', 'aws'].includes(provider ?? '')) throw new Error('Explicit CV_TEST_S3_PROVIDER is required');
  const bucket = process.env.CV_TEST_S3_BUCKET!;
  const parent = process.env.CV_TEST_S3_PREFIX!;
  if (!bucket || !/^contextvault-tests\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(parent)) throw new Error('Explicit nonproduction S3 bucket/prefix required');
  const client = new S3Client({ region: process.env.CV_TEST_S3_REGION, endpoint: process.env.CV_TEST_S3_ENDPOINT, forcePathStyle: provider === 'localstack', ignoreConfiguredEndpointUrls: true,
    ...(provider === 'localstack' ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}), maxAttempts: 1 });
  const prefix = `${parent}cv14-${randomUUID()}/`;
  const options: S3RevisionStoreOptions = { client, bucket, prefix, storeId: 'private-s3-test', allowInsecureEndpoint: provider === 'localstack', encryption: { algorithm: 'AES256' }, ...overrides };
  if (options.verifyCollectionPermit && !options.writerTracking) options.writerTracking = createTestWriterTracking();
  return { client, bucket, prefix, options, store: new S3RevisionStore(options), reopen: () => new S3RevisionStore(options),
    async keys() { return (await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).Contents?.map(o => o.Key!) ?? []; },
    async close() {
      let marker: string | undefined;
      do {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: marker }));
        if (objects.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key! })) } }));
        marker = objects.NextContinuationToken;
      } while (marker);
      const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
      for (const upload of uploads.Uploads ?? []) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key!, UploadId: upload.UploadId! }));
      client.destroy();
    } };
}
