import type { Workspace, WorkspaceFile, Commit, DiffResult, Webhook } from "../types";

let apiKey = localStorage.getItem("cv-api-key") || "";
const BASE_URL = window.location.origin;

export function setApiKey(key: string) {
  apiKey = key;
  localStorage.setItem("cv-api-key", key);
}

export function getApiKey(): string {
  return apiKey;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const data = await request<{ data: Workspace[] }>("/workspaces?limit=100");
  return data.data;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return request<Workspace>(`/workspaces/${id}`);
}

export async function getFiles(workspaceId: string, version?: string): Promise<WorkspaceFile[]> {
  const qs = version ? `?version=${version}` : "";
  const data = await request<{ files: WorkspaceFile[]; version: string }>(
    `/workspaces/${workspaceId}/pull${qs}`
  );
  return data.files;
}

export async function getHistory(workspaceId: string, limit = 50): Promise<Commit[]> {
  const data = await request<{ commits: Commit[] }>(
    `/workspaces/${workspaceId}/history?limit=${limit}`
  );
  return data.commits;
}

export async function getDiff(workspaceId: string, from: string, to: string): Promise<DiffResult> {
  return request<DiffResult>(
    `/workspaces/${workspaceId}/diff?from=${from}&to=${to}`
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
  return request(`/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}`);
}

export interface UsageStats {
  totalRequests: number;
  uniqueWorkspaces: number;
  totalStorageBytes: number;
  activeApiKeys: number;
  requestsByDay: { date: string; count: number }[];
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
