import { SQLiteTransport } from "./sqlite-transport";

export class SQLiteDatabase {
  constructor(private transport: SQLiteTransport) {}

  private call(message: any): Promise<any> {
    return this.transport.send(message);
  }

  async run(sql: string, params: any[] = []): Promise<void> {
    await this.call({ type: "run", sql, params });
  }

  async get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    return this.call({ type: "get", sql, params });
  }

  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.call({ type: "all", sql, params });
  }

  async exec(sql: string): Promise<void> {
    await this.call({ type: "exec", sql });
  }

  async optimize(): Promise<void> {
    await this.run("PRAGMA optimize;");
    await this.run("ANALYZE;");
    await this.run("PRAGMA wal_checkpoint(FULL);");
  }

  async vacuum(): Promise<void> {
    await this.exec("VACUUM;");
  }

  async checkpoint(mode: "PASSIVE" | "FULL" = "PASSIVE"): Promise<void> {
    await this.run(`PRAGMA wal_checkpoint(${mode});`);
  }

  async transaction(fn: (tx: SQLiteDatabase) => Promise<void>) {
    await this.run("BEGIN");
    try {
      await fn(this);
      await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK");
      throw err;
    }
  }
}
