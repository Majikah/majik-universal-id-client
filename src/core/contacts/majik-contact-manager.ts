import {
  MajikContact,
  MajikContactCard,
  MajikContactData,
  MajikContactGroup,
  MajikContactGroupMeta,
} from "@majikah/majik-contact";
import { MajikContactDirectory } from "./majik-contact-directory";
import { MajikContactGroupManager } from "./majik-contact-groups";
import { MAJIK_API_RESPONSE } from "../types";
import { MajikContactManagerError } from "./errors";
import { MajikContactManagerJSON } from "./types";
import {
  arrayBufferToBase64,
  arrayToBase64,
  base64ToArrayBuffer,
} from "../utils/utilities";
import { KEY_ALGO } from "../crypto/constants";
import { gunzipSync, gzipSync } from "fflate";
import { MajikContactStorageAdapter } from "../storage/contact-directory/contacts/_types";
import { MajikContactGroupStorageAdapter } from "../storage/contact-directory/groups/_types";
import { InMemoryContactAdapter } from "../storage/contact-directory/contacts/adapter-memory";
import { InMemoryContactGroupAdapter } from "../storage/contact-directory/groups/adapter-memory";
import { MajikKeyAddress } from "@majikah/majik-key";

// ---------------------------------------------------------------------------
// MajikContactManager
// ---------------------------------------------------------------------------

export interface MajikContactManagerAdapters {
  contacts?: MajikContactStorageAdapter;
  groups?: MajikContactGroupStorageAdapter;
}

export class MajikContactManager {
  private readonly directory: MajikContactDirectory;
  private readonly groupManager: MajikContactGroupManager;
  private _contactAdapter: MajikContactStorageAdapter;
  private _groupAdapter: MajikContactGroupStorageAdapter;

