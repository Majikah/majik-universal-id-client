type MajikahSQLSchema = string;

/**
 * Centralized SQLite table registry.
 * - `as const` keeps literal types
 * - `MajikahSQLTable` becomes a strict union type
 */
export const MAJIKAH_SQL_TABLES = {
  MAJIK_CLIENT_STATE: "majik_client_state",
  MAJIK_KEYS: "majik_keys",
  MAJIK_CONTACTS: "majik_contacts",
  MAJIK_CONTACT_GROUPS: "majik_contact_groups",
} as const;

export type MajikahSQLTable =
  (typeof MAJIKAH_SQL_TABLES)[keyof typeof MAJIKAH_SQL_TABLES];

function normalizeSQL(sql: MajikahSQLSchema): string {
  return sql
    .trim()
    .replace(/\s+/g, " ") // collapse all whitespace
    .toLowerCase();
}

export function buildSchemaSQL(schemas: MajikahSQLSchema[]): MajikahSQLSchema {
  const seen = new Set<MajikahSQLSchema>();

  return schemas
    .map((schema) => schema.trim())
    .filter(Boolean)
    .filter((schema) => {
      const normalized = normalizeSQL(schema);

      if (seen.has(normalized)) return false; // silently skip
      seen.add(normalized);

      return true;
    })
    .join("\n\n");
}

export const MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CLIENT_STATE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_KEYS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_KEYS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  public_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_majik_keys_timestamp
ON ${MAJIKAH_SQL_TABLES.MAJIK_KEYS}(timestamp);

CREATE INDEX IF NOT EXISTS idx_majik_keys_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_KEYS}(public_key);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_CONTACTS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fingerprint TEXT,
  label TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_majik_contacts_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}(created_at);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_CONTACT_GROUPS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  name TEXT,
  created_at TEXT,
  updated_at TEXT,
  is_system INTEGER DEFAULT 0 CHECK(is_system IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_majik_contact_groups_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS}(created_at);
`;

export const MAJIKAH_SQL_SCHEMA_FULL: MajikahSQLSchema = buildSchemaSQL([
  MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE,
  MAJIKAH_SQL_SCHEMA_MAJIK_KEYS,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACTS,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACT_GROUPS,
]);
