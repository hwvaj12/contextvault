import { useState, useEffect, useCallback, useRef } from 'react';
import { api, setSelectedCustomerId, type Workspace, type PullResponse, type Commit, type DiffResponse } from './api';
import './App.css';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [administratorCustomer, setAdministratorCustomer] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const contextVersion = useRef(0);
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

  const clearWorkspaceData = () => {
    setPullResult(null);
    setCommits([]);
    setDiffFrom('');
    setDiffTo('');
    setDiffResult(null);
    setPushFiles([{ path: '', content: '' }]);
    setPushAgentId('');
  };

  const clearTenantState = () => {
    contextVersion.current++;
    setWorkspaces([]);
    setSelectedWs('');
    setNewWsName('');
    setNewWsCustomer('');
    setError('');
    setSuccess('');
    setLoadingWorkspaces(false);
    setTab('workspaces');
    clearWorkspaceData();
  };

  const changeApiKey = (value: string) => {
    clearTenantState();
    setSelectedCustomerId('');
    setAdministratorCustomer('');
    setApiKey(value);
  };

  const changeAdministratorCustomer = (value: string) => {
    clearTenantState();
    setSelectedCustomerId(value);
    setAdministratorCustomer(value);
  };

  const selectWorkspace = (id: string) => {
    contextVersion.current++;
    clearWorkspaceData();
    setError('');
    setSuccess('');
    setLoadingWorkspaces(false);
    setSelectedWs(id);
  };

  const flash = useCallback((msg: string, isError = false, generation = contextVersion.current) => {
    if (generation !== contextVersion.current) return;
    if (isError) {
      setError(msg);
      setSuccess('');
    } else {
      setSuccess(msg);
      setError('');
      setTimeout(() => { if (generation === contextVersion.current) setSuccess(''); }, 4000);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const generation = contextVersion.current;
    setSelectedCustomerId(administratorCustomer);
    setLoadingWorkspaces(true);
    setError('');
    try {
      const ws = await api.listWorkspaces(apiKey);
      if (generation !== contextVersion.current) return;
      setWorkspaces(ws);
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    } finally {
      if (generation === contextVersion.current) setLoadingWorkspaces(false);
    }
  }, [apiKey, administratorCustomer, flash]);

  useEffect(() => {
    if (apiKey) void loadWorkspaces();
  }, [apiKey, loadWorkspaces]);

  useEffect(() => () => {
    contextVersion.current++;
    setSelectedCustomerId('');
  }, []);

  const createWorkspace = async () => {
    const customerId = administratorCustomer.trim() || newWsCustomer.trim();
    if (!newWsName || !customerId) return flash('Name and customer ID required', true);
    const generation = contextVersion.current;
    try {
      const ws = await api.createWorkspace(apiKey, customerId, newWsName);
      if (generation !== contextVersion.current) return;
      flash(`Created workspace ${ws.id}`);
      setNewWsName('');
      setNewWsCustomer('');
      void loadWorkspaces();
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const deleteWorkspace = async (id: string) => {
    const generation = contextVersion.current;
    try {
      await api.deleteWorkspace(apiKey, id);
      if (generation !== contextVersion.current) return;
      if (selectedWs === id) selectWorkspace('');
      flash(`Deleted workspace ${id}`);
      void loadWorkspaces();
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const doPush = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    const validFiles = pushFiles.filter((f) => f.path && f.content);
    if (!validFiles.length) return flash('Add at least one file with path and content', true);
    const generation = contextVersion.current;
    try {
      const result = await api.push(apiKey, selectedWs, validFiles, {
        agentId: pushAgentId || undefined,
      });
      if (generation !== contextVersion.current) return;
      flash(`Pushed commit ${result.commitId}`);
      setPushFiles([{ path: '', content: '' }]);
      setPushAgentId('');
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const doPull = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    const generation = contextVersion.current;
    try {
      const result = await api.pull(apiKey, selectedWs);
      if (generation !== contextVersion.current) return;
      setPullResult(result);
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const loadHistory = async () => {
    if (!selectedWs) return flash('Select a workspace first', true);
    const generation = contextVersion.current;
    try {
      const result = await api.history(apiKey, selectedWs);
      if (generation !== contextVersion.current) return;
      setCommits(result.commits);
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const doDiff = async () => {
    if (!selectedWs || !diffFrom || !diffTo)
      return flash('Select workspace and both versions', true);
    const generation = contextVersion.current;
    try {
      const result = await api.diff(apiKey, selectedWs, diffFrom, diffTo);
      if (generation !== contextVersion.current) return;
      setDiffResult(result);
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  const doRollback = async (version: string) => {
    if (!selectedWs) return;
    const generation = contextVersion.current;
    try {
      const result = await api.rollback(apiKey, selectedWs, version);
      if (generation !== contextVersion.current) return;
      flash(`Rolled back — new commit ${result.commitId}`);
      void loadHistory();
    } catch (e: unknown) {
      flash((e as Error).message, true, generation);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>ContextVault</h1>
        <p className="subtitle">AI Agent Memory — Versioned Workspaces</p>
      </header>

      <div className="api-key-bar">
        <label htmlFor="secondary-api-key">API key:</label>
        <input
          id="secondary-api-key"
          type={showApiKey ? 'text' : 'password'}
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => changeApiKey(e.target.value)}
          placeholder="Enter API key"
        />
        <button type="button" aria-pressed={showApiKey} onClick={() => setShowApiKey(!showApiKey)}>
          {showApiKey ? 'Hide API key' : 'Show API key'}
        </button>
      </div>
      <div className="api-key-bar">
        <label htmlFor="administrator-customer">Administrator customer ID (optional):</label>
        <input
          id="administrator-customer"
          value={administratorCustomer}
          onChange={(e) => changeAdministratorCustomer(e.target.value)}
          placeholder="Leave blank for customer keys"
          aria-describedby="administrator-customer-help"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="button" disabled={!apiKey || loadingWorkspaces} onClick={() => void loadWorkspaces()}>
          {loadingWorkspaces ? 'Loading…' : 'Load workspaces'}
        </button>
      </div>
      <p id="administrator-customer-help" className="subtitle">Administrators: enter a customer ID. Customer keys: leave this field blank.</p>

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
          <button className="btn-sm" onClick={() => selectWorkspace('')}>Clear</button>
        </div>
      )}

      <main>
        {tab === 'workspaces' && (
          <section>
            <h2>Workspaces</h2>
            <div className="create-form">
              <input
                placeholder="Customer ID"
                aria-label="Workspace customer ID"
                value={administratorCustomer.trim() || newWsCustomer}
                readOnly={Boolean(administratorCustomer.trim())}
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
                  onClick={() => selectWorkspace(ws.id)}
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
              {!apiKey && <p className="empty">Enter an API key to load your workspaces.</p>}
              {loadingWorkspaces && <p className="empty" role="status">Loading workspaces…</p>}
              {apiKey && !loadingWorkspaces && !error && !workspaces.length && <p className="empty">No workspaces yet. Create one above.</p>}
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
                    {f.encoding === 'base64' && <p className="subtitle">Binary file (base64)</p>}
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
                {(['added', 'deleted', 'modified'] as const).map((status) => {
                  const files = diffResult.files.filter((file) => file.status === status);
                  const label = status === 'added' ? 'Added' : status === 'deleted' ? 'Removed' : 'Modified';
                  const symbol = status === 'added' ? '+' : status === 'deleted' ? '-' : '~';
                  return (
                    <div key={status} className={`diff-section ${status === 'deleted' ? 'removed' : status}`}>
                      <h3>{label} ({files.length})</h3>
                      {files.map((file) => <div key={file.path}>{symbol} {file.path}</div>)}
                    </div>
                  );
                })}
                <p className="subtitle">Only changed files are shown.</p>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
