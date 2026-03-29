import { useState } from "react";
import type { FileTreeNode } from "../types";
import type { WorkspaceFile } from "../types";

interface FileTreeProps {
  files: WorkspaceFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function buildTree(files: WorkspaceFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      let existing = current.find((n) => n.name === name);
      if (!existing) {
        existing = {
          name,
          path,
          type: isFile ? "file" : "directory",
          children: isFile ? undefined : [],
        };
        current.push(existing);
      }
      if (!isFile && existing.children) {
        current = existing.children;
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    }).map((n) => ({
      ...n,
      children: n.children ? sortNodes(n.children) : undefined,
    }));
  };

  return sortNodes(root);
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = selectedPath === node.path;

  if (node.type === "directory") {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1 px-2 py-0.5 text-sm text-gray-300 hover:bg-gray-800 rounded transition-colors"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <svg
            className={`w-3 h-3 text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
          </svg>
          <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={expanded ? "M5 19a2 2 0 01-2-2V7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5z" : "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"} />
          </svg>
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const ext = node.name.split(".").pop() || "";
  const iconColor = {
    ts: "text-blue-400",
    tsx: "text-blue-400",
    js: "text-yellow-400",
    jsx: "text-yellow-400",
    json: "text-green-400",
    md: "text-gray-400",
    css: "text-purple-400",
    html: "text-orange-400",
  }[ext] || "text-gray-400";

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full flex items-center gap-1 px-2 py-0.5 text-sm rounded transition-colors ${
        isSelected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
      }`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="w-3" />
      <svg className={`w-4 h-4 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export default function FileTree({ files, selectedPath, onSelect }: FileTreeProps) {
  const tree = buildTree(files);

  return (
    <div className="py-2 overflow-y-auto h-full">
      {tree.length === 0 ? (
        <p className="text-gray-500 text-sm px-4">No files</p>
      ) : (
        tree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
        ))
      )}
    </div>
  );
}
