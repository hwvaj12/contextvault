import { expect, it } from "vitest";
import { loadConfiguration, storageProfile } from "../../src/config";

it("requires explicit production S3 configuration and rejects provider confusion", () => {
  expect(() => loadConfiguration({ CV_STORAGE_BACKEND: "s3", CV_TEST_S3_PROVIDER: "localstack", CV_TEST_S3_BUCKET: "tests-only", CV_TEST_S3_REGION: "us-east-1", CV_TEST_S3_PREFIX: "tests/" })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  const input = { backend: "s3", provider: "aws", bucket: "test-bucket", region: "us-east-1", prefix: "private/", encryption: { algorithm: "AES256" } };
  for (const endpoint of ["http://localhost:4566", "https://localhost:4566", "https://example.com", "https://user:password@s3.amazonaws.com"]) expect(() => storageProfile({ ...input, endpoint })).toThrow();
  expect(() => storageProfile({ ...input, provider: "localstack", endpoint: "https://s3.amazonaws.com" })).toThrow();
  expect(() => loadConfiguration({ CV_WORKSPACE_LIMITS: '{"madeUpLimit":1}' })).toThrow();
  expect(() => loadConfiguration({ CV_WORKSPACE_LIMITS: '{"maxConcurrentStreams":5}' })).toThrow();
  expect(loadConfiguration({ CONTEXTVAULT_API_KEY: "" }).masterKey).toBeNull();
});

it("fingerprints exact physical stores and refuses arbitrary profile fields", () => {
  const initial = storageProfile({ backend: "git", rootDirectory: "/private/example/revisions", submissionRoot: "/private/example/submissions" });
  expect(storageProfile({ submissionRoot: "/private/example/submissions", rootDirectory: "/private/example/revisions", backend: "git" }).configurationRef).toBe(initial.configurationRef);
  expect(storageProfile({ backend: "git", rootDirectory: "/private/example/changed", submissionRoot: "/private/example/submissions" }).configurationRef).not.toBe(initial.configurationRef);
  expect(() => storageProfile({ backend: "git", rootDirectory: "relative", submissionRoot: "/private/example/submissions" })).toThrow();
  expect(() => storageProfile({ backend: "git", rootDirectory: "/private/example/revisions", submissionRoot: "/private/example/submissions", credentials: "unrecognized" })).toThrow();
});
