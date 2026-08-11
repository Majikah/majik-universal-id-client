import { MajikKeyJSON } from "@majikah/majik-key";
import { IDBGenericAdapter } from "../idb-adapter";

const IDB_DB_NAME = "majik-keys";
const IDB_STORE_NAME = "identities";
const IDB_VERSION = 1;

export const IDB_ADAPTER_KEYSTORE = new IDBGenericAdapter<MajikKeyJSON>(
  IDB_DB_NAME,
  IDB_STORE_NAME,
  IDB_VERSION,
);
