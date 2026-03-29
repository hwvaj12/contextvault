import { describe, it, expect } from "vitest";
import { validatePath, validatePaths, PathTraversalError } from "../../src/utils/path-safety";

describe("Path Safety", () => {
  const sandbox = "/tmp/sandbox/ws_001";

  it("should accept valid relative paths", () => {
    expect(validatePath(sandbox, "profile/summary.md")).toBe(
      "/tmp/sandbox/ws_001/profile/summary.md"
    );
    expect(validatePath(sandbox, "state/current.json")).toBe(
      "/tmp/sandbox/ws_001/state/current.json"
    );
  });

  it("should reject directory traversal with ..", () => {
    expect(() => validatePath(sandbox, "../../../etc/passwd")).toThrow(PathTraversalError);
    expect(() => validatePath(sandbox, "profile/../../secret")).toThrow(PathTraversalError);
  });

  it("should reject absolute paths", () => {
    expect(() => validatePath(sandbox, "/etc/passwd")).toThrow(PathTraversalError);
    expect(() => validatePath(sandbox, "/tmp/other/file")).toThrow(PathTraversalError);
  });

  it("should reject .git access", () => {
    expect(() => validatePath(sandbox, ".git/config")).toThrow(PathTraversalError);
    expect(() => validatePath(sandbox, "sub/.git/objects")).toThrow(PathTraversalError);
  });

  it("should validate multiple paths", () => {
    const paths = ["profile/a.md", "state/b.json"];
    const resolved = validatePaths(sandbox, paths);
    expect(resolved).toHaveLength(2);
  });

  it("should throw on first invalid in batch", () => {
    expect(() =>
      validatePaths(sandbox, ["valid.txt", "../escape.txt"])
    ).toThrow(PathTraversalError);
  });
});
