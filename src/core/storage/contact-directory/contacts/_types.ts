import { SerializedMajikContact } from "@majikah/majik-contact";
import { MajikStorageAdapter } from "../../storage-adapter";

export type MajikContactStorageAdapter =
  MajikStorageAdapter<SerializedMajikContact>;
