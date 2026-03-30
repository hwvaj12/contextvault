import { useEffect, useState } from "react";
import { listWorkspaces } from "../api/contextvault";
import type { Workspace } from "../types";

interface DashboardProps {
  onSelect: (id: string) => void;
  onUsage?: () => void;
  onWebhooks?: () => void;
}

export default function Dashboard({ onSelect, onUsage, onWebhooks }: DashboardProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces()
      .then(setWorkspaces)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Workspaces</h1>
          <p className="text-gray-400 text-sm mt-1">{workspaces.length} workspace{workspaces.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {onWebhooks && (
            <button
              onClick={onWebhooks}
              className="bg-gray-900 border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Webhooks
            </button>
          )}
          {onUsage && (
            <button
              onClick={onUsage}
              className="bg-gray-900 border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Usage Dashboard
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.id)}
            className="text-left bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 hover:bg-gray-900/80 transition-all group"
          >
            <div className="flex items-start justify-between mb-2">
              <h2 className="font-semibold text-white group-hover:text-blue-400 transition-colors truncate">
                {ws.name}
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                {ws.latestCommitId ? "active" : "empty"}
              </span>
            </div>
            <div className="space-y-1 text-xs text-gray-500">
              <div className="flex justify-between">
                <span>Customer</span>
                <span className="text-gray-400 font-mono">{ws.customerId}</span>
              </div>
              <div className="flex justify-between">
                <span>Head</span>
                <span className="text-gray-400 font-mono">{ws.latestCommitId?.slice(0, 7) || "none"}</span>
              </div>
              <div className="flex justify-between">
                <span>Updated</span>
                <span className="text-gray-400">{new Date(ws.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {workspaces.length === 0 && (
        <div className="text-center text-gray-500 py-16">
          <p>No workspaces found.</p>
        </div>
      )}
    </div>
  );
}
