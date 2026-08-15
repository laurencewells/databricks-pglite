import type { DatabaseService } from "./database.js";
import type { MutationDrain } from "./mutation-drain.js";
import type { SnapshotService } from "./snapshots/service.js";

interface ShutdownDependencies {
  database?: Pick<DatabaseService, "close">;
  mutations: Pick<MutationDrain, "quiesce">;
  snapshots?: Pick<SnapshotService, "checkpoint" | "status">;
}

export async function checkpointAndCloseDatabase({
  database,
  mutations,
  snapshots,
}: ShutdownDependencies): Promise<void> {
  try {
    await mutations.quiesce();
    while (snapshots) {
      const status = snapshots.status();
      if (!status.checkpointing && status.pendingWrites === 0) break;
      await snapshots.checkpoint();
    }
  } finally {
    await database?.close();
  }
}
