/**
 * @file client-state-manager.ts
 * @description ClientStateManager — typed read/write interface over a
 * pluggable ClientStateStorageAdapter.
 *
 * Responsibilities:
 *   - Async get / set / remove for each well-known client-state key
 *   - In-memory cache in front of the adapter (warm via hydrate())
 *   - Typed accessors for `accountOrder` and `invoiceDefaults` so callers
 *     never touch raw JSON strings
 *   - Generic `get` / `set` escape hatch for any future keys
 *   - Adapter can be swapped at runtime via setAdapter()
 *
 * Usage:
 * ```ts
 * const stateManager = new ClientStateManager(new IDBClientStateAdapter());
 * await stateManager.hydrate();
 *
 * await stateManager.setAccountOrder(["id1", "id2"]);
 * const order = await stateManager.getAccountOrder(); // ["id1", "id2"]
 * ```
 *
 * MajikBuwizClient owns this instance and calls hydrate() during its own
 * hydrate() pass. Callers should never need to hydrate() again unless the
 * adapter is swapped.
 */

import {
  AccountOrderValue,
  CLIENT_STATE_KEYS,
  ClientStateEntry,
  ClientStateStorageAdapter,
} from "./storage/client-state/_types";
import { InMemoryClientStateAdapter } from "./storage/client-state/adapter-memory";

// ---------------------------------------------------------------------------
// ClientStateManager
// ---------------------------------------------------------------------------

export class ClientStateManager {
  /** In-memory cache — warmed by hydrate(), kept in sync on every write. */
  private _cache: Map<string, string> = new Map();
  private _adapter: ClientStateStorageAdapter;

  /**
   * @param adapter Defaults to InMemoryClientStateAdapter (non-persistent).
   *   Pass IDBClientStateAdapter or SQLiteClientStateAdapter for persistence.
   */
  constructor(
    adapter: ClientStateStorageAdapter = new InMemoryClientStateAdapter(),
  ) {
    this._adapter = adapter;
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get adapter(): ClientStateStorageAdapter {
    return this._adapter;
  }

  /**
   * Swap the storage adapter at runtime.
   *
   * Does NOT migrate data. To migrate:
   * ```ts
   * const entries = stateManager.listCachedEntries();
   * stateManager.setAdapter(newAdapter);
   * await stateManager.hydrate();
   * await stateManager.bulkSet(entries);
   * ```
   */
  setAdapter(adapter: ClientStateStorageAdapter): void {
    this._adapter = adapter;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all entries from the adapter into the in-memory cache.
   * Call once after construction (MajikBuwizClient.hydrate() does this).
   */
  async hydrate(): Promise<void> {
    const entries = await this._adapter.list();
    this._cache.clear();
    for (const entry of entries) {
      this._cache.set(entry.id, entry.value);
    }
  }

  // ── Generic typed get / set / remove ─────────────────────────────────────

  /**
   * Retrieve a raw JSON string for any key. Returns `null` if not found.
   * Prefer the typed accessors (getAccountOrder, getInvoiceDefaults) over this.
   */
  async get(id: string): Promise<string | null> {
    const cached = this._cache.get(id);
    if (cached !== undefined) return cached;

    // Cache miss — should not happen after hydrate() but defensive
    const entry = await this._adapter.getById(id);
    if (!entry) return null;
    this._cache.set(id, entry.value);
    return entry.value;
  }

  /**
   * Persist a raw JSON string for any key.
   * Prefer the typed accessors over this.
   */
  async set(id: string, value: string): Promise<void> {
    const entry: ClientStateEntry = { id, value };
    await this._adapter.save(entry);
    this._cache.set(id, value);
  }

  /**
   * Remove a single key.
   */
  async remove(id: string): Promise<boolean> {
    const removed = await this._adapter.remove(id);
    this._cache.delete(id);
    return removed;
  }

  /**
   * Remove all stored state.
   */
  async clear(): Promise<void> {
    await this._adapter.clear();
    this._cache.clear();
  }

  /**
   * Whether a key exists in the cache.
   * Accurate after hydrate(); use exists() for an authoritative adapter check.
   */
  hasCached(id: string): boolean {
    return this._cache.has(id);
  }

  /**
   * Authoritative existence check against the adapter.
   */
  async exists(id: string): Promise<boolean> {
    if (this._cache.has(id)) return true;
    return this._adapter.exists(id);
  }

  /**
   * Snapshot of all cached entries — useful for adapter migration.
   */
  listCachedEntries(): ClientStateEntry[] {
    return Array.from(this._cache.entries()).map(([id, value]) => ({
      id,
      value,
    }));
  }

  /**
   * Persist multiple entries in one adapter call.
   */
  async bulkSet(entries: ClientStateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this._adapter.bulkSave(entries);
    for (const e of entries) this._cache.set(e.id, e.value);
  }

  // ── Typed: account order ──────────────────────────────────────────────────

  /**
   * Retrieve the ordered list of own account IDs.
   * Returns `null` if no order has been persisted yet.
   */
  async getAccountOrder(): Promise<AccountOrderValue | null> {
    const raw = await this.get(CLIENT_STATE_KEYS.ACCOUNT_ORDER);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as AccountOrderValue;
    } catch {
      console.warn("ClientStateManager: malformed account order — discarding.");
      return null;
    }
  }

  /**
   * Persist the ordered list of own account IDs.
   */
  async setAccountOrder(order: AccountOrderValue): Promise<void> {
    await this.set(CLIENT_STATE_KEYS.ACCOUNT_ORDER, JSON.stringify(order));
  }

  /**
   * Remove the persisted account order (resets to insertion order on next
   * hydrate).
   */
  async removeAccountOrder(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.ACCOUNT_ORDER);
  }

