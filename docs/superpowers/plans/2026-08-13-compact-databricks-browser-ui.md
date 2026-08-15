# Compact Databricks-style Database Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized hero and durability sidebar with a compact Databricks-style checkpoint header so the read-only table explorer spans the workspace.

**Architecture:** `App` keeps ownership of status polling, checkpoint requests, global errors, and catalog loading. A new presentational `CheckpointStatus` component owns only disclosure state and renders existing durability data; `DatabaseBrowser` keeps all row-loading and navigation behavior. The redesign changes client markup and CSS only, leaving every API and backend lifecycle untouched.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, plain CSS, Vitest backend suite, Databricks Asset Bundles.

## Global Constraints

- This is a frontend-only change; do not change browser APIs, persistence, checkpoint lifecycle, the 30-second default interval, rolling retention, authentication, or `WEB_UI_ENABLED`.
- Keep the browser read-only; do not add SQL input or database mutation controls.
- Keep frontend component tests absent, as required by `AGENTS.md`; use type checking, production builds, existing backend tests, and browser checks.
- Keep status and catalog loading independent and preserve five-second status polling.
- Use Databricks red `#ff3621` only for the product mark, primary checkpoint action, and critical emphasis.
- Preserve keyboard focus, disclosure semantics, responsive wrapping, and readable contrast.

---

## File Structure

- Create `client/src/CheckpointStatus.tsx`: checkpoint summary, action, and accessible details disclosure.
- Modify `client/src/App.tsx`: replace hero/ledger markup with compact application header and context strip; keep request ownership unchanged.
- Modify `client/src/styles.css`: replace the editorial visual system with compact Databricks product styling and make the explorer full width.
- Keep `client/src/DatabaseBrowser.tsx` behavior and public props unchanged; its existing semantic catalog, table, and pagination markup is sufficient for the new CSS.

### Task 1: Compact Header and Checkpoint Disclosure

**Files:**
- Create: `client/src/CheckpointStatus.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `DurabilityStatus` from `client/src/api.ts`; existing `checkpoint(): Promise<void>` callback owned by `App`.
- Produces: `CheckpointStatus(props: CheckpointStatusProps): JSX.Element`, where props are `durability`, `intervalSeconds`, `loading`, `checkpointing`, `actionDisabled`, and `onCheckpoint`.

- [ ] **Step 1: Establish a clean client baseline**

Run:

```bash
npm run typecheck
npm run build:client
```

Expected: both commands exit 0 before client markup changes.

- [ ] **Step 2: Create the focused checkpoint status component**

Create `client/src/CheckpointStatus.tsx` with this public interface and state boundary:

```tsx
import { useEffect, useRef, useState } from "react";
import type { DurabilityStatus } from "./api.js";

interface CheckpointStatusProps {
  durability: DurabilityStatus | undefined;
  intervalSeconds: number;
  loading: boolean;
  checkpointing: boolean;
  actionDisabled: boolean;
  onCheckpoint: () => void;
}

