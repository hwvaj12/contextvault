import * as path from "path";

/**
 * Validate that a file path is safe and doesn't escape the sandbox.
 * Returns the resolved absolute path, or throws if unsafe.
 */
export function validatePath(sandboxRoot: string, filePath: string): string {
  // Normalize both paths
  const root = path.resolve(sandboxRoot);
  const resolved = path.resolve(root, filePath);

  // Ensure the resolved path is within the sandbox root
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new PathTraversalError(
      `Path "${filePath}" resolves outside sandbox root`
    );
  }

  // Block suspicious patterns
  const normalized = path.normalize(filePath);
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("\\..\\")) {
    throw new PathTraversalError(
      `Path "${filePath}" contains directory traversal`
    );
  }

  // Block absolute paths
  if (path.isAbsolute(filePath)) {
    throw new PathTraversalError(
      `Absolute paths not allowed: "${filePath}"`
    );
  }

  // Block hidden files in root (like .git)
  const parts = filePath.split(path.sep);
  if (parts[0] === ".git" || parts.includes(".git")) {
    throw new PathTraversalError(
      `Access to .git directory not allowed`
    );
  }

  return resolved;
}

/**
 * Validate multiple paths. Returns all resolved paths or throws on first invalid.
 */
export function validatePaths(sandboxRoot: string, filePaths: string[]): string[] {
  return filePaths.map((fp) => validatePath(sandboxRoot, fp));
}

export class PathTraversalError extends Error {
  code = "PATH_TRAVERSAL";
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}
