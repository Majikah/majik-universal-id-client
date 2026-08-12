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

import { MajikKeyClientStateManager } from "@majikah/majik-key-client";
import {
  CLIENT_STATE_KEYS,
  ClientStateStorageAdapter,
  UserAppPreferences,
} from "./storage/client-state/_types";
import { InMemoryClientStateAdapter } from "./storage/client-state/adapter-memory";

// ---------------------------------------------------------------------------
// ClientStateManager
// ---------------------------------------------------------------------------

export class ClientStateManager extends MajikKeyClientStateManager {
  constructor(
    adapter: ClientStateStorageAdapter = new InMemoryClientStateAdapter(),
  ) {
    super(adapter);
  }

  /**
   * Retrieve user app preferences.
   * Returns `null` if none have been saved yet.
   */
  async getUserAppPreferences(): Promise<UserAppPreferences> {
    const raw = await this.get(CLIENT_STATE_KEYS.USER_APP_PREFERENCES);
    if (raw === null) {
      await this.resetUserAppPreferences();
      return DEFAULT_USER_APP_PREFERENCES;
    }
    try {
      return {
        ...DEFAULT_USER_APP_PREFERENCES,
        ...JSON.parse(raw),
      } as UserAppPreferences;
    } catch (e) {
      console.warn(
        "ClientStateManager: Problem retrieving user app preferences: ",
        e,
      );
      return DEFAULT_USER_APP_PREFERENCES;
    }
  }

  /**
   * Persist user app preferences.
   */
  async setUserAppPreferences(preferences: UserAppPreferences): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.USER_APP_PREFERENCES,
      JSON.stringify(preferences),
    );
  }

  /**
   * Persist user app preferences.
   */
  async resetUserAppPreferences(): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.USER_APP_PREFERENCES,
      JSON.stringify(DEFAULT_USER_APP_PREFERENCES),
    );
  }

  /**
   * Remove user app preferences.
   */
  async removeUserAppPreferences(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.USER_APP_PREFERENCES);
  }
}

export const DEFAULT_USER_APP_PREFERENCES: UserAppPreferences = {
  general: {},
  privacy: {
    shareAnalytics: true,
  },
  security: {
    key: {
      autoLockOnMinimize: false,
      onetimeUnlock: true,
    },
  },
};
