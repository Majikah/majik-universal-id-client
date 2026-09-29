// sqlite-transport.ts
export interface SQLiteTransport {
  send(message: any): Promise<any>;
}

export class WorkerSQLiteTransport implements SQLiteTransport {
  constructor(private worker: Worker) {}
  send(message: any): Promise<any> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.id !== id) return;
        this.worker.removeEventListener("message", handler);
        e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error));
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ ...message, id });
    });
  }
}
