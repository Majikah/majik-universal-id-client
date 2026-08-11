import { MajikKeyJSON } from "@majikah/majik-key";
import { MajikKeyStorageAdapter } from "./_types";

export class InMemoryKeystoreAdapter implements MajikKeyStorageAdapter {
  private _store: Map<string, MajikKeyJSON> = new Map();

  async save(invoice: MajikKeyJSON): Promise<void> {
    this._store.set(invoice.id, invoice);
  }

  async getById(id: string): Promise<MajikKeyJSON | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<MajikKeyJSON[]> {
    return Array.from(this._store.values());
  }

  async remove(id: string): Promise<boolean> {
    return this._store.delete(id);
  }

  async clear(): Promise<void> {
    this._store.clear();
  }

  async count(): Promise<number> {
    return this._store.size;
  }

  async exists(id: string): Promise<boolean> {
    return this._store.has(id);
  }

  async bulkSave(invoices: MajikKeyJSON[]): Promise<void> {
    for (const inv of invoices) this._store.set(inv.id, inv);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
