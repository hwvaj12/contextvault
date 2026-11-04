import { expect, it } from "vitest";
import ts from "typescript";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

it("type-checks five scoped ports and rejects unsafe calls without framework or adapter types", () => {
  const fixture = path.resolve(import.meta.dirname, "port-usage.typecheck.ts");
  const program = ts.createProgram([fixture, path.resolve(import.meta.dirname, "recovery.typecheck.ts")], {
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ["node"],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(diagnostics).toEqual([]);
});

it("keeps framework, Git, SQLite, AWS, and Buffer types outside public port declarations", async () => {
  const directory = new URL("../../src/ports/", import.meta.url);
  for (const file of await readdir(directory)) {
    const source = await readFile(new URL(file, directory), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:fastify|simple-git|better-sqlite3|@aws-sdk|node:)/);
    expect(source).not.toMatch(/\bBuffer\b/);
  }
});
