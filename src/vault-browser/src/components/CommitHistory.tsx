import { useState, useMemo } from "react";
import type { Commit } from "../types";

interface CommitHistoryProps {
  commits: Commit[];
  selectedCommit: string | null;
  onSelect: (hash: string) => void;
}

type DateRange = "24h" | "7d" | "30d" | "all";

const DATE_RANGE_MS: Record<Exclude<DateRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function CommitHistory({ commits, selectedCommit, onSelect }: CommitHistoryProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);

  const allTags = useMemo(
    () => [...new Set(commits.flatMap((c) => c.metadata?.tags ?? []))].sort(),
    [commits],
  );

  const allAgents = useMemo(
    () => [...new Set(commits.map((c) => c.metadata?.agentId).filter(Boolean) as string[])].sort(),
    [commits],
  );

  const filteredCommits = useMemo(() => {
    const now = Date.now();
    return commits.filter((c) => {
      if (selectedTags.length > 0) {
        const tags = c.metadata?.tags ?? [];
        if (!selectedTags.some((t) => tags.includes(t))) return false;
      }
      if (dateRange !== "all") {
        const age = now - new Date(c.createdAt).getTime();
        if (age > DATE_RANGE_MS[dateRange]) return false;
      }
      if (selectedAgent && c.metadata?.agentId !== selectedAgent) return false;
      return true;
    });
  }, [commits, selectedTags, dateRange, selectedAgent]);

  const hasActiveFilters = selectedTags.length > 0 || dateRange !== "all" || selectedAgent !== "";

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  return (
    <div>
      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-gray-800">
        {/* Tag filter */}
        {allTags.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setTagDropdownOpen(!tagDropdownOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              <span>{selectedTags.length > 0 ? `Tags (${selectedTags.length})` : "Tags"}</span>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {tagDropdownOpen && (
              <div className="absolute z-10 mt-1 w-48 bg-gray-800 border border-gray-700 rounded shadow-lg max-h-48 overflow-y-auto">
                {allTags.map((tag) => (
                  <label
                    key={tag}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTags.includes(tag)}
                      onChange={() => toggleTag(tag)}
                      className="rounded border-gray-600"
                    />
                    <span className={selectedTags.includes(tag) ? "text-white" : "text-gray-400"}>
                      {tag}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Date range filter */}
        <div className="flex items-center gap-1">
          {(["24h", "7d", "30d", "all"] as DateRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setDateRange(range)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                dateRange === range
                  ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                  : "bg-gray-800 text-gray-400 border border-gray-700 hover:text-white"
              }`}
            >
              {range === "all" ? "All time" : `Last ${range}`}
            </button>
          ))}
        </div>

        {/* Agent filter */}
        {allAgents.length > 0 && (
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="px-2.5 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors appearance-none cursor-pointer"
          >
            <option value="">All agents</option>
            {allAgents.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        )}

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              setSelectedTags([]);
              setDateRange("all");
              setSelectedAgent("");
            }}
            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Commit timeline */}
      <div className="overflow-x-auto">
        <div className="flex items-start gap-0 min-w-max px-4 py-3">
          {filteredCommits.map((commit, i) => {
            const isSelected = selectedCommit === commit.id;
            return (
              <div key={commit.id} className="flex items-start">
                <button
                  onClick={() => onSelect(commit.id)}
                  className={`flex flex-col items-center gap-1 px-3 py-2 rounded transition-colors min-w-[120px] ${
                    isSelected
                      ? "bg-blue-600/20 border border-blue-500/30"
                      : "hover:bg-gray-800 border border-transparent"
                  }`}
                >
                  <div
                    className={`w-3 h-3 rounded-full border-2 ${
                      isSelected ? "bg-blue-500 border-blue-400" : "bg-gray-700 border-gray-600"
                    }`}
                  />
                  <span className="text-xs font-mono text-gray-400">{commit.id.slice(0, 7)}</span>
                  <span className="text-xs text-gray-300 text-center line-clamp-2 max-w-[100px]">
                    {commit.metadata?.tags?.join(", ") || `Commit ${commit.id.slice(0, 7)}`}
                  </span>
                  <span className="text-xs text-gray-500">{timeAgo(commit.createdAt)}</span>
                </button>
                {i < filteredCommits.length - 1 && (
                  <div className="flex items-center h-8 mt-2">
                    <div className="w-4 h-0.5 bg-gray-700" />
                  </div>
                )}
              </div>
            );
          })}
          {filteredCommits.length === 0 && (
            <p className="text-gray-500 text-sm">
              {commits.length === 0 ? "No commits yet" : "No commits match filters"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
