import type { Commit } from "../types";

interface CommitHistoryProps {
  commits: Commit[];
  selectedCommit: string | null;
  onSelect: (hash: string) => void;
}

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
  return (
    <div className="overflow-x-auto">
      <div className="flex items-start gap-0 min-w-max px-4 py-3">
        {commits.map((commit, i) => {
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
              {i < commits.length - 1 && (
                <div className="flex items-center h-8 mt-2">
                  <div className="w-4 h-0.5 bg-gray-700" />
                </div>
              )}
            </div>
          );
        })}
        {commits.length === 0 && (
          <p className="text-gray-500 text-sm">No commits yet</p>
        )}
      </div>
    </div>
  );
}
