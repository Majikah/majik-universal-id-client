import { MajikStorageAdapter } from "./storage-adapter";

export class IDBGenericAdapter<
  T extends { id: string },
> implements MajikStorageAdapter<T> {
  constructor(
    private dbName: string,
    private storeName: string,
    private version = 1,
  ) {}

  private db: IDBDatabase | null = null;

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);

      req.onupgradeneeded = () => {
        const db = req.result;

        const stores = [this.storeName]; // or pass array if you want

        for (const name of stores) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "id" });
          }
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  private async tx<R>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<R> | null,
  ): Promise<R> {
    const db = await this.open();

    return new Promise<R>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      const req = fn(store);

      if (req) {
        req.onsuccess = () => resolve(req.result as R);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error); // 👈 ADD THIS
      } else {
        tx.oncomplete = () => resolve(undefined as R);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error); // 👈 ADD THIS
      }
    });
  }

  async save(item: T) {
    await this.tx("readwrite", (s) => s.put(item));
  }

  async getById(id: string): Promise<T | null> {
    const result = await this.tx<T | undefined>("readonly", (s) => s.get(id));
    return result ?? null;
  }

  async list(): Promise<T[]> {
    return await this.tx<T[]>("readonly", (s) => s.getAll());
  }

  async remove(id: string) {
    const exists = await this.exists(id);
    if (!exists) return false;
    await this.tx("readwrite", (s) => s.delete(id));
    return true;
  }

  async clear() {
    await this.tx("readwrite", (s) => s.clear());
  }

  async count(): Promise<number> {
    return await this.tx<number>("readonly", (s) => s.count());
  }

  async exists(id: string): Promise<boolean> {
    const key = await this.tx<IDBValidKey | undefined>("readonly", (s) =>
      s.getKey(id),
    );
    return key != null;
  }

  async bulkSave(items: T[]): Promise<void> {
    if (items.length === 0) return;

    const db = await this.open();

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      for (const item of items) {
        store.put(item);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const db = await this.open();

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      for (const id of ids) {
        store.delete(id);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}
