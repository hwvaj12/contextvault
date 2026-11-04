import type { Workspace, WorkspaceFile, Commit, DiffResult, Webhook } from "../types";

let apiKey = localStorage.getItem("cv-api-key") || "";
let selectedCustomerId = localStorage.getItem("cv-selected-customer-id") || "";
const BASE_URL = window.location.origin;

export function setApiKey(key: string) {
  if (key !== apiKey) setSelectedCustomerId("");
  apiKey = key;
  localStorage.setItem("cv-api-key", key);
}
export function setSelectedCustomerId(customerId: string) {
  selectedCustomerId = customerId.trim();
  if (selectedCustomerId) localStorage.setItem("cv-selected-customer-id", selectedCustomerId);
  else localStorage.removeItem("cv-selected-customer-id");
}
export function getSelectedCustomerId(): string { return selectedCustomerId; }

export function getApiKey(): string {
  return apiKey;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-API-Key": apiKey,
      ...(selectedCustomerId ? { "X-ContextVault-Customer-Id": selectedCustomerId } : {}),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.status === 204 ? undefined as T : res.json();
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const data = await request<{ data: Workspace[] }>("/workspaces?limit=100");
  return data.data;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return request<Workspace>(`/workspaces/${encodeURIComponent(id)}`);
}

export async function getFiles(workspaceId: string, version?: string): Promise<WorkspaceFile[]> {
  const qs = version ? `?version=${encodeURIComponent(version)}` : "";
  const data = await request<{ files: WorkspaceFile[]; version: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/pull${qs}`
  );
  return data.files;
}

export async function getHistory(workspaceId: string, limit = 50): Promise<Commit[]> {
  const data = await request<{ revisions: { id: string; parentRevisionId: string | null; createdAt: string }[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/revisions?limit=${limit}`
  );
  return data.revisions.map(revision => ({ id: revision.id, parentId: revision.parentRevisionId, createdAt: revision.createdAt }));
}

export async function getDiff(workspaceId: string, from: string, to: string): Promise<DiffResult> {
  return request<DiffResult>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );
}

export interface SearchResult {
  path: string;
  snippet: string;
  lineNumber: number;
}

export async function searchFiles(
  workspaceId: string,
  query: string
): Promise<{ query: string; results: SearchResult[]; count: number }> {
  return request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/search?q=${encodeURIComponent(query)}`);
}

export interface UsageStats {
  totalRequests: null;
  uniqueWorkspaces: number;
  totalStorageBytes: null;
  activeApiKeys: null;
  requestsByDay: null;
  recordedActions: number | null;
  logicalAcceptedBytes: number | null;
  recordedActionsByDay: { date: string; count: number }[];
  measurementComplete: boolean;
  metricsUnavailable: string[];
}

export async function getUsageStats(period: string = "7d"): Promise<UsageStats> {
  return request<UsageStats>(`/analytics/usage?period=${period}`);
}

export async function listWebhooksApi(customerId: string): Promise<Webhook[]> {
  const data = await request<{ data: Webhook[] }>(`/webhooks?customerId=${encodeURIComponent(customerId)}`);
  return data.data;
}

export async function createWebhook(customerId: string, url: string, events: string[]): Promise<Webhook> {
  return request<Webhook>("/webhooks", {
    method: "POST",
    body: JSON.stringify({ customerId, url, events }),
  });
}

export async function deleteWebhookApi(id: string): Promise<void> {
  await request<void>(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
