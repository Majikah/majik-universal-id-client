/**
 * @file adapter-sqlite.ts
 * @description SQLite-backed ClientStateStorageAdapter.
 *
 * Schema (must exist before construction — call createSchema() or include in
 * your db migration runner):
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS majik_client_state (
 *   key        TEXT PRIMARY KEY,
 *   value      TEXT NOT NULL,
 *   updated_at TEXT DEFAULT (datetime('now'))
 * );
 * ```
 *
 * The column is named `key` in SQL (reserved-word-safe via quoting where
 * needed) and mapped to the `id` field of ClientStateEntry in TypeScript so
 * the adapter contract is identical to the IDB and memory variants.
 */

import type { ClientStateEntry, ClientStateStorageAdapter } from "./_types";
import type { SQLiteDatabase } from "../sql-db-manager";

const TABLE = "majik_client_state";

/** DDL — pass to your migration runner or call createSchema() directly. */
export const MAJIK_CLIENT_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`.trim();

// ---------------------------------------------------------------------------
// Row shape returned by the SQLite driver
// ---------------------------------------------------------------------------

interface ClientStateRow {
  key: string;
  value: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SQLiteClientStateAdapter implements ClientStateStorageAdapter {
  constructor(private db: SQLiteDatabase) {}

  // ── Schema helper ──────────────────────────────────────────────────────────

  /**
   * Ensure the table exists. Call this once during app initialisation if your
   * migration runner does not already execute MAJIK_CLIENT_STATE_SCHEMA.
   */
  //   async createSchema(): Promise<void> {
  //     await this.db.run(MAJIK_CLIENT_STATE_SCHEMA);
  //   }

  // ── Write ──────────────────────────────────────────────────────────────────

  async save(entry: ClientStateEntry): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [entry.id, entry.value],
    );
  }

  async bulkSave(entries: ClientStateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx.run(
          `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at)
           VALUES (?, ?, datetime('now'))`,
          [entry.id, entry.value],
        );
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    const exists = await this.exists(id);
    if (!exists) return false;
    await this.db.run(`DELETE FROM ${TABLE} WHERE key = ?`, [id]);
    return true;
  }

  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        await tx.run(`DELETE FROM ${TABLE} WHERE key = ?`, [id]);
      }
    });
  }

  async clear(): Promise<void> {
    await this.db.run(`DELETE FROM ${TABLE}`);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<ClientStateEntry | null> {
    const row = await this.db.get<ClientStateRow>(
      `SELECT key, value, updated_at FROM ${TABLE} WHERE key = ?`,
      [id],
    );
    return row ? this._rowToEntry(row) : null;
  }

  async list(): Promise<ClientStateEntry[]> {
    const rows = await this.db.all<ClientStateRow>(
      `SELECT key, value, updated_at FROM ${TABLE}`,
    );
    return rows.map((r) => this._rowToEntry(r));
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM ${TABLE}`,
    );
    return row?.n ?? 0;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db.get(`SELECT 1 FROM ${TABLE} WHERE key = ?`, [id]);
    return !!row;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _rowToEntry(row: ClientStateRow): ClientStateEntry {
    return {
      id: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    };
  }
}
