import { useEffect, useState, useCallback, useRef } from "react";
import { getWorkspace, getFiles, getHistory, searchFiles, type SearchResult } from "../api/contextvault";
import type { Workspace as WorkspaceType, WorkspaceFile, Commit } from "../types";
import FileTree from "../components/FileTree";
import FileViewer from "../components/FileViewer";
import CommitHistory from "../components/CommitHistory";

interface WorkspaceProps {
  workspaceId: string;
  onBack: () => void;
  onDiff: () => void;
}

export default function Workspace({ workspaceId, onBack, onDiff }: WorkspaceProps) {
  const [workspace, setWorkspace] = useState<WorkspaceType | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ws, f, h] = await Promise.all([
        getWorkspace(workspaceId),
        getFiles(workspaceId),
        getHistory(workspaceId),
      ]);
      setWorkspace(ws);
      setFiles(f);
      setCommits(h);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Keyboard shortcut: Ctrl+K or Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showSearch]);

  const handleCommitSelect = useCallback(
    async (hash: string) => {
      setSelectedCommit(hash);
      try {
        const f = await getFiles(workspaceId, hash);
        setFiles(f);
        setSelectedPath(null);
      } catch {
        // Stay on current files if version fetch fails
      }
    },
    [workspaceId]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        setSearchResults([]);
        setShowSearch(false);
        return;
      }
      setSearching(true);
      setShowSearch(true);
      try {
        const res = await searchFiles(workspaceId, query);
        setSearchResults(res.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [workspaceId]
  );

  const handleResultClick = (result: SearchResult) => {
    setSelectedPath(result.path);
    // Load the correct version if viewing a specific commit
    if (selectedCommit) {
      getFiles(workspaceId, selectedCommit).then((f) => {
        setFiles(f);
      });
    }
    setShowSearch(false);
    setSearchQuery("");
  };

  const selectedFile = files.find((f) => f.path === selectedPath);

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
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
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
        <h2 className="text-white font-semibold">{workspace?.name}</h2>
        <span className="text-gray-500 text-xs font-mono">{workspaceId}</span>

        {/* Search */}
        <div className="flex-1 max-w-md ml-4">
          <div className="relative">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onFocus={() => searchQuery && setShowSearch(true)}
              placeholder="Search files... (Ctrl+K)"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            {searching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {showSearch && searchQuery && !searching && (
              <button
                onClick={() => { setShowSearch(false); setSearchQuery(""); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-lg leading-none"
              >
                ×
              </button>
            )}
          </div>
          {showSearch && searchQuery && (
            <div className="absolute z-50 mt-1 w-[28rem] bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-64 overflow-auto">
              {searchResults.length === 0 ? (
                <div className="px-4 py-3 text-gray-500 text-sm">
                  No matches found
                </div>
              ) : (
                searchResults.map((result, i) => (
                  <button
                    key={`${result.path}-${result.lineNumber}-${i}`}
                    onClick={() => handleResultClick(result)}
                    className="w-full text-left px-4 py-2 hover:bg-gray-800 border-b border-gray-800/50 last:border-0"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-blue-400 text-xs font-mono">{result.path}</span>
                      {result.lineNumber > 0 && (
                        <span className="text-gray-600 text-xs">:{result.lineNumber}</span>
                      )}
                    </div>
                    <p className="text-gray-400 text-xs truncate">{result.snippet}</p>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />
        <button
          onClick={load}
          className="text-gray-400 hover:text-white text-sm px-3 py-1 rounded border border-gray-700 hover:border-gray-600 transition-colors"
        >
          Refresh
        </button>
        <button
          onClick={onDiff}
          className="text-gray-400 hover:text-white text-sm px-3 py-1 rounded border border-gray-700 hover:border-gray-600 transition-colors"
        >
          Diff
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className="w-64 border-r border-gray-800 overflow-y-auto bg-gray-950 flex-shrink-0">
          <div className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider font-semibold">
            Files ({files.length})
          </div>
          <FileTree files={files} selectedPath={selectedPath} onSelect={setSelectedPath} />
        </div>

        {/* File viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 overflow-auto">
            {selectedFile ? (
              <FileViewer path={selectedFile.path} content={selectedFile.content} />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                Select a file to view
              </div>
            )}
          </div>

          {/* Commit history */}
          <div className="border-t border-gray-800 bg-gray-900/50 max-h-36 overflow-auto">
            <div className="px-4 py-1 text-xs text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800/50">
              Commits ({commits.length})
            </div>
            <CommitHistory
              commits={commits}
              selectedCommit={selectedCommit}
              onSelect={handleCommitSelect}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
