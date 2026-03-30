import { useState, useEffect, useCallback } from "react";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Workspace from "./pages/Workspace";
import Diff from "./pages/Diff";
import Usage from "./pages/Usage";
import Webhooks from "./pages/Webhooks";
import { getApiKey, setApiKey } from "./api/contextvault";

type Route =
  | { page: "dashboard" }
  | { page: "workspace"; id: string }
  | { page: "diff"; id: string }
  | { page: "usage" }
  | { page: "webhooks" };

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/webhooks") return { page: "webhooks" };
  if (hash === "/usage") return { page: "usage" };
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
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-lg">🗂️</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">ContextVault</h1>
              <p className="text-gray-500 text-xs">Vault Browser</p>
            </div>
          </div>
          
          <p className="text-gray-400 text-sm mb-4">
            Enter your API key to access the vault. Keys are scoped to your customer — you'll only see your own workspaces.
          </p>
          
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
            placeholder="cv_key_..."
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => {
              if (keyInput.trim()) {
                setApiKey(keyInput.trim());
                setHasKey(true);
              }
            }}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-4 py-2 text-sm font-medium transition-colors mb-3"
          >
            Connect
          </button>
          
          <div className="border-t border-gray-800 pt-4 mt-4">
            <p className="text-gray-500 text-xs mb-2">Need an API key?</p>
            <div className="space-y-2">
              <a
                href="/docs"
                target="_blank"
                className="block text-blue-400 hover:text-blue-300 text-xs"
              >
                → Create API key at Swagger docs (/docs)
              </a>
              <button
                onClick={() => {
                  // Use master key from env as default for local dev
                  setKeyInput("cv-test-api-key-123");
                }}
                className="text-gray-500 hover:text-gray-400 text-xs"
              >
                → Use local dev key (cv-test-api-key-123)
              </button>
            </div>
          </div>
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
      {route.page === "dashboard" && <Dashboard onSelect={(id) => navigate(`/workspace/${id}`)} onUsage={() => navigate("/usage")} onWebhooks={() => navigate("/webhooks")} />}
      {route.page === "usage" && <Usage onBack={() => navigate("/")} />}
      {route.page === "webhooks" && <Webhooks onBack={() => navigate("/")} />}
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
