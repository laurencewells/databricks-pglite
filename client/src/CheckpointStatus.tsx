import { useEffect, useRef, useState } from "react";
import type { DurabilityStatus } from "./api.js";

interface CheckpointStatusProps {
  durability: DurabilityStatus | undefined;
  interval: string;
  loading: boolean;
  checkpointing: boolean;
  actionDisabled: boolean;
  onCheckpoint: () => void;
}

export function CheckpointStatus({
  durability,
  interval,
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
            Automatic checkpoint every {interval} after writes. A crash
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
