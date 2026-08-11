import { SerializedMajikContact } from "@majikah/majik-contact";
import { MajikContactStorageAdapter } from "./_types";
import { SQLiteDatabase } from "../../sql-db-manager";

import { MAJIKAH_SQL_TABLES } from "../../sql-schema";
import { StorageQuery } from "../../storage-adapter";

export class SQLiteContactAdapter implements MajikContactStorageAdapter {
  constructor(private db: SQLiteDatabase) {}

  async save(contact: SerializedMajikContact): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} 
       (id, json, fingerprint, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contact.id,
        JSON.stringify(contact),
        contact.fingerprint ?? null,
        contact.meta?.label ?? null,
        contact.meta?.createdAt ?? null,
        contact.meta?.updatedAt ?? null,
      ],
    );
  }

  async getById(id: string): Promise<SerializedMajikContact | null> {
    const row = await this.db.get<{ json: string }>(
      `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} WHERE id = ?`,
      [id],
    );

    return row ? JSON.parse(row.json) : null;
  }

  async list(): Promise<SerializedMajikContact[]> {
    const rows = await this.db.all<{ json: string }>(
      `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}`,
    );

    return rows.map((r) => JSON.parse(r.json));
  }

  async remove(id: string): Promise<boolean> {
    const exists = await this.exists(id);
    if (!exists) return false;

    await this.db.run(
      `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} WHERE id = ?`,
      [id],
    );

    return true;
  }

  async clear(): Promise<void> {
    await this.db.run(`DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}`);
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}`,
    );

    return row?.n ?? 0;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} WHERE id = ?`,
      [id],
    );

    return !!row;
  }

  async bulkSave(contacts: SerializedMajikContact[]): Promise<void> {
    if (contacts.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const c of contacts) {
        await tx.run(
          `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} 
           (id, json, fingerprint, label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            c.id,
            JSON.stringify(c),
            c.fingerprint ?? null,
            c.meta?.label ?? null,
            c.meta?.createdAt ?? null,
            c.meta?.updatedAt ?? null,
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
          `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} WHERE id = ?`,
          [id],
        );
      }
    });
  }

  async query(
    query: StorageQuery<SerializedMajikContact>,
  ): Promise<SerializedMajikContact[]> {
    const clauses: string[] = [];
    const values: any[] = [];

    if (query.where) {
      for (const [key, value] of Object.entries(query.where)) {
        clauses.push(`${key} = ?`);
        values.push(value);
      }
    }

    let sql = `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}`;

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    if (query.orderBy) {
      sql += ` ORDER BY ${String(query.orderBy)} ${
        query.orderDirection ?? "asc"
      }`;
    }

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    if (query.offset) {
      sql += ` OFFSET ${query.offset}`;
    }

    const rows = await this.db.all<{ json: string }>(sql, values);

    return rows.map((r) => JSON.parse(r.json));
  }
}
