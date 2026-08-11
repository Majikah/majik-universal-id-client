// ─────────────────────────────────────────────────────────────────────────────
// majik-contact-migration.ts
//
// Detects whether a persisted MajikMessage JSON blob was saved before
// MajikContactManager existed (legacy) or after (current), and returns a
// normalised MajikMessageJSON that always carries the new shape.
//
// Legacy shape (pre-migration):
//   { id, contacts: { contacts: [...] }, envelopeCache, ownAccounts?, pinHash? }
//   ↑ contacts is a MajikContactDirectoryData — no `groups` field
//
// Current shape (post-migration):
//   { id, contacts: { contacts: [...], groups: { groups: [...] } }, envelopeCache, ... }
//   ↑ contacts is a MajikContactManagerJSON — always has both `contacts` and `groups`
// ─────────────────────────────────────────────────────────────────────────────

import { MajikContactDirectoryData, MajikContactManagerJSON } from "./types";

/* -------------------------------
 * Shape-detection helpers
 * ------------------------------- */

/**
 * Returns true when the blob looks like a legacy save that only has
 * a flat `{ contacts: [...] }` directory payload — no `groups` key.
 */
function isLegacyContactsShape(
  raw: unknown,
): raw is { contacts: MajikContactDirectoryData } & Record<string, unknown> {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;

  // Must have a `contacts` field that is an object …
  if (!obj.contacts || typeof obj.contacts !== "object") return false;
  const contacts = obj.contacts as Record<string, unknown>;

  // … that contains a `contacts` array (the raw serialized contacts) …
  if (!Array.isArray(contacts.contacts)) return false;

  // … but does NOT yet have a `groups` field — that is the migration trigger.
  return !("groups" in contacts);
}

/* -------------------------------
 * Public migration entry point
 * ------------------------------- */

export interface MajikMessageRawJSON extends Record<string, unknown> {
  id: string;
  contacts: MajikContactManagerJSON | MajikContactDirectoryData;
  envelopeCache: unknown;
  ownAccounts?: unknown;
}

/**
 * Accepts a raw parsed JSON object from IDB/storage and guarantees the
 * returned value always uses the current `MajikContactManagerJSON` shape
 * for its `contacts` field — even if the blob was saved before groups existed.
 *
 * This is the single migration choke-point.  Call it once at the top of
 * `MajikMessage.fromJSON()` before touching any field.
 *
 * Migration performed (legacy → current):
 *   contacts: { contacts: [...] }
 *   →
 *   contacts: { contacts: [...], groups: { groups: [] } }
 *
 * The empty `groups` payload means `MajikContactGroupManager.fromJSON()`
 * will bootstrap the two system groups (Favorites, Blocked) with no members,
 * which is exactly correct for a first-time migration.
 */
export function migrateMajikMessageJSON(
  raw: unknown,
): MajikMessageRawJSON & { contacts: MajikContactManagerJSON } {
  if (!raw || typeof raw !== "object") {
    throw new Error("migrateMajikMessageJSON: input must be a non-null object");
  }

  const obj = raw as MajikMessageRawJSON;

  if (!obj.id || typeof obj.id !== "string") {
    throw new Error("migrateMajikMessageJSON: missing required field 'id'");
  }

  // ── Already in current shape — pass through untouched ────────────────────
  if (!isLegacyContactsShape(obj)) {
    // Validate it at least has the expected structure
    const contacts = obj.contacts as unknown as Record<string, unknown>;
    if (!contacts || !Array.isArray(contacts.contacts) || !contacts.groups) {
      throw new Error(
        "migrateMajikMessageJSON: 'contacts' field has an unrecognised shape — " +
          "expected either a legacy { contacts: [...] } or current { contacts: [...], groups: {...} }",
      );
    }
    return obj as MajikMessageRawJSON & { contacts: MajikContactManagerJSON };
  }

  // ── Legacy shape — lift it into the current shape ─────────────────────────
  console.info(
    "[MajikMessage] Migrating persisted state from legacy contacts schema → " +
      "MajikContactManager schema. Groups will be initialised empty.",
  );

  const legacyContacts = obj.contacts as MajikContactDirectoryData;

  const migratedContacts: MajikContactManagerJSON = {
    contacts: legacyContacts, // preserve all serialized contacts as-is
    groups: { groups: [] }, // empty groups — system groups are bootstrapped at runtime
  };

  return {
    ...obj,
    contacts: migratedContacts,
  };
}
