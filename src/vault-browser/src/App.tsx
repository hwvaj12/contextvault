import { useState, useEffect, useCallback } from "react";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Workspace from "./pages/Workspace";
import Diff from "./pages/Diff";
import { getApiKey, setApiKey } from "./api/contextvault";

type Route =
  | { page: "dashboard" }
  | { page: "workspace"; id: string }
  | { page: "diff"; id: string };

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || "/";
  const diffMatch = hash.match(/^\/workspace\/([^/]+)\/diff$/);
  if (diffMatch) return { page: "diff", id: diffMatch[1] };
  const wsMatch = hash.match(/^\/workspace\/([^/]+)$/);
  if (wsMatch) return { page: "workspace", id: wsMatch[1] };
  return { page: "dashboard" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [keyInput, setKeyInput] = useState("");

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  if (!hasKey) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 max-w-md w-full">
          <h1 className="text-xl font-bold text-white mb-2">ContextVault Browser</h1>
          <p className="text-gray-400 text-sm mb-6">Enter your API key to continue.</p>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && keyInput.trim()) {
                setApiKey(keyInput.trim());
                setHasKey(true);
              }
            }}
            placeholder="cv-..."
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => {
              if (keyInput.trim()) {
                setApiKey(keyInput.trim());
                setHasKey(true);
              }
            }}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-4 py-2 text-sm font-medium transition-colors"
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <Layout
      onNavigateHome={() => navigate("/")}
      onLogout={() => {
        setApiKey("");
        setHasKey(false);
      }}
    >
      {route.page === "dashboard" && <Dashboard onSelect={(id) => navigate(`/workspace/${id}`)} />}
      {route.page === "workspace" && (
        <Workspace
          workspaceId={route.id}
          onBack={() => navigate("/")}
          onDiff={() => navigate(`/workspace/${route.id}/diff`)}
        />
      )}
      {route.page === "diff" && (
        <Diff workspaceId={route.id} onBack={() => navigate(`/workspace/${route.id}`)} />
      )}
    </Layout>
  );
}
