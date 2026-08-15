export interface DurabilityStatus {
  mode: string;
  pendingWrites: number;
  checkpointing: boolean;
  lastCheckpointAt: string | null;
  lastArchive: string | null;
  restoredFrom: string | null;
}

export interface DatabaseCatalog {
  database: string;
  schemas: Array<{ name: string; tables: string[] }>;
}

export interface BrowserRowsPage {
  schema: string;
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  limit: number;
  offset: number;
}

export interface AppStatus {
  user: { id: string; displayName: string };
  durability: DurabilityStatus;
  configuration: { checkpointIntervalMs: number };
}

export async function getStatus(): Promise<AppStatus> {
  return requestJson<AppStatus>("/api/app/status");
}

export function getCatalog(): Promise<DatabaseCatalog> {
  return requestJson<DatabaseCatalog>("/api/browser/catalog");
}

export function getTableRows(
  schema: string,
  table: string,
  limit = 50,
  offset = 0,
): Promise<BrowserRowsPage> {
  const query = new URLSearchParams({
    schema,
    table,
    limit: String(limit),
    offset: String(offset),
  });
  return requestJson<BrowserRowsPage>(`/api/browser/rows?${query}`);
}

export async function createCheckpoint(): Promise<DurabilityStatus> {
  const response = await requestJson<{ durability: DurabilityStatus }>(
    "/api/checkpoints",
    { method: "POST" },
  );
  return response.durability;
}

async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, options);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
