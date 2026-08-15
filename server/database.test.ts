import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseService } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "pglite-db-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("DatabaseService", () => {
  test("executes parameterized portable reads without marking the database dirty", async () => {
    const onWrite = vi.fn();
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      onWrite,
    });

    const result = await database.query<{ answer: number; label: string }>(
      "SELECT $1::int AS answer, $2::text AS label",
      [42, "portable"],
    );
    await database.close();

    expect(result).toEqual({
      rows: [{ answer: 42, label: "portable" }],
      rowCount: 1,
    });
    expect(onWrite).not.toHaveBeenCalled();
  });

  test("marks DML and DDL queries dirty", async () => {
    const onWrite = vi.fn();
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      onWrite,
    });

    await database.query("CREATE TABLE mutation_sample (id integer PRIMARY KEY)");
    expect(onWrite).toHaveBeenCalledTimes(1);

    await database.query("INSERT INTO mutation_sample (id) VALUES ($1)", [1]);
    expect(onWrite).toHaveBeenCalledTimes(2);

    await database.query("ALTER TABLE mutation_sample ADD COLUMN label text");
    expect(onWrite).toHaveBeenCalledTimes(3);

    const writableCte = await database.query<{ id: number }>(`
      WITH inserted AS (
        INSERT INTO mutation_sample (id, label) VALUES (2, 'cte')
        RETURNING id
      )
      SELECT id FROM inserted
    `);
    expect(writableCte.rows).toEqual([{ id: 2 }]);
    expect(onWrite).toHaveBeenCalledTimes(4);

    await database.close();
  });

  test("does not mark failed queries dirty", async () => {
    const onWrite = vi.fn();
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      onWrite,
    });

    await expect(database.query("SELECT * FROM missing_table")).rejects.toThrow();
    await database.close();

    expect(onWrite).not.toHaveBeenCalled();
  });

  test("serializes read-only queries without marking the database dirty", async () => {
    const onWrite = vi.fn();
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      onWrite,
    });

    const result = await database.read<{ answer: number }>(
      "SELECT 42::int AS answer",
    );
    await database.close();

    expect(result).toEqual({ rows: [{ answer: 42 }], rowCount: 1 });
    expect(onWrite).not.toHaveBeenCalled();
  });

  test("holds related reads in a repeatable-read transaction without marking the database dirty", async () => {
    const onWrite = vi.fn();
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      onWrite,
    });
    await database.query("CREATE TABLE transaction_sample (id integer PRIMARY KEY)");
    await database.query("INSERT INTO transaction_sample (id) VALUES (1)");
    onWrite.mockClear();

    let releaseReads!: () => void;
    let signalReadsStarted!: () => void;
    const readsStarted = new Promise<void>((resolve) => {
      signalReadsStarted = resolve;
    });
    const relatedReads = database.readTransaction(async (reader) => {
      const isolation = await reader.read<{ transaction_isolation: string }>(
        "SHOW transaction_isolation",
      );
      const before = await reader.read<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM transaction_sample",
      );
      signalReadsStarted();
      await new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const after = await reader.read<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM transaction_sample",
      );
      return { isolation, before, after };
    });
    await readsStarted;

    let writeFinished = false;
    const concurrentWrite = database
      .query("INSERT INTO transaction_sample (id) VALUES (2)")
      .then(() => {
        writeFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeFinished).toBe(false);

    releaseReads();
    await expect(relatedReads).resolves.toMatchObject({
      isolation: { rows: [{ transaction_isolation: "repeatable read" }] },
      before: { rows: [{ total: "1" }] },
      after: { rows: [{ total: "1" }] },
    });
    await concurrentWrite;
    await database.close();

    expect(onWrite).toHaveBeenCalledOnce();
  });

  test("rejects multiple commands in a portable query", async () => {
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
    });

    await expect(database.query("SELECT 1; SELECT 2")).rejects.toThrow();
    await database.close();
  });

  test("reopens notes stored in its local data directory", async () => {
    const dataDir = await temporaryDataDirectory();
    const database = await DatabaseService.create({ dataDir });
    await database.addNote("Test the restart path", "alice@example.com");
    await database.close();

    const reopened = await DatabaseService.create({ dataDir });
    const notes = await reopened.listNotes();
    await reopened.close();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      body: "Test the restart path",
      createdBy: "alice@example.com",
    });
  });

  test("restores a database archive into a fresh local directory", async () => {
    const source = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
    });
    await source.addNote("Survives a replacement", "bob@example.com");
    const archive = await source.dump();
    await source.close();

    const restored = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
      loadArchive: archive,
    });
    const notes = await restored.listNotes();
    await restored.close();

    expect(notes.map((note) => note.body)).toEqual([
      "Survives a replacement",
    ]);
  });

  test("does not overlap a note write with a snapshot dump", async () => {
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
    });

    const [note, archive] = await Promise.all([
      database.addNote("Serialized write", "carol@example.com"),
      database.dump(),
    ]);
    const notes = await database.listNotes();
    await database.close();

    expect(note.body).toBe("Serialized write");
    expect(archive.byteLength).toBeGreaterThan(0);
    expect(notes).toHaveLength(1);
  });
});
