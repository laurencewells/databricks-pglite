import { useEffect, useState } from "react";
import {
  getTableRows,
  type BrowserRowsPage,
  type DatabaseCatalog,
} from "./api.js";

const PAGE_SIZE = 50;

interface SelectedTable {
  schema: string;
  table: string;
}

interface DatabaseBrowserProps {
  catalog: DatabaseCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
}

export function DatabaseBrowser({
  catalog,
  catalogLoading,
  catalogError,
}: DatabaseBrowserProps) {
  const [selectedTable, setSelectedTable] = useState<SelectedTable | null>(
    null,
  );
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BrowserRowsPage | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedTable(firstTable(catalog));
    setOffset(0);
    setPage(null);
    setRowError(null);
  }, [catalog]);

  useEffect(() => {
    if (!selectedTable) {
      setLoadingRows(false);
      return;
    }

    let cancelled = false;
    setLoadingRows(true);
    setPage(null);
    setRowError(null);

    void getTableRows(
      selectedTable.schema,
      selectedTable.table,
      PAGE_SIZE,
      offset,
    )
      .then((nextPage) => {
        if (!cancelled) setPage(nextPage);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRowError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });

    return () => {
      cancelled = true;
    };
  }, [offset, selectedTable]);

  function selectTable(schema: string, table: string) {
    setSelectedTable({ schema, table });
    setOffset(0);
    setPage(null);
    setRowError(null);
  }

  function previousPage() {
    if (!page) return;
    setOffset(Math.max(0, page.offset - PAGE_SIZE));
  }

  function nextPage() {
    if (!page) return;
    setOffset(page.offset + PAGE_SIZE);
  }

  function isSelected(schema: string, table: string) {
    return selectedTable?.schema === schema && selectedTable.table === table;
  }

  const selectedSchema = page?.schema ?? selectedTable?.schema;
  const selectedName = page?.table ?? selectedTable?.table;

  return (
    <section className="browser" aria-labelledby="browser-heading">
      <aside className="catalog-rail" aria-label="Database catalog">
        {catalog ? (
          <>
            <div className="database-node">{catalog.database}</div>
            {catalog.schemas.map((schema) => (
              <section className="schema-node" key={schema.name}>
                <h3>{schema.name}</h3>
                {schema.tables.map((table) => (
                  <button
                    type="button"
                    className={
                      isSelected(schema.name, table)
                        ? "table-node active"
                        : "table-node"
                    }
                    aria-current={
                      isSelected(schema.name, table) ? "true" : undefined
                    }
                    onClick={() => selectTable(schema.name, table)}
                    key={table}
                  >
                    {table}
                  </button>
                ))}
              </section>
            ))}
          </>
        ) : catalogError ? (
          <p className="catalog-message" role="alert">
            Could not load catalog: {catalogError}
          </p>
        ) : (
          <p className="catalog-message" role="status">
            {catalogLoading ? "Loading catalog…" : "Catalog is unavailable."}
          </p>
        )}
      </aside>

      <div className="data-sheet">
        <header className="data-sheet-heading">
          <div>
            {selectedSchema && <p className="eyebrow">{selectedSchema}</p>}
            <h2 id="browser-heading">
              {selectedName ?? "Database browser"}
            </h2>
          </div>
          {page && <span>{page.totalRows} rows</span>}
        </header>

        {rowError && (
          <p className="row-error" role="alert">
            Could not load table rows: {rowError}
          </p>
        )}

        {loadingRows && (
          <p className="data-message" role="status">
            Loading rows…
          </p>
        )}

        {!catalog && catalogError && (
          <p className="data-message" role="alert">
            Could not load catalog: {catalogError}
          </p>
        )}

        {!catalog && !catalogError && !loadingRows && !rowError && (
          <p className="data-message" role="status">
            {catalogLoading ? "Loading catalog…" : "Catalog is unavailable."}
          </p>
        )}

        {catalog && !selectedTable && !loadingRows && !rowError && (
          <p className="data-message">No user tables are available.</p>
        )}

        {page && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {page.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, rowIndex) => (
                    <tr key={`${page.offset}-${rowIndex}`}>
                      {page.columns.map((column) => (
                        <td key={column}>{formatCell(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                  {page.rows.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(page.columns.length, 1)}>
                        No rows in this table.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Table rows">
              <button
                type="button"
                disabled={page.offset === 0}
                onClick={previousPage}
              >
                Previous
              </button>
              <span>{pageRange(page)}</span>
              <button
                type="button"
                disabled={page.offset + page.rows.length >= page.totalRows}
                onClick={nextPage}
              >
                Next
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}

function firstTable(catalog: DatabaseCatalog | null): SelectedTable | null {
  if (!catalog) return null;
  for (const schema of catalog.schemas) {
    const table = schema.tables[0];
    if (table) return { schema: schema.name, table };
  }
  return null;
}

function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value) ?? "";
  }
  return String(value);
}

function pageRange(page: BrowserRowsPage): string {
  if (page.totalRows === 0) return "0–0";
  return `${page.offset + 1}–${Math.min(
    page.offset + page.rows.length,
    page.totalRows,
  )}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected request failure";
}