  // ── Typed: invoice defaults ───────────────────────────────────────────────

  // /**
  //  * Retrieve user-configured invoice defaults.
  //  * Returns `null` if none have been saved yet.
  //  */
  // async getInvoiceDefaults(): Promise<InvoiceDefaults | null> {
  //   const raw = await this.get(CLIENT_STATE_KEYS.INVOICE_DEFAULTS);
  //   if (raw === null) return null;
  //   try {
  //     return JSON.parse(raw) as InvoiceDefaults;
  //   } catch {
  //     console.warn(
  //       "ClientStateManager: malformed invoice defaults — discarding.",
  //     );
  //     return null;
  //   }
  // }

  // /**
  //  * Persist user-configured invoice defaults.
  //  */
  // async setInvoiceDefaults(defaults: InvoiceDefaults): Promise<void> {
  //   await this.set(
  //     CLIENT_STATE_KEYS.INVOICE_DEFAULTS,
  //     JSON.stringify(defaults),
  //   );
  // }

  // /**
  //  * Remove the persisted invoice defaults.
  //  */
  // async removeInvoiceDefaults(): Promise<void> {
  //   await this.remove(CLIENT_STATE_KEYS.INVOICE_DEFAULTS);
  // }

  // async currentInvoiceNumber(): Promise<number> {
  //   const current = await this.getInvoiceDefaults();
  //   const counter = current?.invoiceNumberCounter ?? 0;
  //   return counter;
  // }

  // async incrementInvoiceNumber(): Promise<number> {
  //   // 1. Get current defaults
  //   const current = await this.getInvoiceDefaults();

  //   // 2. Initialize safely if missing
  //   const counter = current?.invoiceNumberCounter ?? 0;

  //   const updated: InvoiceDefaults = {
  //     ...(current ?? {
  //       currency: "PHP" as any, // fallback — adjust if you have a real default
  //     }),
  //     invoiceNumberCounter: counter + 1,
  //   };

  //   // 3. Persist
  //   await this.setInvoiceDefaults(updated);

  //   // 4. Return the new value (useful for generating invoice number)
  //   return updated.invoiceNumberCounter!;
  // }

  // async decrementInvoiceNumber(): Promise<number> {
  //   // 1. Get current defaults
  //   const current = await this.getInvoiceDefaults();

  //   // 2. Initialize safely if missing
  //   const counter = current?.invoiceNumberCounter ?? 0;

  //   const updated: InvoiceDefaults = {
  //     ...(current ?? {
  //       currency: "PHP" as any, // fallback — adjust if you have a real default
  //     }),
  //     invoiceNumberCounter: counter - 1,
  //   };

  //   // 3. Persist
  //   await this.setInvoiceDefaults(updated);

  //   // 4. Return the new value (useful for generating invoice number)
  //   return updated.invoiceNumberCounter!;
  // }

  // ── Async count ───────────────────────────────────────────────────────────

  async count(): Promise<number> {
    return this._adapter.count();
  }
}
