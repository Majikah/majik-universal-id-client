/**
 * @file adapter-memory.ts
 * @description In-memory ClientStateStorageAdapter.
 *
 * Default adapter — zero-config, non-persistent. State is lost on page reload
 * or process restart. Useful for tests, SSR, and headless environments.
 */

import type { ClientStateEntry, ClientStateStorageAdapter } from "./_types";

export class InMemoryClientStateAdapter implements ClientStateStorageAdapter {
  private _store: Map<string, ClientStateEntry> = new Map();

  async save(entry: ClientStateEntry): Promise<void> {
    this._store.set(entry.id, {
      ...entry,
      updatedAt: new Date().toISOString(),
    });
  }

  async getById(id: string): Promise<ClientStateEntry | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<ClientStateEntry[]> {
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

  async bulkSave(entries: ClientStateEntry[]): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of entries) {
      this._store.set(entry.id, { ...entry, updatedAt: now });
    }
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
