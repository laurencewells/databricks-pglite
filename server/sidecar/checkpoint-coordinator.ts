import type { PGlite } from "@electric-sql/pglite";
import type { SidecarExecutionBarrier } from "./execution-barrier.js";

interface CoordinatedSnapshots {
  markDirty(): void;
  checkpoint(): Promise<unknown>;
  status(): { pendingWrites: number };
}

type WalDatabase = Pick<PGlite, "isInTransaction" | "query">;

export class CheckpointCoordinator {
  #lastWalLsn: string | undefined;

  constructor(
    private readonly database: WalDatabase,
    private readonly snapshots: CoordinatedSnapshots,
    private readonly barrier: SidecarExecutionBarrier,
  ) {}

  captureWritesAndCheckpoint(): Promise<boolean> {
    return this.barrier.runExclusive(async () => {
      if (this.database.isInTransaction()) return false;

      const result = await this.database.query<{ lsn: string }>(
        "select pg_current_wal_lsn()::text as lsn",
      );
      const currentWalLsn = result.rows[0]?.lsn;
      if (!currentWalLsn) {
        throw new Error("PGlite did not return a WAL position");
      }
      if (this.#lastWalLsn === undefined) {
        this.#lastWalLsn = currentWalLsn;
        if (this.snapshots.status().pendingWrites === 0) return false;
      }
      const walChanged = currentWalLsn !== this.#lastWalLsn;
      if (!walChanged && this.snapshots.status().pendingWrites === 0) {
        return false;
      }

      if (walChanged && this.snapshots.status().pendingWrites === 0) {
        this.snapshots.markDirty();
      }
      await this.snapshots.checkpoint();
      this.#lastWalLsn = currentWalLsn;
      return true;
    });
  }
}
