/**
 * MajikKeyManager.ts
 *
 * Adapter-backed manager for MajikKey accounts.
 * Replaces the static MajikKeyStore class with an instanced manager that
 * follows the same storage-adapter pattern as MajikContactManager.
 *
 * Adapters available:
 *   - InMemoryKeystoreAdapter  (tests / SSR)
 *   - IDB_ADAPTER_KEYSTORE     (browser default)
 *   - SQLiteKeystoreAdapter    (Tauri / desktop)
 */

import { MajikKey, MajikKeyJSON, SerializedIdentity } from "@majikah/majik-key";

import { KDF_VERSION } from "./constants";
import { MajikKeyStorageAdapter } from "../storage/keystore/_types";
import { InMemoryKeystoreAdapter } from "../storage/keystore/adapter-memory";

// ─── Error ────────────────────────────────────────────────────────────────────

export class MajikKeyManagerError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikKeyManagerError";
    this.cause = cause;
  }
}

// ─── Legacy type (migration reads only) ──────────────────────────────────────

interface LegacySerializedIdentity {
  id: string;
  publicKey: string;
  fingerprint: string;
  encryptedPrivateKey?: string;
  salt?: string;
}

// ─── MajikKeyManager ──────────────────────────────────────────────────────────

export class MajikKeyManager {
  /**
   * In-memory cache of all loaded MajikKey instances (locked or unlocked).
   * Keyed by account ID. Unlocked state lives inside each MajikKey instance.
   */
  private readonly _cache = new Map<string, MajikKey>();

  private _adapter: MajikKeyStorageAdapter;

  /**
   * Optional callback invoked when UI needs to prompt for a passphrase.
   */
  onUnlockRequested?: (id: string) => string | Promise<string>;

