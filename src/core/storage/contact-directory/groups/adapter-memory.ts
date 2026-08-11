


import { SerializedMajikContactGroup } from "@majikah/majik-contact";
import { MajikContactGroupStorageAdapter } from "./_types";



export class InMemoryContactGroupAdapter implements MajikContactGroupStorageAdapter {
  private _store: Map<string, SerializedMajikContactGroup> = new Map();

  async save(invoice: SerializedMajikContactGroup): Promise<void> {
    this._store.set(invoice.id, invoice);
  }

  async getById(id: string): Promise<SerializedMajikContactGroup | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<SerializedMajikContactGroup[]> {
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

  async bulkSave(invoices: SerializedMajikContactGroup[]): Promise<void> {
    for (const inv of invoices) this._store.set(inv.id, inv);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
