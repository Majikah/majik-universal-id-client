/**
 * @file _types.ts
 * @description Shared types for the ClientState storage layer.
 *
 * The adapter is intentionally minimal — it is a generic key/value store
 * where each entry carries a plain JSON-serialisable `value`. The
 * ClientStateManager owns all serialisation / deserialisation logic; the
 * adapter only moves bytes.
 */

import { BASE_CLIENT_STATE_KEYS } from "@majikah/majik-key-client";
import { MajikStorageAdapter } from "../storage-adapter";

// ---------------------------------------------------------------------------
// Storage entry — the unit that adapters read and write
// ---------------------------------------------------------------------------

export interface ClientStateEntry {
  /** Stable string key that identifies this piece of state. */
  id: string;
  /** JSON-serialised value. Always a string on the wire / in storage. */
  value: string;
  /** ISO 8601 datetime — set by the adapter on every write where supported. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Well-known state keys
// ---------------------------------------------------------------------------

export const CLIENT_STATE_KEYS = {
  ...BASE_CLIENT_STATE_KEYS,
  USER_APP_PREFERENCES: "user_app_preferences",
} as const;

export type ClientStateKey =
  (typeof CLIENT_STATE_KEYS)[keyof typeof CLIENT_STATE_KEYS];

/**
 * User-configured app-wide preferences.
 */
export interface UserAppPreferences {
  general: GeneralPreferences;
  privacy: PrivacyPreferences;
  security: SecurityPreferences;
}

export interface GeneralPreferences {
  history?: HistoryPreferences;
}

export interface HistoryPreferences {
  enabled?: boolean;
  maxCount?: number;
}

export interface SigningPreferences {
  autoSeal?: boolean;
  defaultToTSA?: boolean;
  defaultToDetached?: boolean;
  autosave?: {
    afterSign?: AutosavePreferences;
    afterSeal?: AutosavePreferences;
    afterNotary?: AutosavePreferences;
  };
}

export interface AutosavePreferences {
  enabled?: boolean;
  defaultPath?: string;
}

export interface PrivacyPreferences {
  shareAnalytics?: boolean;
}

export interface SecurityPreferences {
  key?: KeyPreferences;
}

export interface KeyPreferences {
  autoLockOnMinimize?: boolean;
  autoLockInterval?: number;
  onetimeUnlock?: boolean;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Pluggable persistence backend for client-level state.
 *
 * Implementations must provide IDB, SQLite, and in-memory variants.
 * All methods are async for uniformity — in-memory may resolve immediately.
 *
 * The store is deliberately flat: every piece of state is a `ClientStateEntry`
 * keyed by a stable string ID. There is no relational structure.
 */
export type ClientStateStorageAdapter = MajikStorageAdapter<ClientStateEntry>;