  constructor(
    directory?: MajikContactDirectory,
    groupManager?: MajikContactGroupManager,
    adapters?: MajikContactManagerAdapters,
  ) {
    this.directory = directory ?? new MajikContactDirectory();

    if (groupManager) {
      this.assertGroupManagerInstance(groupManager);
      this.groupManager = groupManager;
    } else {
      this.groupManager = new MajikContactGroupManager(this.directory);
    }

    this._contactAdapter = adapters?.contacts ?? new InMemoryContactAdapter();
    this._groupAdapter = adapters?.groups ?? new InMemoryContactGroupAdapter();
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get contactAdapter(): MajikContactStorageAdapter {
    return this._contactAdapter;
  }

  get groupAdapter(): MajikContactGroupStorageAdapter {
    return this._groupAdapter;
  }

  /**
   * Swap both adapters at runtime. Does NOT migrate data.
   *
   * Migration pattern:
   * ```ts
   * const snap = await manager.toJSON();
   * manager.setAdapters({ contacts: new IDBContactAdapter(), groups: new IDBGroupAdapter() });
   * await manager.hydrate();                    // warms from new (empty) adapters
   * await manager.bulkRestoreFromJSON(snap);    // writes old data into new adapters
   * ```
   */
  setAdapters(adapters: MajikContactManagerAdapters): void {
    if (adapters.contacts) this._contactAdapter = adapters.contacts;
    if (adapters.groups) this._groupAdapter = adapters.groups;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all contacts and groups from the adapters into the in-memory
   * directory and group manager. Call once after construction (or after
   * swapping adapters).
   *
   * Restoration order:
   *  1. Contacts — must come first so groups can validate member existence.
   *  2. Groups — restored via groupManager.fromJSON() which rebuilds the
   *     reverse index and re-bootstraps system groups.
   *  3. Orphan pruning — any group member ID not present in the restored
   *     directory is silently removed (guards against data drift).
   */
  async hydrate(): Promise<void> {
    // ── 1. Contacts ───────────────────────────────────────────────────────
    const serializedContacts = await this._contactAdapter.list();
    this.directory.clear();

    for (const item of serializedContacts) {
      try {
        const raw = base64ToArrayBuffer(item.publicKeyBase64);
        let publicKey: CryptoKey | { raw: Uint8Array };
        try {
          publicKey = await crypto.subtle.importKey(
            "raw",
            raw,
            KEY_ALGO,
            true,
            [],
          );
        } catch {
          publicKey = { raw: new Uint8Array(raw) };
        }

        const contact = MajikContact.create(
          item.id,
          publicKey as any,
          item.mlKey,
          item.fingerprint,
          item.meta,
          item.edPublicKeyBase64,
          item.mlDsaPublicKeyBase64,
        );
        // Use the internal map directly to avoid addContact's duplicate-check
        // (re-hydrating from persisted state, not user-facing add)
        this.directory["contacts"].set(contact.id, contact);
        this.directory["fingerprintMap"].set(contact.fingerprint, contact.id);
      } catch (err) {
        console.warn(
          `MajikContactManager.hydrate: skipping malformed contact "${item?.id}":`,
          err,
        );
      }
    }

    // ── 2. Groups ─────────────────────────────────────────────────────────
    const serializedGroups = await this._groupAdapter.list();
    this.groupManager.fromJSON({ groups: serializedGroups });

    // ── 3. Orphan pruning ─────────────────────────────────────────────────
    MajikContactManager.pruneOrphanedMembers(this.directory, this.groupManager);
  }

  // ── Write-through helpers ─────────────────────────────────────────────────

  /**
   * Persists a single contact to the adapter (called after every mutating
   * operation that affects a contact's serialized form).
   */
  private async persistContact(contact: MajikContact): Promise<void> {
    const json = await contact.toJSON();
    await this._contactAdapter.save(json);
  }

  /**
   * Persists a single group to the adapter.
   */
  private async persistGroup(group: MajikContactGroup): Promise<void> {
    await this._groupAdapter.save(group.toJSON());
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Adds a contact to the directory and persists it to the adapter.
   */
  async addContact(contact: MajikContact): Promise<this> {
    this.directory.addContact(contact);
    await this.persistContact(contact);
    return this;
  }

  /**
   * Adds multiple contacts atomically — adapter write uses bulkSave.
   */
  async addContacts(contacts: MajikContact[]): Promise<this> {
    this.directory.addContacts(contacts);
    const jsons = await Promise.all(contacts.map((c) => c.toJSON()));
    await this._contactAdapter.bulkSave(jsons);
    return this;
  }

  /**
   * Removes a contact from the directory, all groups, and the adapter.
   */
  async removeContact(id: string): Promise<MAJIK_API_RESPONSE> {
    const result = this.directory.removeContact(id);
    if (result.success) {
      this.groupManager.handleContactRemoved(id);
      await this._contactAdapter.remove(id);
      // Persist every group whose membership changed
      await this._persistAllGroups();
    }
    return result;
  }

  /**
   * Updates contact metadata and persists the change.
   */
  async updateContactMeta(
    id: string,
    meta: Partial<MajikContactData["meta"]>,
  ): Promise<MajikContact> {
    const contact = this.directory.updateContactMeta(id, meta);
    await this.persistContact(contact);
    return contact;
  }

  /**
   * Blocks a contact and persists both the contact and the Blocked group.
   */
  async blockContact(id: string): Promise<MajikContact> {
    const contact = this.directory.blockContact(id);
    const blocked = this.groupManager.addContactToGroupIfAbsent(
      this.groupManager.getBlockedGroup().id,
      id,
    );
    await this.persistContact(contact);
    await this.persistGroup(blocked);
    return contact;
  }

  /**
   * Unblocks a contact and persists both the contact and the Blocked group.
   */
  async unblockContact(id: string): Promise<MajikContact> {
    const contact = this.directory.unblockContact(id);
    const blocked = this.groupManager.removeContactFromGroupIfPresent(
      this.groupManager.getBlockedGroup().id,
      id,
    );
    await this.persistContact(contact);
    await this.persistGroup(blocked);
    return contact;
  }

  async setMajikahStatus(id: string, status: boolean): Promise<MajikContact> {
    const contact = this.directory.setMajikahStatus(id, status);
    await this.persistContact(contact);
    return contact;
  }

  /**
   * Clears all contacts and groups from both the in-memory stores and adapters.
   */
  async clear(): Promise<this> {
    const allContactIds = this.directory.listContacts().map((c) => c.id);
    this.directory.clear();
    allContactIds.forEach((id) => this.groupManager.handleContactRemoved(id));

    this.directory.clear();
    this.groupManager.clear();
    await this._contactAdapter.clear();
    await this._groupAdapter.clear();
    return this;
  }

  // ── Sync reads (unchanged from original) ──────────────────────────────────

  getContact(id: string): MajikContact | undefined {
    return this.directory.getContact(id);
  }

  getContactByFingerprint(fingerprint: string): MajikContact | undefined {
    return this.directory.getContactByFingerprint(fingerprint);
  }

  async getContactByAddress(
    address: MajikKeyAddress,
  ): Promise<MajikContact | undefined> {
    return await this.directory.getContactByAddress(address);
  }

  getContactsByIds(ids: string[], strict = false): MajikContact[] {
    if (!ids?.length) return [];

    const seen = new Set<string>();
    const results: MajikContact[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const contact = this.directory.getContact(id);

      if (!contact) {
        if (strict) {
          throw new MajikContactManagerError(`Contact not found: ${id}`);
        }
        continue;
      }

      results.push(contact);
    }

    return results;
  }

  async getContactsByPublicKeys(
    publicKeys: string[],
    strict = false,
  ): Promise<MajikContact[]> {
    if (!publicKeys?.length) return [];

    const uniqueKeys = [...new Set(publicKeys)];

    const contacts = await Promise.all(
      uniqueKeys.map(async (key) => {
        const contact = await this.directory.getContactByAddress(key);

        if (!contact && strict) {
          throw new MajikContactManagerError(
            `Contact not found for publicKey: ${key}`,
          );
        }

        return contact;
      }),
    );

    return contacts.filter((c): c is MajikContact => Boolean(c));
  }

  hasContact(id: string): boolean {
    return this.directory.hasContact(id);
  }

  hasFingerprint(fingerprint: string): boolean {
    return this.directory.hasFingerprint(fingerprint);
  }

  async hasContactByAddress(address: MajikKeyAddress): Promise<boolean> {
    return this.directory.hasContactByAddress(address);
  }

  listContacts(sortedByLabel = false, majikahOnly = false): MajikContact[] {
    return this.directory.listContacts(sortedByLabel, majikahOnly);
  }

  isMajikahRegistered(id: string): boolean {
    return this.directory.isMajikahRegistered(id);
  }

  isMajikahIdentityChecked(id: string): boolean {
    return this.directory.isMajikahIdentityChecked(id);
  }

  // ── Group CRUD (now async, write-through) ─────────────────────────────────

  get group(): MajikContactGroupManager {
    return this.groupManager;
  }

  get directory_(): MajikContactDirectory {
    return this.directory;
  }

  async createGroup(
    id: string,
    name: string,
    meta?: Partial<Omit<MajikContactGroupMeta, "name">>,
    initialMemberIds?: string[],
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.createGroup(
      id,
      name,
      meta,
      initialMemberIds,
    );
    await this.persistGroup(group);
    return group;
  }

  async addGroup(group: MajikContactGroup): Promise<this> {
    this.groupManager.addGroup(group);
    await this.persistGroup(group);
    return this;
  }

  async removeGroup(id: string): Promise<MAJIK_API_RESPONSE> {
    const result = this.groupManager.removeGroup(id);
    if (result.success) {
      await this._groupAdapter.remove(id);
    }
    return result;
  }

  getGroup(id: string): MajikContactGroup | undefined {
    return this.groupManager.getGroup(id);
  }

  getGroupOrThrow(id: string): MajikContactGroup {
    return this.groupManager.getGroupOrThrow(id);
  }

  hasGroup(id: string): boolean {
    return this.groupManager.hasGroup(id);
  }

  listGroups(includeSystem = true, sortedByName = false): MajikContactGroup[] {
    return this.groupManager.listGroups(includeSystem, sortedByName);
  }

  listUserGroups(sortedByName = true): MajikContactGroup[] {
    return this.groupManager.listGroups(false, sortedByName);
  }

  listSystemGroups(): MajikContactGroup[] {
    return this.groupManager.listGroups(true).filter((g) => g.isSystem);
  }

  async updateGroupMeta(
    id: string,
    meta: Partial<
      Pick<MajikContactGroupMeta, "name" | "description" | "color">
    >,
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.updateGroupMeta(id, meta);
    await this.persistGroup(group);
    return group;
  }

  // ── Group membership (async, write-through) ───────────────────────────────

  async addContactToGroup(
    groupId: string,
    contactId: string,
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.addContactToGroup(groupId, contactId);
    await this.persistGroup(group);
    return group;
  }

  async addContactToGroupIfAbsent(
    groupId: string,
    contactId: string,
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.addContactToGroupIfAbsent(
      groupId,
      contactId,
    );
    await this.persistGroup(group);
    return group;
  }

  async addContactsToGroup(
    groupId: string,
    contactIds: string[],
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.addContactsToGroup(groupId, contactIds);
    await this.persistGroup(group);
    return group;
  }

  async removeContactFromGroup(
    groupId: string,
    contactId: string,
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.removeContactFromGroup(groupId, contactId);
    await this.persistGroup(group);
    return group;
  }

  async removeContactFromGroupIfPresent(
    groupId: string,
    contactId: string,
  ): Promise<MajikContactGroup> {
    const group = this.groupManager.removeContactFromGroupIfPresent(
      groupId,
      contactId,
    );
    await this.persistGroup(group);
    return group;
  }

  async moveContactBetweenGroups(
    contactId: string,
    fromGroupId: string,
    toGroupId: string,
  ): Promise<void> {
    this.groupManager.moveContact(contactId, fromGroupId, toGroupId);
    // Persist both affected groups
    const from = this.groupManager.getGroup(fromGroupId);
    const to = this.groupManager.getGroup(toGroupId);
    const writes: Promise<void>[] = [];
    if (from) writes.push(this.persistGroup(from));
    if (to) writes.push(this.persistGroup(to));
    await Promise.all(writes);
  }

  // ── Group query pass-throughs (sync, unchanged) ───────────────────────────

  getContactsInGroup(groupId: string): MajikContact[] {
    return this.groupManager.getContactsInGroup(groupId);
  }

  getContactsInGroupSorted(groupId: string): MajikContact[] {
    return this.groupManager.getContactsInGroupSorted(groupId);
  }

  isContactInGroup(groupId: string, contactId: string): boolean {
    return this.groupManager.isContactInGroup(groupId, contactId);
  }

  getGroupsForContact(contactId: string): MajikContactGroup[] {
    return this.groupManager.getGroupsForContact(contactId);
  }

  getGroupIdsForContact(contactId: string): string[] {
    return this.groupManager.getGroupIdsForContact(contactId);
  }

  // ── System group convenience (async, write-through) ───────────────────────

  async addToFavorites(contactId: string): Promise<MajikContactGroup> {
    const group = this.groupManager.addToFavorites(contactId);
    await this.persistGroup(group);
    return group;
  }

  async removeFromFavorites(contactId: string): Promise<MajikContactGroup> {
    const group = this.groupManager.removeFromFavorites(contactId);
    await this.persistGroup(group);
    return group;
  }

  isFavorite(contactId: string): boolean {
    return this.groupManager.isFavorite(contactId);
  }

  isContactBlocked(contactId: string): boolean {
    return this.groupManager.isBlocked(contactId);
  }

  getFavoritesGroup(): MajikContactGroup {
    return this.groupManager.getFavoritesGroup();
  }

  getBlockedGroup(): MajikContactGroup {
    return this.groupManager.getBlockedGroup();
  }

  getFavoriteContacts(): MajikContact[] {
    return this.groupManager.getContactsInGroup(
      this.groupManager.getFavoritesGroup().id,
    );
  }

  getBlockedContacts(): MajikContact[] {
    return this.groupManager.getContactsInGroup(
      this.groupManager.getBlockedGroup().id,
    );
  }

  // ── Import / Export (unchanged) ───────────────────────────────────────────

  async exportContactAsJSON(contactId: string): Promise<string | null> {
    const contact = this.getContact(contactId);
    if (!contact) return null;

    let publicKeyBase64: string;
    const anyPub: any = contact.publicKey;
    if (anyPub?.raw instanceof Uint8Array) {
      publicKeyBase64 = arrayBufferToBase64(anyPub.raw.buffer);
    } else {
      const raw = await crypto.subtle.exportKey(
        "raw",
        contact.publicKey as CryptoKey,
      );
      publicKeyBase64 = arrayBufferToBase64(raw);
    }

    return JSON.stringify(
      {
        id: contact.id,
        label: contact.meta?.label || "",
        publicKey: publicKeyBase64,
        fingerprint: contact.fingerprint,
        mlKey: contact.mlKey,
        edPublicKeyBase64: contact.edPublicKeyBase64,
        mlDsaPublicKeyBase64: contact.mlDsaPublicKeyBase64,
      } satisfies MajikContactCard,
      null,
      2,
    );
  }

  async exportContactAsString(contactId: string): Promise<string | null> {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    return this.exportContactCompressed(contact);
  }

  async importContactFromJSON(jsonStr: string): Promise<MAJIK_API_RESPONSE> {
    try {
      const data: MajikContactCard = JSON.parse(jsonStr);
      if (!data.id || !data.publicKey || !data.fingerprint) {
        return { success: false, message: "Invalid contact JSON" };
      }

      const rawBuffer = base64ToArrayBuffer(data.publicKey as string);
      let publicKey: CryptoKey | { raw: Uint8Array };
      try {
        publicKey = await crypto.subtle.importKey(
          "raw",
          rawBuffer,
          KEY_ALGO,
          true,
          [],
        );
      } catch {
        publicKey = { raw: new Uint8Array(rawBuffer) };
      }

      const contact = new MajikContact({
        id: data.id,
        publicKey,
        fingerprint: data.fingerprint,
        meta: { label: data.label },
        mlKey: data.mlKey,
        edPublicKeyBase64: data.edPublicKeyBase64,
        mlDsaPublicKeyBase64: data.mlDsaPublicKeyBase64,
      });

      await this.addContact(contact);
      return { success: true, message: "Contact imported successfully" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async importContactFromString(
    base64Str: string,
  ): Promise<MAJIK_API_RESPONSE> {
    try {
      const contact = await this.importContactCompressed(base64Str);
      await this.addContact(contact);
      return { success: true, message: "Contact imported successfully" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async exportContactCompressed(contact: MajikContact): Promise<string> {
    let publicKeyBase64: string;
    const anyPub: any = contact.publicKey;
    if (anyPub?.raw instanceof Uint8Array) {
      publicKeyBase64 = arrayBufferToBase64(anyPub.raw.buffer);
    } else {
      const raw = await crypto.subtle.exportKey(
        "raw",
        contact.publicKey as CryptoKey,
      );
      publicKeyBase64 = arrayBufferToBase64(raw);
    }

    const jsonObj: MajikContactCard = {
      id: contact.id,
      label: contact.meta?.label || "",
      publicKey: publicKeyBase64,
      fingerprint: contact.fingerprint,
      mlKey: contact.mlKey,
      edPublicKeyBase64: contact.edPublicKeyBase64,
      mlDsaPublicKeyBase64: contact.mlDsaPublicKeyBase64,
    };

    const compressed = gzipSync(
      new TextEncoder().encode(JSON.stringify(jsonObj)),
    );
    return arrayToBase64(compressed);
  }

  async importContactCompressed(base64Str: string): Promise<MajikContact> {
    const compressed = base64ToArrayBuffer(base64Str);
    const jsonStr = new TextDecoder().decode(
      gunzipSync(new Uint8Array(compressed)),
    );
    const data: MajikContactCard = JSON.parse(jsonStr);

    const rawBuffer = base64ToArrayBuffer(data.publicKey as string);
    let publicKey: CryptoKey | { raw: Uint8Array };
    try {
      publicKey = await crypto.subtle.importKey(
        "raw",
        rawBuffer,
        KEY_ALGO,
        true,
        [],
      );
    } catch {
      publicKey = { raw: new Uint8Array(rawBuffer) };
    }

    if (!data?.id || !publicKey || !data?.fingerprint || !data?.mlKey) {
      throw new Error("Invalid contact JSON");
    }

    return new MajikContact({
      id: data.id,
      publicKey,
      fingerprint: data.fingerprint,
      meta: { label: data.label },
      mlKey: data.mlKey,
      edPublicKeyBase64: data.edPublicKeyBase64,
      mlDsaPublicKeyBase64: data.mlDsaPublicKeyBase64,
    });
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  async toJSON(): Promise<MajikContactManagerJSON> {
    return {
      contacts: await this.directory.toJSON(),
      groups: this.groupManager.toJSON(),
    };
  }

  /**
   * Restore from a JSON snapshot into the current adapters.
   * Writes all contacts and groups through to the adapters.
   * Used after setAdapters() to migrate data into a new store.
   */
  async bulkRestoreFromJSON(data: MajikContactManagerJSON): Promise<void> {
    if (!data?.contacts || !data?.groups) {
      throw new MajikContactManagerError(
        "bulkRestoreFromJSON: invalid payload — expected { contacts, groups }",
      );
    }

    await this._contactAdapter.bulkSave(data.contacts.contacts);
    await this._groupAdapter.bulkSave(data.groups.groups);
    await this.hydrate();
  }

  static async fromJSON(
    data: MajikContactManagerJSON,
    adapters?: MajikContactManagerAdapters,
  ): Promise<MajikContactManager> {
    if (!data || typeof data !== "object") {
      throw new MajikContactManagerError(
        "fromJSON: invalid payload — expected { contacts, groups }",
      );
    }
    if (!data.contacts) {
      throw new MajikContactManagerError(
        "fromJSON: missing required field 'contacts'",
      );
    }
    if (!data.groups) {
      throw new MajikContactManagerError(
        "fromJSON: missing required field 'groups'",
      );
    }

    const manager = new MajikContactManager(undefined, undefined, adapters);
    await manager.bulkRestoreFromJSON(data);
    return manager;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Persists every group currently in the group manager to the adapter.
   * Used after bulk contact removal where multiple groups may be affected.
   */
  private async _persistAllGroups(): Promise<void> {
    const all = this.groupManager.listGroups(true);
    await this._groupAdapter.bulkSave(all.map((g) => g.toJSON()));
  }

  private static pruneOrphanedMembers(
    directory: MajikContactDirectory,
    groupManager: MajikContactGroupManager,
  ): void {
    const allGroups = groupManager.listGroups(true);
    for (const group of allGroups) {
      const orphans = group
        .listMemberIds()
        .filter((id) => !directory.hasContact(id));
      for (const orphanId of orphans) {
        group.removeMemberIfPresent(orphanId);
        groupManager.handleContactRemoved(orphanId);
      }
    }
  }

  private assertGroupManagerInstance(gm: unknown): void {
    if (!gm || !(gm instanceof MajikContactGroupManager)) {
      throw new MajikContactManagerError(
        "groupManager must be a valid MajikContactGroupManager instance",
      );
    }
  }
}
