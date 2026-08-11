/* -------------------------------
 * Types
 * ------------------------------- */

import {
  SerializedMajikContact,
  SerializedMajikContactGroup,
} from "@majikah/majik-contact";

export type ContactManagerQueryMode = "id" | "public_key";

export interface MajikContactManagerJSON {
  contacts: MajikContactDirectoryData;
  groups: MajikContactGroupManagerData;
}

export interface MajikContactDirectoryData {
  contacts: SerializedMajikContact[];
}

export interface MajikContactGroupManagerData {
  groups: SerializedMajikContactGroup[];
}
