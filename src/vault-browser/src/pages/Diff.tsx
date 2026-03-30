import { useEffect, useState, useCallback } from "react";
import { getHistory, getDiff } from "../api/contextvault";
import type { Commit, DiffResult } from "../types";

interface DiffProps {
  workspaceId: string;
  onBack: () => void;
}

export default function Diff({ workspaceId, onBack }: DiffProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [fromHash, setFromHash] = useState("");
  const [toHash, setToHash] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");

  useEffect(() => {
    getHistory(workspaceId)
      .then((c) => {
        setCommits(c);
        if (c.length >= 2) {
          setFromHash(c[1].id);
          setToHash(c[0].id);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingCommits(false));
  }, [workspaceId]);

  const loadDiff = useCallback(async () => {
    if (!fromHash || !toHash) return;
    setLoading(true);
    setError(null);
    try {
      const d = await getDiff(workspaceId, fromHash, toHash);
      setDiff(d);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load diff");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fromHash, toHash]);

  useEffect(() => {
    if (fromHash && toHash) loadDiff();
  }, [fromHash, toHash, loadDiff]);

  if (loadingCommits) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const getCommitLabel = (c: Commit) => {
    const tags = c.metadata?.tags?.join(", ") || c.id.slice(0, 7);
    return `${c.id.slice(0, 7)} - ${tags}`;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 flex-wrap">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="h-4 w-px bg-gray-700" />
        <span className="text-white text-sm font-semibold">Diff</span>
        <div className="h-4 w-px bg-gray-700" />

        <label className="text-gray-400 text-xs">From:</label>
        <select
          value={fromHash}
          onChange={(e) => setFromHash(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-white rounded px-2 py-1 max-w-[200px]"
        >
          <option value="">Select commit...</option>
          {commits.map((c) => (
            <option key={c.id} value={c.id}>
              {getCommitLabel(c)}
            </option>
          ))}
        </select>

        <label className="text-gray-400 text-xs">To:</label>
        <select
          value={toHash}
          onChange={(e) => setToHash(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-white rounded px-2 py-1 max-w-[200px]"
        >
          <option value="">Select commit...</option>
          {commits.map((c) => (
            <option key={c.id} value={c.id}>
              {getCommitLabel(c)}
            </option>
          ))}
        </select>

        <div className="flex-1" />
        <div className="flex rounded border border-gray-700 overflow-hidden">
          <button
            onClick={() => setViewMode("unified")}
            className={`text-xs px-3 py-1 ${viewMode === "unified" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
          >
            Unified
          </button>
          <button
            onClick={() => setViewMode("split")}
            className={`text-xs px-3 py-1 ${viewMode === "split" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
          >
            Split
          </button>
        </div>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm mb-4">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        )}

        {!loading && diff && (
          <div className="space-y-4">
            {diff.files.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-8">No changes between these commits</p>
            ) : (
              diff.files.map((file) => (
                <div key={file.path} className="border border-gray-800 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        file.status === "added"
                          ? "bg-green-900/30 text-green-400"
                          : file.status === "deleted"
                          ? "bg-red-900/30 text-red-400"
                          : "bg-yellow-900/30 text-yellow-400"
                      }`}
                    >
                      {file.status}
                    </span>
                    <span className="text-sm text-white font-mono">{file.path}</span>
                    <div className="flex-1" />
                    <span className="text-xs text-green-400">+{file.additions}</span>
                    <span className="text-xs text-red-400">-{file.deletions}</span>
                  </div>
                  {file.hunks && file.hunks.length > 0 && (
                    <div className="font-mono text-xs overflow-x-auto">
                      {viewMode === "unified" ? (
                        <UnifiedDiff hunks={file.hunks} />
                      ) : (
                        <SplitDiff hunks={file.hunks} />
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {!loading && !diff && !error && (
          <p className="text-gray-500 text-sm text-center py-8">Select two commits to compare</p>
        )}
      </div>
    </div>
  );
}

function UnifiedDiff({ hunks }: { hunks: DiffResult["files"][0]["hunks"] }) {
  if (!hunks) return null;
  let lineNum = 0;
  return (
    <table className="w-full border-collapse">
      <tbody>
        {hunks.flatMap((hunk, hi) => {
          const lines = hunk.content.split("\n");
          return lines.map((line, i) => {
            if (!line.startsWith("@@")) lineNum++;
            const isAdd = line.startsWith("+") && !line.startsWith("+++");
            const isDel = line.startsWith("-") && !line.startsWith("---");
            const isHeader = line.startsWith("@@");
            return (
              <tr
                key={`${hi}-${i}`}
                className={
                  isAdd ? "bg-green-900/10" : isDel ? "bg-red-900/10" : isHeader ? "bg-blue-900/10" : ""
                }
              >
                <td className="text-right text-gray-600 select-none px-2 w-10 border-r border-gray-800/30">
                  {isHeader ? "" : lineNum}
                </td>
                <td className="px-3 whitespace-pre">
                  <span className={isAdd ? "text-green-400" : isDel ? "text-red-400" : isHeader ? "text-blue-400" : "text-gray-300"}>
                    {line}
                  </span>
                </td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

function SplitDiff({ hunks }: { hunks: DiffResult["files"][0]["hunks"] }) {
  if (!hunks) return null;
  const left: Array<{ text: string; type: "add" | "del" | "header" | "ctx" | "empty" }> = [];
  const right: Array<{ text: string; type: "add" | "del" | "header" | "ctx" | "empty" }> = [];

  for (const hunk of hunks) {
    const lines = hunk.content.split("\n");
    for (const line of lines) {
      if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
        left.push({ text: line, type: "header" });
        right.push({ text: line, type: "header" });
      } else if (line.startsWith("-")) {
        left.push({ text: line.slice(1), type: "del" });
      } else if (line.startsWith("+")) {
        right.push({ text: line.slice(1), type: "add" });
      } else {
        while (left.length < right.length) left.push({ text: "", type: "empty" });
        while (right.length < left.length) right.push({ text: "", type: "empty" });
        left.push({ text: line.slice(1) || line, type: "ctx" });
        right.push({ text: line.slice(1) || line, type: "ctx" });
      }
    }
  }
  while (left.length < right.length) left.push({ text: "", type: "empty" });
  while (right.length < left.length) right.push({ text: "", type: "empty" });

  return (
    <div className="flex">
      <table className="w-1/2 border-collapse border-r border-gray-800">
        <tbody>
          {left.map((l, i) => (
            <tr
              key={i}
              className={l.type === "del" ? "bg-red-900/10" : l.type === "header" ? "bg-blue-900/10" : ""}
            >
              <td className="px-3 whitespace-pre">
                <span className={l.type === "del" ? "text-red-400" : l.type === "header" ? "text-blue-400" : "text-gray-300"}>
                  {l.text || " "}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-1/2 border-collapse">
        <tbody>
          {right.map((r, i) => (
            <tr
              key={i}
              className={r.type === "add" ? "bg-green-900/10" : r.type === "header" ? "bg-blue-900/10" : ""}
            >
              <td className="px-3 whitespace-pre">
                <span className={r.type === "add" ? "text-green-400" : r.type === "header" ? "text-blue-400" : "text-gray-300"}>
                  {r.text || " "}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
