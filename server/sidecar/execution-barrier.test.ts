import { expect, test, vi } from "vitest";
import {
  SidecarExecutionBarrier,
  createSocketDatabaseAdapter,
} from "./execution-barrier.js";

test("a checkpoint waits until a socket protocol operation releases the barrier", async () => {
  const barrier = new SidecarExecutionBarrier();
  let releaseProtocol!: () => void;
  const protocolBlocked = new Promise<void>((resolve) => {
    releaseProtocol = resolve;
  });
  const database = {
    execProtocolRawStream: vi.fn(),
  };
  const adapter = createSocketDatabaseAdapter(database, barrier);
  const events: string[] = [];

  const protocol = adapter.runExclusive(async () => {
    events.push("protocol:start");
    await protocolBlocked;
    events.push("protocol:end");
  });
  await vi.waitFor(() => expect(events).toEqual(["protocol:start"]));
  const checkpoint = barrier.runExclusive(async () => {
    events.push("checkpoint");
  });

  await Promise.resolve();
  expect(events).toEqual(["protocol:start"]);
  releaseProtocol();
  await Promise.all([protocol, checkpoint]);
  expect(events).toEqual(["protocol:start", "protocol:end", "checkpoint"]);
});

test("the socket adapter binds delegated PGlite methods to the real database", async () => {
  const barrier = new SidecarExecutionBarrier();
  const execProtocolRawStream = vi.fn(
    async (
      _message: Uint8Array,
      _options: { onRawData: (data: Uint8Array) => void },
    ) => undefined,
  );
  const database = { execProtocolRawStream, label: "database" };
  const adapter = createSocketDatabaseAdapter(database, barrier);
  const message = new Uint8Array([1, 2, 3]);
  const options = { onRawData: vi.fn() };

  await adapter.execProtocolRawStream(message, options);

  expect(execProtocolRawStream).toHaveBeenCalledWith(message, options);
  expect(adapter.label).toBe("database");
});
