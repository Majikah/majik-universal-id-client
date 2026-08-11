/**
 * @file adapter-idb.ts
 * @description IndexedDB-backed ClientStateStorageAdapter.
 *
 * Uses IDBGenericAdapter<ClientStateEntry> under the hood so the full
 * IDB transaction / error-handling logic lives in one place.
 *
 * Database : "majik-client-state"
 * Store    : "client-state"
 * Version  : 1
 *
 * Each entry is stored with `id` as the keyPath — identical to the invoice
 * and contact adapters.
 */

import type { ClientStateEntry } from "./_types";
import { IDBGenericAdapter } from "../idb-adapter";

const IDB_DB_NAME = "majik-client-state";
const IDB_STORE_NAME = "client-state";
const IDB_VERSION = 1;

export const IDB_ADAPTER_CLIENT_STATE = new IDBGenericAdapter<ClientStateEntry>(
  IDB_DB_NAME,
  IDB_STORE_NAME,
  IDB_VERSION,
);
