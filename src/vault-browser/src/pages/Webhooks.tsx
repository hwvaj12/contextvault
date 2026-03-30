import { useEffect, useState } from "react";
import { listWebhooksApi, createWebhook, deleteWebhookApi, listWorkspaces } from "../api/contextvault";
import type { Webhook } from "../types";

const WEBHOOK_EVENTS = [
  "workspace.created",
  "workspace.deleted",
  "commit.created",
  "run.completed",
  "run.started",
  "run.failed",
  "sandbox.checked_out",
  "sandbox.destroyed",
];

interface WebhooksProps {
  onBack: () => void;
}

export default function Webhooks({ onBack }: WebhooksProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  // Create form state
  const [newUrl, setNewUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    // Resolve customerId from workspaces, then load webhooks
    listWorkspaces()
      .then((workspaces) => {
        if (workspaces.length > 0) {
          const cid = workspaces[0].customerId;
          setCustomerId(cid);
          return listWebhooksApi(cid);
        }
        setCustomerId("default");
        return listWebhooksApi("default");
      })
      .then(setWebhooks)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newUrl.trim() || selectedEvents.length === 0 || !customerId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const webhook = await createWebhook(customerId, newUrl.trim(), selectedEvents);
      setWebhooks((prev) => [webhook, ...prev]);
      setNewUrl("");
      setSelectedEvents([]);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await deleteWebhookApi(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      setDeleteTarget(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const toggleEvent = (event: string) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error && webhooks.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm mb-4 transition-colors">
          &larr; Back to Dashboard
        </button>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <button onClick={onBack} className="text-gray-400 hover:text-white text-sm mb-2 transition-colors">
            &larr; Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-white">Webhooks</h1>
          <p className="text-gray-400 text-sm mt-1">
            {webhooks.length} webhook{webhooks.length !== 1 ? "s" : ""} registered
          </p>
        </div>
      </div>

      {/* Create new webhook */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Create Webhook</h2>

        <div className="mb-4">
          <label className="block text-gray-400 text-sm mb-1">Endpoint URL</label>
          <input
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://example.com/webhook"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="mb-4">
          <label className="block text-gray-400 text-sm mb-2">Events</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {WEBHOOK_EVENTS.map((event) => (
              <label
                key={event}
                className={`flex items-center gap-2 px-3 py-2 rounded border text-sm cursor-pointer transition-colors ${
                  selectedEvents.includes(event)
                    ? "bg-blue-600/20 border-blue-500 text-blue-300"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedEvents.includes(event)}
                  onChange={() => toggleEvent(event)}
                  className="sr-only"
                />
                <span
                  className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                    selectedEvents.includes(event)
                      ? "bg-blue-500 border-blue-500"
                      : "border-gray-600"
                  }`}
                >
                  {selectedEvents.includes(event) && (
                    <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                {event}
              </label>
            ))}
          </div>
        </div>

        {createError && (
          <div className="bg-red-900/20 border border-red-800 rounded p-3 text-red-300 text-sm mb-4">
            {createError}
          </div>
        )}

        <button
          onClick={handleCreate}
          disabled={creating || !newUrl.trim() || selectedEvents.length === 0}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded px-4 py-2 text-sm font-medium transition-colors"
        >
          {creating ? "Creating..." : "Create Webhook"}
        </button>
      </div>

      {/* Webhook list */}
      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {webhooks.map((wh) => (
          <div key={wh.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-white font-mono text-sm truncate">{wh.url}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      wh.active ? "bg-green-900/30 text-green-400" : "bg-gray-800 text-gray-500"
                    }`}
                  >
                    {wh.active ? "active" : "inactive"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                  {wh.events.map((ev) => (
                    <span key={ev} className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400">
                      {ev}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-gray-500">
                  <span className="font-mono">{wh.id}</span>
                  <span className="mx-2">&middot;</span>
                  Created {new Date(wh.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div>
                {deleteTarget === wh.id ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDelete(wh.id)}
                      disabled={deleting}
                      className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded px-3 py-1 text-xs font-medium transition-colors"
                    >
                      {deleting ? "..." : "Confirm"}
                    </button>
                    <button
                      onClick={() => setDeleteTarget(null)}
                      className="text-gray-400 hover:text-white text-xs transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteTarget(wh.id)}
                    className="text-red-400 hover:text-red-300 text-xs transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {webhooks.length === 0 && (
        <div className="text-center text-gray-500 py-16">
          <p>No webhooks registered yet.</p>
        </div>
      )}
    </div>
  );
}
