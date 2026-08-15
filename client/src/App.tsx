import { useEffect, useState } from "react";
import { CheckpointStatus } from "./CheckpointStatus.js";
import { DatabaseBrowser } from "./DatabaseBrowser.js";
import {
  createCheckpoint,
  getCatalog,
  getStatus,
  type AppStatus,
  type DatabaseCatalog,
} from "./api.js";

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [catalog, setCatalog] = useState<DatabaseCatalog | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checkpointing, setCheckpointing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getStatus()
      .then(setStatus)
      .catch((statusError: unknown) => setError(errorMessage(statusError)))
      .finally(() => setStatusLoading(false));

    void getCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        setCatalogError(null);
      })
      .catch((loadError: unknown) => setCatalogError(errorMessage(loadError)))
      .finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void getStatus()
        .then(setStatus)
        .catch((statusError: unknown) => setError(errorMessage(statusError)));
    }, 5_000);
    return () => window.clearInterval(interval);
  }, []);

  async function checkpoint() {
    setCheckpointing(true);
    setError(null);
    try {
      const durability = await createCheckpoint();
      setStatus((current) => (current ? { ...current, durability } : current));
    } catch (checkpointError) {
      setError(errorMessage(checkpointError));
    } finally {
      setCheckpointing(false);
    }
  }

  const durability = status?.durability;
  const interval = formatInterval(
    status?.configuration.checkpointIntervalMs ?? 30_000,
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="product-identity">
          <span className="product-mark" aria-hidden="true" />
          <div>
            <strong>PGlite durability lab</strong>
            <span>{catalog?.database ?? "Connecting…"}</span>
          </div>
        </div>

        <div className="header-actions">
          <CheckpointStatus
            durability={durability}
            interval={interval}
            loading={statusLoading}
            checkpointing={checkpointing}
            actionDisabled={statusLoading || !status}
            onCheckpoint={() => void checkpoint()}
          />
          <div className="identity-block" aria-label="Signed-in user">
            <span className="identity-dot" aria-hidden="true" />
            <span>{status?.user.displayName ?? "Connecting…"}</span>
          </div>
        </div>
      </header>

      <div className="context-strip">
        <span>Read-only database browser</span>
        <span>{durability?.mode ?? "checking"} · every {interval}</span>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>Request failed</span>
          {error}
        </div>
      )}

      <main className="workspace" aria-busy={statusLoading || catalogLoading}>
        <DatabaseBrowser
          catalog={catalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
        />
      </main>
    </div>
  );
}

function formatInterval(milliseconds: number): string {
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected request failure";
}
