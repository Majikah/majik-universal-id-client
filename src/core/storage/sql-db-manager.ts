export class SQLiteDatabase {
  constructor(private worker: Worker) {}

  private call(message: any): Promise<any> {
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.id !== id) return;

        this.worker.removeEventListener("message", handler);

        if (e.data.ok) resolve(e.data.result);
        else reject(new Error(e.data.error));
      };

      this.worker.addEventListener("message", handler);

      this.worker.postMessage({
        ...message,
        id,
      });
    });
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
