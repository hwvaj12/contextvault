import { useEffect, useState } from "react";
import { getUsageStats } from "../api/contextvault";
import type { UsageStats } from "../api/contextvault";

interface UsageProps {
  onBack: () => void;
}

const periods = ["24h", "7d", "30d"] as const;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Usage({ onBack }: UsageProps) {
  const [period, setPeriod] = useState<string>("7d");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    getUsageStats(period)
      .then((value) => { if (current) setStats(value); })
      .catch((err) => { if (current) setError(err instanceof Error ? err.message : "Usage could not load. Try again."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [period, retry]);

  const maxCount = stats
    ? Math.max(...stats.recordedActionsByDay.map((d) => d.count), 1)
    : 1;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-white text-sm transition-colors"
        >
          ← Back
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white">Usage Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            Recorded actions and workspace overview
          </p>
        </div>
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {periods.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-sm rounded ${
                period === p
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white"
              } transition-colors`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry(value => value + 1)} className="mt-3 text-blue-300 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">Try loading usage again</button>
        </div>
      )}

      {stats && !loading && !error && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard label="Recorded actions" value={stats.recordedActions?.toLocaleString() ?? "Unavailable"} />
            <StatCard label="Workspaces" value={stats.uniqueWorkspaces?.toLocaleString() ?? "Unavailable"} />
            <StatCard label="Current workspace content" value={formatBytes(stats.logicalAcceptedBytes)} />
            <StatCard label="Physical storage" value="Unavailable" />
          </div>
          <p className="text-gray-400 text-sm mb-6">Logical bytes count files in current active workspace revisions. Physical storage, all HTTP requests, and API key counts are unavailable.</p>
          {!stats.measurementComplete && <p className="text-amber-300 text-sm mb-4" role="status">Some measurements are unavailable.</p>}

          {/* Bar chart */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-white font-semibold mb-4">Recorded audit actions by UTC date</h2>
            {stats.recordedActions === 0 && <p className="text-gray-400 text-sm mb-4">No recorded actions in this period.</p>}
            <div className="flex items-end gap-1" style={{ height: 200 }}>
              {stats.recordedActionsByDay.map((day) => {
                const pct = (day.count / maxCount) * 100;
                return (
                  <div
                    key={day.date}
                    className="flex-1 h-full flex flex-col items-center justify-end group"
                  >
                    <span className="text-xs text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity mb-1">
                      {day.count}
                    </span>
                    <div
                      className="w-full bg-blue-600 rounded-t hover:bg-blue-500 transition-colors"
                      style={{ height: `${pct}%` }}
                      title={`${day.date}: ${day.count} recorded actions`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-500">
              <span>{stats.recordedActionsByDay[0]?.date}</span>
              <span>{stats.recordedActionsByDay[stats.recordedActionsByDay.length - 1]?.date}</span>
            </div>
          </div>

          {/* Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg mt-6 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-400 font-medium px-4 py-3">Date</th>
                  <th className="text-right text-gray-400 font-medium px-4 py-3">Recorded actions</th>
                </tr>
              </thead>
              <tbody>
                {stats.recordedActionsByDay
                  .slice()
                  .reverse()
                  .map((day) => (
                    <tr key={day.date} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="px-4 py-2 text-white">{day.date}</td>
                      <td className="px-4 py-2 text-gray-400 text-right font-mono">{day.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <p className="text-gray-400 text-xs mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}
