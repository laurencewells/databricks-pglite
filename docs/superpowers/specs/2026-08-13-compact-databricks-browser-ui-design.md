# Compact Databricks-style database browser design

## Goal

Make the read-only database browser the dominant surface. Remove the oversized editorial hero and the separate durability ledger so table data can use the full workspace width, while preserving every checkpoint control and status detail.

## Scope

This is a frontend-only layout and styling change. It does not change browser APIs, checkpoint behavior, archive retention, authentication, or the `WEB_UI_ENABLED` setting.

## Layout

Replace the current masthead and two-column browser/ledger workspace with:

1. A compact application header containing the PGlite durability lab identity, connected database, signed-in user, checkpoint status, last checkpoint time, and **Checkpoint now** action.
2. A narrow context strip identifying the read-only database browser and showing checkpoint mode and configured interval.
3. One full-width explorer containing the existing catalog rail and data table.

The catalog rail keeps a stable compact width. The table takes all remaining horizontal space and preserves horizontal scrolling when its columns exceed the viewport. On small screens, header groups wrap without obscuring actions or status.

## Checkpoint status and details

The header shows a concise checkpoint summary:

- Pending writes: indicate that local changes are waiting to be checkpointed.
- No pending writes: show that all changes are checkpointed.
- Last checkpoint: show its formatted time when available.
- Checkpoint action: retain the current loading and disabled behavior.

The summary is a keyboard-accessible disclosure control. Activating it opens a small anchored popover with the durability mode, pending-write count, last checkpoint timestamp, archive filename, configured automatic interval, and recovery-window explanation previously shown in the ledger. Activating it again, pressing Escape, or moving focus outside closes the popover.

Checkpoint request failures continue to use the global error banner. Status-loading and unknown-status states use neutral labels and never imply data is durable before the status response confirms it.

## Visual direction

Use Databricks product UI as the reference rather than a marketing page:

- White and cool neutral-gray surfaces with fine borders and minimal shadow.
- Dark graphite text, muted secondary labels, and accessible green for confirmed healthy status.
- Databricks red (`#ff3621`) reserved for the product mark, primary checkpoint action, and critical emphasis.
- Compact system sans-serif typography for interface text and monospace only for data values and identifiers.
- Dense table chrome, subtle blue selected-table state, modest corner radii, and no decorative grid background.

The signature element is a small red slanted product mark beside the application name. It provides visual identity without competing with the data.

## Component boundaries

`App` continues to own status polling, checkpoint requests, errors, and catalog loading. It renders the compact header and passes catalog state to `DatabaseBrowser` as it does today.

The checkpoint-detail disclosure is a focused presentational component driven entirely by the existing `AppStatus` and checkpointing state. It issues no requests and owns only its open/closed interaction state.

`DatabaseBrowser` keeps its selection, row loading, pagination, and error behavior. Its markup changes only where needed to support the wider, denser explorer layout.

## Data flow and behavior

- Initial status and catalog requests remain independent.
- Status polling remains every five seconds.
- Manual checkpointing continues through the existing API and updates the status state from the response.
- Read-only catalog and row requests remain unchanged.
- No frontend control accepts SQL or mutates database content.

## Accessibility

- Preserve visible keyboard focus.
- Give the status disclosure an expanded state and a clear accessible label.
- Keep the checkpoint action a native button with meaningful disabled text while checkpointing.
- Ensure popover content is reachable by keyboard and dismissal does not trap focus.
- Maintain readable contrast for status, muted text, selections, and errors.

## Verification

Frontend component tests remain intentionally absent. Verify the change with:

1. TypeScript type checking.
2. Production client build and bundle validation.
3. Existing lightweight backend test suite to catch integration regressions.
4. Browser screenshots at desktop and narrow widths.
5. Manual browser checks for catalog selection, pagination, status disclosure, checkpoint success/failure states, keyboard focus, and responsive wrapping.

## Non-goals

- No backend, API, persistence, checkpoint lifecycle, interval, or retention changes.
- No editable database UI, SQL console, search, sorting, filtering, or schema management.
- No new frontend test framework.
