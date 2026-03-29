interface FileViewerProps {
  path: string;
  content: string;
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    sql: "sql",
  };
  return map[ext] || "plaintext";
}

export default function FileViewer({ path, content }: FileViewerProps) {
  const lang = detectLanguage(path);
  const lines = content.split("\n");

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800 text-sm">
        <span className="text-gray-400">{path}</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-500">{lang}</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-500">{lines.length} lines</span>
      </div>
      <div className="flex-1 overflow-auto font-mono text-sm">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-gray-900/50">
                <td className="text-right text-gray-600 select-none px-3 py-0 w-12 border-r border-gray-800/50">
                  {i + 1}
                </td>
                <td className="px-4 py-0 whitespace-pre">{line || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