  constructor(adapter?: MajikKeyStorageAdapter) {
    this._adapter = adapter ?? new InMemoryKeystoreAdapter();
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get adapter(): MajikKeyStorageAdapter {
    return this._adapter;
  }

  /**
   * Swap the adapter at runtime. Does NOT migrate data automatically.
   *
   * Migration pattern:
   * ```ts
   * const snap = await manager.toJSON();
   * manager.setAdapter(new SQLiteKeystoreAdapter(worker));
   * await manager.hydrate();                 // warms from new (empty) adapter
   * await manager.bulkRestoreFromJSON(snap); // writes old data into new adapter
   * ```
   */
  setAdapter(adapter: MajikKeyStorageAdapter): void {
    this._adapter = adapter;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all keys from the adapter into the in-memory cache.
   * Call once after construction (or after swapping adapters).
   */
  async hydrate(): Promise<void> {
    this._cache.clear();
    const all = await this._adapter.list();
    for (const json of all) {
      try {
        const key = MajikKey.fromJSON(json);
        this._cache.set(key.id, key);
      } catch (err) {
        console.warn(
          `MajikKeyManager.hydrate: skipping malformed key "${json?.id}":`,
          err,
        );
      }
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  async toJSON(): Promise<MajikKeyJSON[]> {
    return this._adapter.list();
  }

  /**
   * Restore from a JSON snapshot into the current adapter.
   * Writes all keys through to the adapter, then rehydrates the cache.
   * Used after setAdapter() to migrate data into a new store.
   */
  async bulkRestoreFromJSON(data: MajikKeyJSON[]): Promise<void> {
    if (!Array.isArray(data)) {
      throw new MajikKeyManagerError(
        "bulkRestoreFromJSON: expected MajikKeyJSON[]",
      );
    }
    await this._adapter.bulkSave(data);
    await this.hydrate();
  }

  static async fromJSON(
    data: MajikKeyJSON[],
    adapter?: MajikKeyStorageAdapter,
  ): Promise<MajikKeyManager> {
    const manager = new MajikKeyManager(adapter);
    await manager.bulkRestoreFromJSON(data);
    return manager;
  }

  // ── Write-through helper ──────────────────────────────────────────────────

  private async _persist(key: MajikKey): Promise<void> {
    await this._adapter.save(key.toJSON());
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * Store a MajikKey in the adapter and cache it in memory.
   */
  async save(key: MajikKey): Promise<void> {
    await this._persist(key);
    this._cache.set(key.id, key);
  }

  /**
   * Load a MajikKey by ID. Checks memory cache first, then the adapter.
   * Returns null if not found anywhere.
   *
   * Loaded keys are LOCKED. Call unlock(id, passphrase) to unlock.
   */
  async load(id: string): Promise<MajikKey | null> {
    const cached = this._cache.get(id);
    if (cached) return cached;

    const json = await this._adapter.getById(id);
    if (!json) return null;

    const key = MajikKey.fromJSON(json);
    this._cache.set(key.id, key);
    return key;
  }

  async getAccount(id: string): Promise<MajikKey> {
    const key = await this.load(id);
    if (!key) throw new MajikKeyManagerError(`Account not found: ${id}`);
    return key;
  }

  /**
   * Load all MajikKeys (cache + adapter merged).
   */
  async loadAll(): Promise<MajikKey[]> {
    const all = await this._adapter.list();
    for (const json of all) {
      if (!this._cache.has(json.id)) {
        try {
          const key = MajikKey.fromJSON(json);
          this._cache.set(key.id, key);
        } catch (err) {
          console.warn(
            `MajikKeyManager.loadAll: skipping malformed key "${json?.id}":`,
            err,
          );
        }
      }
    }
    return [...this._cache.values()];
  }

  /**
   * Delete an account from the adapter and memory cache.
   */
  async delete(id: string): Promise<void> {
    await this._adapter.remove(id);
    this._cache.delete(id);
  }

  /**
   * Check whether an account exists by ID or fingerprint.
   * Checks memory cache first, then the adapter.
   */
  async has(idOrFingerprint: string): Promise<boolean> {
    if (this._findKey(idOrFingerprint)) return true;

    const all = await this._adapter.list();
    return all.some(
      (j) => j.id === idOrFingerprint || j.fingerprint === idOrFingerprint,
    );
  }

  /**
   * Get a loaded MajikKey by ID or fingerprint (cache only — call load() first).
   */
  get(idOrFingerprint: string): MajikKey | undefined {
    return this._findKey(idOrFingerprint);
  }

  /**
   * List all currently cached MajikKey instances (locked + unlocked).
   */
  list(): MajikKey[] {
    return [...this._cache.values()];
  }

  // ── Unlock / Lock ─────────────────────────────────────────────────────────

  /**
   * Unlock a stored MajikKey with the given passphrase.
   * Dispatches to the correct KDF (PBKDF2 for legacy, Argon2id for new).
   */
  async unlock(id: string, passphrase: string): Promise<MajikKey> {
    const key = await this.load(id);
    if (!key) throw new MajikKeyManagerError(`Account not found: ${id}`);
    if (key.isUnlocked) return key;
    await key.unlock(passphrase);
    this._cache.set(id, key);
    return key;
  }

  /**
   * Lock a MajikKey — clears private keys from memory.
   */
  lock(id: string): void {
    this._cache.get(id)?.lock();
  }

  /**
   * Lock all loaded accounts.
   */
  lockAll(): void {
    for (const key of this._cache.values()) key.lock();
  }

  // ── Key material access ───────────────────────────────────────────────────

  /**
   * Get the private key of an unlocked account (by ID or fingerprint).
   * Throws if not found or not unlocked — caller must call unlock() first.
   */
  getPrivateKey(idOrFingerprint: string): CryptoKey | { raw: Uint8Array } {
    const key = this._findKey(idOrFingerprint);
    if (key?.isUnlocked) return key.getPrivateKey();
    throw new MajikKeyManagerError(
      `Account "${idOrFingerprint}" must be unlocked first via unlock()`,
    );
  }

  /**
   * Get the ML-KEM secret key of an unlocked account.
   * Returns undefined if the account has no ML-KEM keys (pre-migration).
   */
  getMlKemSecretKey(idOrFingerprint: string): Uint8Array | undefined {
    const key = this._findKey(idOrFingerprint);
    if (!key?.isUnlocked) return undefined;
    try {
      return key.getMlKemSecretKey();
    } catch {
      return undefined;
    }
  }

  // ── Passphrase management ─────────────────────────────────────────────────

  /**
   * Validate whether a passphrase can decrypt the stored account.
   * Does NOT unlock or mutate any state.
   */
  async isPassphraseValid(id: string, passphrase: string): Promise<boolean> {
    const key = await this.load(id);
    if (!key) return false;
    return key.verify(passphrase);
  }

  /**
   * Update passphrase — correctly upgrades KDF to Argon2id on re-encryption.
   */
  async updatePassphrase(
    id: string,
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<void> {
    const key = await this.load(id);
    if (!key) throw new MajikKeyManagerError(`Account not found: ${id}`);
    await key.updatePassphrase(currentPassphrase, newPassphrase);
    await this._persist(key);
  }

  // ── ensureUnlocked ────────────────────────────────────────────────────────

  /**
   * Ensure an account is unlocked, prompting for passphrase if needed.
   *
   * Priority: promptFn arg → this.onUnlockRequested → window.prompt
   */
  async ensureUnlocked(
    id: string,
    promptFn?: (id: string) => string | Promise<string>,
  ): Promise<CryptoKey | { raw: Uint8Array }> {
    try {
      return this.getPrivateKey(id);
    } catch {
      /* not yet unlocked */
    }

    let passphrase: string | null = null;
    if (promptFn) {
      const res = promptFn(id);
      passphrase = typeof res === "string" ? res : await res;
    } else if (this.onUnlockRequested) {
      const res = this.onUnlockRequested(id);
      passphrase = typeof res === "string" ? res : await res;
    } else if (typeof window !== "undefined" && window.prompt) {
      passphrase = window.prompt("Enter passphrase to unlock account:", "");
    }

    if (!passphrase) throw new MajikKeyManagerError("Unlock cancelled");

    await this.unlock(id, passphrase);
    return this.getPrivateKey(id);
  }

  // ── Mnemonic / backup helpers ─────────────────────────────────────────────

  static async generateMnemonic(strength: 128 | 256 = 128): Promise<string> {
    return await MajikKey.generateMnemonic(strength);
  }

  async exportMnemonicBackup(id: string, mnemonic: string): Promise<string> {
    const key = this._cache.get(id);
    if (!key) throw new MajikKeyManagerError(`Account not found: ${id}`);
    if (key.isLocked)
      throw new MajikKeyManagerError(
        "Account must be unlocked to export backup",
      );
    return key.exportMnemonicBackup(mnemonic);
  }

  async importFromMnemonicBackup(
    backupBase64: string,
    mnemonic: string,
    passphrase: string,
    label?: string,
  ): Promise<MajikKey> {
    const key = await MajikKey.importFromMnemonicBackup(
      backupBase64,
      mnemonic,
      passphrase,
      label,
    );
    await this.save(key);
    return key;
  }

  // ── Legacy migration ──────────────────────────────────────────────────────

  /**
   * Reconstruct a locked MajikKey from a legacy SerializedIdentity.
   * The resulting key will have kdfVersion: PBKDF2 and hasMlKem: false.
   */
  static fromLegacySerializedIdentity(si: LegacySerializedIdentity): MajikKey {
    if (!si.id || !si.publicKey || !si.fingerprint) {
      throw new MajikKeyManagerError(
        "Invalid legacy SerializedIdentity: missing required fields",
      );
    }

    const json: MajikKeyJSON = {
      id: si.id,
      label: "",
      publicKey: si.publicKey,
      fingerprint: si.fingerprint,
      encryptedPrivateKey: si.encryptedPrivateKey || "",
      salt: si.salt || "",
      backup: "_LEGACY",
      timestamp: new Date().toISOString(),
      kdfVersion: KDF_VERSION.PBKDF2,
    };

    return MajikKey.fromJSON(json);
  }

  /**
   * Migrate a single legacy SerializedIdentity into the current adapter.
   * Skips if a record with the same ID already exists.
   */
  async migrate(
    identity: SerializedIdentity,
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (await this._adapter.exists(identity.id)) {
        return { success: true, message: `Already migrated: ${identity.id}` };
      }
      const key = MajikKeyManager.fromLegacySerializedIdentity(identity);
      await this.save(key);
      return { success: true, message: `Successfully migrated ${identity.id}` };
    } catch (err) {
      console.warn(`Failed to migrate legacy account ${identity.id}:`, err);
      return {
        success: false,
        message: `Failed to migrate legacy account ${identity.id}: ${err}`,
      };
    }
  }

  /**
   * Migrate all legacy SerializedIdentity records into the current adapter.
   * Already-migrated accounts are skipped.
   */
  async migrateAll(
    legacyIdentities: SerializedIdentity[],
  ): Promise<{ migrated: number; skipped: number }> {
    let migrated = 0;
    let skipped = 0;

    for (const identity of legacyIdentities) {
      const result = await this.migrate(identity);
      if (result.success) migrated++;
      else skipped++;
    }

    return { migrated, skipped };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _findKey(idOrFingerprint: string): MajikKey | undefined {
    const byId = this._cache.get(idOrFingerprint);
    if (byId) return byId;
    for (const key of this._cache.values()) {
      if (key.fingerprint === idOrFingerprint) return key;
    }
    return undefined;
  }
}
