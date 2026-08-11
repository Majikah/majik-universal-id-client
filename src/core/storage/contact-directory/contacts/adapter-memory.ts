import { SerializedMajikContact } from "@majikah/majik-contact";
import { MajikContactStorageAdapter } from "./_types";


export class InMemoryContactAdapter implements MajikContactStorageAdapter {
  private _store: Map<string, SerializedMajikContact> = new Map();

  async save(contact: SerializedMajikContact): Promise<void> {
    this._store.set(contact.id, contact);
  }

  async getById(id: string): Promise<SerializedMajikContact | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<SerializedMajikContact[]> {
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

  async bulkSave(contacts: SerializedMajikContact[]): Promise<void> {
    for (const inv of contacts) this._store.set(inv.id, inv);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
