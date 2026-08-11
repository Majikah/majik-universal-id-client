import { SerializedMajikContact } from "@majikah/majik-contact";
import { IDBGenericAdapter } from "../../idb-adapter";

const IDB_DB_NAME = "majik-contacts";
const IDB_STORE_NAME = "contacts";
const IDB_VERSION = 1;

export const IDB_ADAPTER_CONTACT =
  new IDBGenericAdapter<SerializedMajikContact>(
    IDB_DB_NAME,
    IDB_STORE_NAME,
    IDB_VERSION,
  );
