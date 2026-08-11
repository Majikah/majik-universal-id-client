import { SerializedMajikContactGroup } from "@majikah/majik-contact";
import { IDBGenericAdapter } from "../../idb-adapter";

const IDB_DB_NAME = "majik-contact-groups";
const IDB_STORE_NAME = "groups";
const IDB_VERSION = 1;

export const IDB_ADAPTER_CONTACT_GROUP =
  new IDBGenericAdapter<SerializedMajikContactGroup>(
    IDB_DB_NAME,
    IDB_STORE_NAME,
    IDB_VERSION,
  );
