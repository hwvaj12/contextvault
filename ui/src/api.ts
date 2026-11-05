const BASE_URL = '/workspaces';
let selectedCustomerId = '';
export function setSelectedCustomerId(customerId: string): void { selectedCustomerId = customerId.trim(); }

function headers(apiKey: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    ...(selectedCustomerId ? { 'X-ContextVault-Customer-Id': selectedCustomerId } : {}),
  };
}

export interface Workspace {
  id: string;
  customerId: string;
  name: string;
  latestCommitId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileEntry {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface Commit {
  id: string;
  workspaceId: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

export interface PullResponse {
  commitId: string | null;
  workspaceId: string;
  parentId: string | null;
  files: FileEntry[];
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

export interface DiffResponse {
  from: string;
  to: string;
  files: { path: string; status: 'added' | 'deleted' | 'modified' }[];
  summary: { filesChanged: number };
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `HTTP ${res.status}`);
  }
  return res.status === 204 ? undefined as T : res.json();
}

export const api = {
  listWorkspaces: (apiKey: string) =>
    fetch(BASE_URL, { headers: headers(apiKey) }).then((r) => handleResponse<{ data: Workspace[] }>(r)).then(result => result.data),

  createWorkspace: (apiKey: string, customerId: string, name: string) =>
    fetch(BASE_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ customerId, name }),
    }).then((r) => handleResponse<Workspace>(r)),

  getWorkspace: (apiKey: string, id: string) =>
    fetch(`${BASE_URL}/${id}`, { headers: headers(apiKey) }).then((r) =>
      handleResponse<Workspace>(r)
    ),

  deleteWorkspace: (apiKey: string, id: string) =>
    fetch(`${BASE_URL}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(apiKey),
      body: JSON.stringify({}),
    }).then((r) => handleResponse<void>(r)),

  push: (apiKey: string, workspaceId: string, files: FileEntry[], metadata?: Record<string, unknown>) =>
    fetch(`${BASE_URL}/${workspaceId}/push`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ files, metadata: metadata || {} }),
    }).then((r) => handleResponse<{ commitId: string }>(r)),

  pull: (apiKey: string, workspaceId: string, version?: string) => {
    const url = version
      ? `${BASE_URL}/${workspaceId}/pull?version=${version}`
      : `${BASE_URL}/${workspaceId}/pull`;
    return fetch(url, { headers: headers(apiKey) }).then((r) => handleResponse<PullResponse>(r));
  },

  history: (apiKey: string, workspaceId: string) =>
    fetch(`${BASE_URL}/${workspaceId}/history`, { headers: headers(apiKey) }).then((r) =>
      handleResponse<{ commits: Commit[]; count: number }>(r)
    ),

  diff: (apiKey: string, workspaceId: string, from: string, to: string) =>
    fetch(`${BASE_URL}/${encodeURIComponent(workspaceId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      headers: headers(apiKey),
    }).then((r) => handleResponse<DiffResponse>(r)),

  rollback: (apiKey: string, workspaceId: string, toVersion: string) =>
    fetch(`${BASE_URL}/${workspaceId}/rollback`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ toVersion }),
    }).then((r) => handleResponse<{ commitId: string }>(r)),
};
