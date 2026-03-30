import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml"; // html
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import shell from "highlight.js/lib/languages/shell";
import arduino from "highlight.js/lib/languages/arduino";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("arduino", arduino);

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
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    htm: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    ini: "ini",
    conf: "ini",
    log: "plaintext",
    txt: "plaintext",
    env: "shell",
    gitignore: "shell",
    dockerfile: "dockerfile",
    makefile: "makefile",
    arduino: "arduino",
  };
  return map[ext] || "plaintext";
}

export default function FileViewer({ path, content }: FileViewerProps) {
  const codeRef = useRef<HTMLElement>(null);
  const lang = detectLanguage(path);
  const lines = content.split("\n");

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.removeAttribute("data-highlighted");
      codeRef.current.className = `hljs language-${lang}`;
      try {
        hljs.highlightElement(codeRef.current);
      } catch {
        // fallback to plain text if highlighting fails
      }
    }
  }, [content, lang]);

  const supportedLang = lang !== "plaintext";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800 text-sm">
        <span className="text-gray-400">{path}</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-500">{lang}</span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-500">{lines.length} lines</span>
      </div>
      <div className="flex-1 overflow-auto">
        {supportedLang ? (
          <pre className="h-full m-0">
            <code ref={codeRef} className={`hljs language-${lang}`}>
              {content}
            </code>
          </pre>
        ) : (
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
        )}
      </div>
    </div>
  );
}
