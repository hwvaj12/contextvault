import { useState, useEffect, useCallback } from 'react';
import { api, Workspace, PullResponse, Commit, DiffResponse } from './api';
import './App.css';

function App() {
  const [apiKey, setApiKey] = useState('cv-test-api-key-123');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>('');
  const [newWsName, setNewWsName] = useState('');
  const [newWsCustomer, setNewWsCustomer] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Push state
  const [pushFiles, setPushFiles] = useState([{ path: '', content: '' }]);
  const [pushAgentId, setPushAgentId] = useState('');

  // Pull state
  const [pullResult, setPullResult] = useState<PullResponse | null>(null);

  // History state
  const [commits, setCommits] = useState<Commit[]>([]);

  // Diff state
  const [diffFrom, setDiffFrom] = useState('');
  const [diffTo, setDiffTo] = useState('');
  const [diffResult, setDiffResult] = useState<DiffResponse | null>(null);

  // Tab state
  const [tab, setTab] = useState<'workspaces' | 'push' | 'pull' | 'history' | 'diff'>('workspaces');

  const flash = (msg: string, isError = false) => {
    if (isError) {
      setError(msg);
      setSuccess('');
    } else {
      setSuccess(msg);
      setError('');
    }
    setTimeout(() => { setError(''); setSuccess(''); }, 4000);
  };

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await api.listWorkspaces(apiKey);
      setWorkspaces(ws);
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  }, [apiKey]);

  useEffect(() => {
    if (apiKey) loadWorkspaces();
  }, [apiKey, loadWorkspaces]);

  const createWorkspace = async () => {
    if (!newWsName || !newWsCustomer) return flash('Name and customer ID required', true);
    try {
      const ws = await api.createWorkspace(apiKey, newWsCustomer, newWsName);
      flash(`Created workspace ${ws.id}`);
      setNewWsName('');
      setNewWsCustomer('');
      loadWorkspaces();
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const deleteWorkspace = async (id: string) => {
    try {
      await api.deleteWorkspace(apiKey, id);
      flash(`Deleted workspace ${id}`);
      if (selectedWs === id) setSelectedWs('');
      loadWorkspaces();
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const doPush = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    const validFiles = pushFiles.filter((f) => f.path && f.content);
    if (!validFiles.length) return flash('Add at least one file with path and content', true);
    try {
      const result = await api.push(apiKey, selectedWs, validFiles, {
        agentId: pushAgentId || undefined,
      });
      flash(`Pushed commit ${result.commitId}`);
      setPushFiles([{ path: '', content: '' }]);
      setPushAgentId('');
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const doPull = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    try {
      const result = await api.pull(apiKey, selectedWs);
      setPullResult(result);
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const loadHistory = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    try {
      const result = await api.history(apiKey, selectedWs);
      setCommits(result.commits);
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const doDiff = async () => {
    if (!selectedWs || !diffFrom || !diffTo)
      return flash('Select workspace and both versions', true);
    try {
      const result = await api.diff(apiKey, selectedWs, diffFrom, diffTo);
      setDiffResult(result);
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  const doRollback = async (version: string) => {
    if (!selectedWs) return;
    try {
      const result = await api.rollback(apiKey, selectedWs, version);
      flash(`Rolled back — new commit ${result.commitId}`);
      loadHistory();
    } catch (e: unknown) {
      flash((e as Error).message, true);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>ContextVault</h1>
        <p className="subtitle">AI Agent Memory — Versioned Workspaces</p>
      </header>

      <div className="api-key-bar">
        <label>API Key:</label>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter API key"
        />
      </div>

      {error && <div className="alert error">{error}</div>}
      {success && <div className="alert success">{success}</div>}

      <nav className="tabs">
        {(['workspaces', 'push', 'pull', 'history', 'diff'] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {selectedWs && (
        <div className="selected-ws">
          Selected: <strong>{selectedWs}</strong>
          <button className="btn-sm" onClick={() => setSelectedWs('')}>Clear</button>
        </div>
      )}

      <main>
        {tab === 'workspaces' && (
          <section>
            <h2>Workspaces</h2>
            <div className="create-form">
              <input
                placeholder="Customer ID"
                value={newWsCustomer}
                onChange={(e) => setNewWsCustomer(e.target.value)}
              />
              <input
                placeholder="Workspace name"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
              />
              <button onClick={createWorkspace}>Create</button>
            </div>
            <div className="workspace-list">
              {workspaces.map((ws) => (
                <div
                  key={ws.id}
                  className={`workspace-card ${selectedWs === ws.id ? 'selected' : ''}`}
                  onClick={() => setSelectedWs(ws.id)}
                >
                  <div className="ws-name">{ws.name}</div>
                  <div className="ws-meta">
                    <span>{ws.id}</span>
                    <span>Customer: {ws.customerId}</span>
                    <span>Latest: {ws.latestCommitId || 'none'}</span>
                  </div>
                  <button
                    className="btn-danger btn-sm"
                    onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id); }}
                  >
                    Delete
                  </button>
                </div>
              ))}
              {!workspaces.length && <p className="empty">No workspaces yet. Create one above.</p>}
            </div>
          </section>
        )}

        {tab === 'push' && (
          <section>
            <h2>Push Files</h2>
            <div className="push-form">
              <input
                placeholder="Agent ID (optional)"
                value={pushAgentId}
                onChange={(e) => setPushAgentId(e.target.value)}
              />
              {pushFiles.map((f, i) => (
                <div key={i} className="file-entry">
                  <input
                    placeholder="File path (e.g. context/summary.md)"
                    value={f.path}
                    onChange={(e) => {
                      const files = [...pushFiles];
                      files[i] = { ...files[i], path: e.target.value };
                      setPushFiles(files);
                    }}
                  />
                  <textarea
                    placeholder="File content"
                    value={f.content}
                    onChange={(e) => {
                      const files = [...pushFiles];
                      files[i] = { ...files[i], content: e.target.value };
                      setPushFiles(files);
                    }}
                  />
                  {pushFiles.length > 1 && (
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => setPushFiles(pushFiles.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                className="btn-sm"
                onClick={() => setPushFiles([...pushFiles, { path: '', content: '' }])}
              >
                + Add File
              </button>
              <button onClick={doPush}>Push</button>
            </div>
          </section>
        )}

        {tab === 'pull' && (
          <section>
            <h2>Pull Latest</h2>
            <button onClick={doPull}>Pull Latest</button>
            {pullResult && (
              <div className="pull-result">
                <div className="commit-info">
                  <strong>Commit:</strong> {pullResult.commitId || 'none'}
                  {pullResult.createdAt && <span> | {pullResult.createdAt}</span>}
                </div>
                {pullResult.files?.map((f, i) => (
                  <div key={i} className="file-display">
                    <div className="file-path">{f.path}</div>
                    <pre>{f.content}</pre>
                  </div>
                ))}
                {(!pullResult.files || !pullResult.files.length) && (
                  <p className="empty">No files in this commit.</p>
                )}
              </div>
            )}
          </section>
        )}

        {tab === 'history' && (
          <section>
            <h2>Commit History</h2>
            <button onClick={loadHistory}>Load History</button>
            <div className="history-list">
              {commits.map((c) => (
                <div key={c.id} className="commit-card">
                  <div className="commit-id">{c.id}</div>
                  <div className="commit-meta">
                    <span>{c.createdAt}</span>
                    <span>{c.sizeBytes} bytes</span>
                    {c.parentId && <span>Parent: {c.parentId}</span>}
                  </div>
                  {c.metadata && (
                    <div className="commit-tags">
                      {Object.entries(c.metadata).map(([k, v]) => (
                        <span key={k} className="tag">{k}: {String(v)}</span>
                      ))}
                    </div>
                  )}
                  <button className="btn-sm" onClick={() => doRollback(c.id)}>
                    Rollback to this
                  </button>
                </div>
              ))}
              {!commits.length && <p className="empty">No commits yet.</p>}
            </div>
          </section>
        )}

        {tab === 'diff' && (
          <section>
            <h2>Diff</h2>
            <div className="diff-form">
              <input
                placeholder="From version (commit ID)"
                value={diffFrom}
                onChange={(e) => setDiffFrom(e.target.value)}
              />
              <input
                placeholder="To version (commit ID)"
                value={diffTo}
                onChange={(e) => setDiffTo(e.target.value)}
              />
              <button onClick={doDiff}>Compare</button>
            </div>
            {diffResult && (
              <div className="diff-result">
                <div className="diff-section added">
                  <h3>Added ({diffResult.diff.added.length})</h3>
                  {diffResult.diff.added.map((f) => <div key={f}>+ {f}</div>)}
                </div>
                <div className="diff-section removed">
                  <h3>Removed ({diffResult.diff.removed.length})</h3>
                  {diffResult.diff.removed.map((f) => <div key={f}>- {f}</div>)}
                </div>
                <div className="diff-section modified">
                  <h3>Modified ({diffResult.diff.modified.length})</h3>
                  {diffResult.diff.modified.map((f) => <div key={f}>~ {f}</div>)}
                </div>
                <div className="diff-section unchanged">
                  <h3>Unchanged ({diffResult.diff.unchanged.length})</h3>
                  {diffResult.diff.unchanged.map((f) => <div key={f}>  {f}</div>)}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
