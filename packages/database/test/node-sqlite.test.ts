import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../src/adapters/node-sqlite.js";

describe("node:sqlite adapter", () => {
  it("supports prepared reads, writes, and atomic batches without a native addon", async () => {
    const db = openNodeSqliteDatabase(":memory:");
    try {
      await db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT UNIQUE)");
      const inserted = await db
        .prepare("INSERT INTO values_table (value) VALUES (?)")
        .bind("one")
        .run();
      expect(inserted.changes).toBe(1);
      expect(inserted.lastRowId).toBe(1);
      await expect(
        db.batch([
          db.prepare("INSERT INTO values_table (value) VALUES (?)").bind("two"),
          db.prepare("INSERT INTO values_table (value) VALUES (?)").bind("one"),
        ]),
      ).rejects.toThrow(/UNIQUE|constraint/iu);
      await expect(
        db.prepare("SELECT value FROM values_table ORDER BY id").all<{ value: string }>(),
      ).resolves.toEqual([{ value: "one" }]);
    } finally {
      db.close();
    }
  });
});
