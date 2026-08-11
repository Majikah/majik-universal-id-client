import { SerializedMajikContactGroup } from "@majikah/majik-contact";
import { MajikContactGroupStorageAdapter } from "./_types";
import { SQLiteDatabase } from "../../sql-db-manager";
import { MAJIKAH_SQL_TABLES } from "../../sql-schema";

export class SQLiteContactGroupAdapter implements MajikContactGroupStorageAdapter {
  constructor(private db: SQLiteDatabase) {}

  async save(group: SerializedMajikContactGroup): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} 
       (id, json, name, created_at, updated_at, is_system)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        group.id,
        JSON.stringify(group),
        group.meta?.name ?? null,
        group.meta?.createdAt ?? null,
        group.meta?.updatedAt ?? null,
        group.isSystem ? 1 : 0,
      ],
    );
  }

  async getById(id: string): Promise<SerializedMajikContactGroup | null> {
    const row = await this.db.get<{ json: string }>(
      `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} WHERE id = ?`,
      [id],
    );

    return row ? JSON.parse(row.json) : null;
  }

  async list(): Promise<SerializedMajikContactGroup[]> {
    const rows = await this.db.all<{ json: string }>(
      `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS}`,
    );

    return rows.map((r) => JSON.parse(r.json));
  }

  async remove(id: string): Promise<boolean> {
    const exists = await this.exists(id);
    if (!exists) return false;

    await this.db.run(
      `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} WHERE id = ?`,
      [id],
    );

    return true;
  }

  async clear(): Promise<void> {
    await this.db.run(`DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS}`);
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS}`,
    );

    return row?.n ?? 0;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} WHERE id = ?`,
      [id],
    );

    return !!row;
  }

  async bulkSave(groups: SerializedMajikContactGroup[]): Promise<void> {
    if (groups.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const g of groups) {
        await tx.run(
          `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} 
           (id, json, name, created_at, updated_at, is_system)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            g.id,
            JSON.stringify(g),
            g.meta?.name ?? null,
            g.meta?.createdAt ?? null,
            g.meta?.updatedAt ?? null,
            g.isSystem ? 1 : 0,
          ],
        );
      }
    });
  }

  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        await tx.run(
          `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} WHERE id = ?`,
          [id],
        );
      }
    });
  }
}