export function CheckpointStatus({
  durability,
  intervalSeconds,
  loading,
  checkpointing,
  actionDisabled,
  onCheckpoint,
}: CheckpointStatusProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingWrites = durability?.pendingWrites ?? 0;

  useEffect(() => {
    if (!open) return;

    function closeOutside(event: Event) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const summary = loading
    ? "Checking durability…"
    : !durability
      ? "Durability unavailable"
      : pendingWrites > 0
        ? `${pendingWrites} local ${pendingWrites === 1 ? "change" : "changes"}`
        : "All changes checkpointed";
  const statusKind = loading || !durability
    ? "unknown"
    : pendingWrites > 0
      ? "pending"
      : "healthy";

  return (
    <div className="checkpoint-control" ref={rootRef}>
      <button
        ref={triggerRef}
        className="checkpoint-summary"
        type="button"
        aria-expanded={open}
        aria-controls="checkpoint-details"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`status-dot ${statusKind}`} aria-hidden="true" />
        <span>
          <strong>{summary}</strong>
          <small>{formatCheckpointTime(durability?.lastCheckpointAt)}</small>
        </span>
      </button>

      {open && (
        <div className="checkpoint-popover" id="checkpoint-details">
          <dl>
            <div>
              <dt>Mode</dt>
              <dd>{durability?.mode ?? "Not available"}</dd>
            </div>
            <div>
              <dt>Pending writes</dt>
              <dd>{durability?.pendingWrites ?? "Not available"}</dd>
            </div>
            <div>
              <dt>Last checkpoint</dt>
              <dd>{formatCheckpointTime(durability?.lastCheckpointAt)}</dd>
            </div>
            <div>
              <dt>Archive</dt>
              <dd>
                {durability?.lastArchive
                  ? basename(durability.lastArchive)
                  : "Not available"}
              </dd>
            </div>
          </dl>
          <p>
            Automatic checkpoint every {intervalSeconds}s after writes. A crash
            can discard changes not yet checkpointed. Volume archives never
            contain live PostgreSQL files.
          </p>
        </div>
      )}

      <button
        className="checkpoint-button"
        type="button"
        onClick={onCheckpoint}
        disabled={checkpointing || actionDisabled}
      >
        {checkpointing ? "Checkpointing…" : "Checkpoint now"}
      </button>
    </div>
  );
}

function formatCheckpointTime(value: string | null | undefined): string {
  if (!value) return "Not checkpointed yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
```

Unavailable values render `Not available` or `Not checkpointed yet`, and the `unknown` status dot uses a neutral color so a missing status can never imply durability.

- [ ] **Step 3: Replace the hero and durability ledger in `App`**

Import `CheckpointStatus`, delete the ledger markup and the now-duplicated `formatTimestamp`/`basename` helpers, and render this structure while leaving both effects and `checkpoint()` unchanged:

```tsx
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
        intervalSeconds={intervalSeconds}
        loading={statusLoading}
        checkpointing={checkpointing}
        actionDisabled={statusLoading || catalogLoading}
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
    <span>{durability?.mode ?? "checking"} · every {intervalSeconds}s</span>
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
```

- [ ] **Step 4: Verify the component boundary and production compilation**

Run:

```bash
npm run typecheck
npm run build:client
```

Expected: both commands exit 0; there are no unused ledger helpers or type errors.

- [ ] **Step 5: Commit the semantic layout change**

```bash
git add client/src/App.tsx client/src/CheckpointStatus.tsx
git -c commit.gpgsign=false commit -m "feat: move checkpoint controls into app header"
```

### Task 2: Databricks Product Styling and Full-width Explorer

**Files:**
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: class names introduced by `App` and `CheckpointStatus`; existing `DatabaseBrowser` class names.
- Produces: responsive desktop and narrow-width layouts without changing component behavior.

- [ ] **Step 1: Replace the editorial design tokens and page background**

Use this token foundation and remove the decorative grid, Rockwell display font, mineral/cyan/oxide palette, oversized `h1`, and two-column workspace rules:

```css
:root {
  color: #1f272d;
  background: #f5f6f7;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  --surface: #ffffff;
  --surface-muted: #f5f6f7;
  --surface-selected: #e8f1ff;
  --ink: #1f272d;
  --muted: #5f6b73;
  --rule: #d9dde0;
  --brand: #ff3621;
  --success: #00875a;
  --warning: #c2410c;
  --focus: #2272b4;
  --utility: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background: var(--surface-muted);
}

.app-shell {
  width: min(1480px, 100%);
  margin: 0 auto;
  padding: 20px clamp(16px, 2.5vw, 36px) 36px;
}

.workspace {
  display: block;
  min-width: 0;
}
```

- [ ] **Step 2: Style the compact header, disclosure, and context strip**

Implement the following geometry, with all existing focus-visible and disabled states preserved:

```css
.app-header,
.header-actions,
.checkpoint-control,
.checkpoint-summary,
.product-identity,
.identity-block,
.context-strip {
  display: flex;
  align-items: center;
}

.app-header {
  position: relative;
  z-index: 2;
  min-height: 56px;
  justify-content: space-between;
  gap: 24px;
  padding: 8px 12px;
  border: 1px solid var(--rule);
  background: var(--surface);
}

.product-mark {
  width: 9px;
  height: 25px;
  border-radius: 1px;
  background: var(--brand);
  transform: skew(-13deg);
}

.checkpoint-control { position: relative; gap: 8px; }
.checkpoint-summary { border: 0; background: transparent; color: var(--ink); }
.checkpoint-button { background: var(--brand); color: #fff; }
.checkpoint-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  width: min(360px, calc(100vw - 32px));
  padding: 18px;
  border: 1px solid var(--rule);
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 12px 30px rgba(31, 39, 45, 0.16);
}

.context-strip {
  justify-content: space-between;
  gap: 16px;
  padding: 7px 12px;
  border: 1px solid var(--rule);
  border-top: 0;
  background: var(--surface-muted);
  color: var(--muted);
}
```

Add the remaining header typography, detail rows, status colors, hover states, and error treatment exactly as follows:

```css
.product-identity,
.header-actions,
.checkpoint-summary,
.identity-block { gap: 10px; }

.product-identity > div,
.checkpoint-summary > span:last-child {
  display: grid;
  gap: 2px;
}

.product-identity strong,
.checkpoint-summary strong { font-size: 0.8125rem; font-weight: 600; }
.product-identity span,
.checkpoint-summary small,
.identity-block,
.context-strip { font-size: 0.75rem; color: var(--muted); }

.status-dot,
.identity-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.status-dot.healthy,
.identity-dot { background: var(--success); }
.status-dot.pending { background: var(--warning); }
.status-dot.unknown { background: #87929a; }

.checkpoint-summary,
.checkpoint-button { min-height: 34px; cursor: pointer; border-radius: 4px; }
.checkpoint-summary { padding: 4px 6px; text-align: left; }
.checkpoint-summary:hover { background: var(--surface-muted); }
.checkpoint-button { padding: 7px 12px; border: 1px solid var(--brand); font-size: 0.75rem; font-weight: 600; }
.checkpoint-button:not(:disabled):hover { background: #d92b1a; border-color: #d92b1a; }

.checkpoint-popover dl { margin: 0; }
.checkpoint-popover dl > div {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--rule);
}
.checkpoint-popover dt { color: var(--muted); font-size: 0.75rem; }
.checkpoint-popover dd { margin: 0; overflow-wrap: anywhere; font-family: var(--utility); font-size: 0.75rem; }
.checkpoint-popover p { margin: 14px 0 0; color: var(--muted); font-size: 0.8125rem; line-height: 1.45; }

.error-banner {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 14px;
  margin: 12px 0;
  padding: 11px 12px;
  border: 1px solid #f0aaa1;
  border-left: 4px solid var(--brand);
  border-radius: 4px;
  background: #fff2f0;
  font-size: 0.8125rem;
}
```

- [ ] **Step 3: Expand and densify the existing browser**

Retain `.browser` as a two-column catalog/table grid, but make it the single full-width workspace surface:

```css
.browser {
  display: grid;
  grid-template-columns: clamp(180px, 18vw, 250px) minmax(0, 1fr);
  min-width: 0;
  border: 1px solid var(--rule);
  border-top: 0;
  background: var(--surface);
}

.catalog-rail {
  min-width: 0;
  padding: 14px 10px;
  border-right: 1px solid var(--rule);
  background: var(--surface-muted);
}

.table-node.active {
  border-left-color: #2272b4;
  background: var(--surface-selected);
  color: #174ea6;
  font-weight: 600;
}

.data-sheet-heading {
  min-height: 62px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

th { background: var(--surface-muted); }
tbody tr:nth-child(even) { background: #fafbfc; }
```

Remove every `.ledger`, `.timeline`, `.masthead`, large `h1`, decorative animation, and sticky-sidebar rule. Keep horizontal table scrolling, pagination, loading, empty, and error states. Use subtle borders and no card shadow around the data surface.

- [ ] **Step 4: Add narrow-width behavior**

At `max-width: 760px`, wrap the header, put checkpoint controls on their own row, align the popover to the viewport-safe left edge, and narrow the catalog rail:

```css
@media (max-width: 760px) {
  .app-shell { padding: 10px 8px 24px; }
  .app-header { align-items: flex-start; flex-direction: column; gap: 10px; }
  .header-actions { width: 100%; flex-wrap: wrap; justify-content: space-between; }
  .checkpoint-control { order: 2; width: 100%; justify-content: space-between; }
  .checkpoint-popover { left: 0; right: auto; }
  .context-strip { align-items: flex-start; flex-direction: column; gap: 3px; }
  .browser { grid-template-columns: minmax(120px, 34vw) minmax(0, 1fr); }
}
```

- [ ] **Step 5: Verify styling compiles and commit it**

Run:

```bash
npm run typecheck
npm run build:client
git diff --check
```

Expected: all commands exit 0.

Then commit:

```bash
git add client/src/styles.css
git -c commit.gpgsign=false commit -m "style: adopt compact Databricks browser layout"
```

### Task 3: Acceptance Verification and Development Deployment

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: completed client build and existing Databricks bundle target `dev` with profile `ps`.
- Produces: evidence that the redesign works locally and in the development app without backend regression.

- [ ] **Step 1: Run the full lightweight repository gate**

Run:

```bash
make test
make validate PROFILE=ps TARGET=dev
```

Expected: Vitest, TypeScript, server/client builds, and bundle validation all exit 0.

- [ ] **Step 2: Inspect the UI locally at desktop and narrow widths**

Start the development app in a long-running terminal session:

```bash
make local PORT=8000
```

Open `http://localhost:8000` with the in-app browser and capture screenshots near 1440px and 390px widths. Verify:

- No hero or right-hand ledger remains.
- The table occupies all space to the right of the catalog rail.
- Header status opens and closes by click, Escape, and focus movement.
- The popover shows mode, pending writes, timestamp, archive filename, interval, and recovery explanation.
- Checkpoint action retains loading/disabled behavior and surfaces failures in the global banner.
- Catalog selection, table rows, horizontal scrolling, and pagination still work.
- Focus rings, text contrast, and mobile wrapping remain readable.

- [ ] **Step 3: Deploy the approved build to development**

Run:

```bash
make deploy-run PROFILE=ps TARGET=dev
```

Expected: bundle deployment succeeds and `pglite-durability-lab-dev` reaches `RUNNING`.

- [ ] **Step 4: Smoke-test the live app**

Open the deployed app from:

```bash
make app-url PROFILE=ps
```

Repeat the desktop interaction check, trigger one manual checkpoint, and confirm the header updates to the returned checkpoint timestamp without changing table data. Capture the final live screenshot and record the deployment status, test count, build result, and live checkpoint result in the handoff.
