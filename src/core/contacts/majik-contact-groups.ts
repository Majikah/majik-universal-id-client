/* -------------------------------
 * Types
 * ------------------------------- */

import {
  isSystemGroupId,
  MajikContact,
  MajikContactGroup,
  MajikContactGroupMeta,
  SYSTEM_GROUP_IDS,
} from "@majikah/majik-contact";
import { MajikContactDirectory } from "./majik-contact-directory";
import { MAJIK_API_RESPONSE } from "../types";
import { MajikContactGroupManagerError } from "./errors";
import { MajikContactGroupManagerData } from "./types";

/* -------------------------------
 * MajikContactGroupManager Class
 * ------------------------------- */

/**
 * Manages the full lifecycle of MajikContactGroup instances.
 *
 * Responsibilities:
 *  - Owns the canonical Map of all groups (user-created + system groups)
 *  - Maintains a reverse index: contactId → Set<groupId> for O(1) group lookups per contact
 *  - Hydrates group members into full MajikContact instances via an injected MajikContactDirectory
 *  - Automatically syncs system group side-effects (e.g. Blocked group ↔ MajikContact.block())
 *  - Provides a handleContactRemoved() hook for MajikContactDirectory to call on contact removal
 *  - Handles serialization / deserialization of all groups together
 *
 * System groups (Favorites, Blocked) are always present and are bootstrapped in the constructor.
 * They cannot be deleted or renamed but their membership is fully manageable.
 */
export class MajikContactGroupManager {
  private groups: Map<string, MajikContactGroup> = new Map();

  /**
   * Reverse index: contactId → Set of groupIds the contact belongs to.
   * Kept in sync on every membership mutation so getGroupsForContact() is O(1).
   */
  private contactGroupIndex: Map<string, Set<string>> = new Map();

  private directory: MajikContactDirectory;

  constructor(directory: MajikContactDirectory) {
    this.assertDirectory(directory);
    this.directory = directory;
    this.bootstrapSystemGroups();
  }

  /* ================================
   * Initialization
   * ================================ */

  /**
   * Ensures the two system groups always exist on construction.
   * Safe to call multiple times — skips if already present.
   */
  private bootstrapSystemGroups(): void {
    if (!this.groups.has(SYSTEM_GROUP_IDS.FAVORITES)) {
      const favorites = MajikContactGroup.createFavorites();
      this.groups.set(favorites.id, favorites);
    }
    if (!this.groups.has(SYSTEM_GROUP_IDS.BLOCKED)) {
      const blocked = MajikContactGroup.createBlocked();
      this.groups.set(blocked.id, blocked);
    }
  }

  /* ================================
   * Group CRUD
   * ================================ */

  /**
   * Creates and registers a new user group.
   * Throws if a group with the same ID already exists.
   */
  createGroup(
    id: string,
    name: string,
    meta?: Partial<Omit<MajikContactGroupMeta, "name">>,
    initialMemberIds?: string[],
  ): MajikContactGroup {
    this.assertGroupId(id);
    this.assertNotSystemId(id, "createGroup");

    if (this.groups.has(id)) {
      throw new MajikContactGroupManagerError(
        `Group with id "${id}" already exists`,
      );
    }

    if (initialMemberIds?.length) {
      this.assertContactsExist(initialMemberIds, "createGroup");
    }

    const group = MajikContactGroup.create(id, name, meta, initialMemberIds);
    this.groups.set(group.id, group);

    if (initialMemberIds?.length) {
      initialMemberIds.forEach((contactId) =>
        this.indexAdd(contactId, group.id),
      );
    }

    return group;
  }

  /**
   * Registers an already-constructed MajikContactGroup instance.
   * Useful when importing groups from external sources.
   * Throws if a group with the same ID already exists.
   */
  addGroup(group: MajikContactGroup): this {
    this.assertGroupInstance(group, "addGroup");
    this.assertNotSystemId(group.id, "addGroup");

    if (this.groups.has(group.id)) {
      throw new MajikContactGroupManagerError(
        `Group with id "${group.id}" already exists`,
      );
    }

    const memberIds = group.listMemberIds();
    if (memberIds.length) {
      this.assertContactsExist(memberIds, "addGroup");
    }

    this.groups.set(group.id, group);
    memberIds.forEach((contactId) => this.indexAdd(contactId, group.id));
    return this;
  }

  /**
   * Removes a user group by ID.
   * System groups cannot be deleted.
   * Cleans up the reverse index for all former members.
   */
  removeGroup(id: string): MAJIK_API_RESPONSE {
    this.assertGroupId(id);
    this.assertNotSystemId(id, "removeGroup");

    const group = this.groups.get(id);
    if (!group) {
      return { success: false, message: `Group "${id}" not found` };
    }

    const originalGroup = MajikContactGroup.fromJSON(group.toJSON());

    group
      .listMemberIds()
      .forEach((contactId) => this.indexRemove(contactId, id));
    this.groups.delete(id);

    return {
      success: true,
      message: "Group removed successfully",
      data: originalGroup,
    };
  }

  clear(): this {
    this.groups.clear();
    this.contactGroupIndex.clear();
    return this;
  }

  getGroup(id: string): MajikContactGroup | undefined {
    this.assertGroupId(id);
    return this.groups.get(id);
  }

  getGroupOrThrow(id: string): MajikContactGroup {
    const group = this.getGroup(id);
    if (!group) {
      throw new MajikContactGroupManagerError(`Group "${id}" not found`);
    }
    return group;
  }

  hasGroup(id: string): boolean {
    this.assertGroupId(id);
    return this.groups.has(id);
  }

  /**
   * Returns all groups, optionally filtered and/or sorted.
   *
   * @param includeSystem  Include system groups (Favorites, Blocked). Default: true.
   * @param sortedByName   Sort results by group name. Default: false.
   */
  listGroups(includeSystem = true, sortedByName = false): MajikContactGroup[] {
    let result = [...this.groups.values()];

    if (!includeSystem) {
      result = result.filter((g) => !g.isSystem);
    }

    if (sortedByName) {
      result.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    }

    return result;
  }

  /**
   * Updates mutable metadata fields on a group.
   * Name is protected on system groups (delegates to MajikContactGroup.updateName which throws).
   */
  updateGroupMeta(
    id: string,
    meta: Partial<
      Pick<MajikContactGroupMeta, "name" | "description" | "color">
    >,
  ): MajikContactGroup {
    const group = this.getGroupOrThrow(id);

    if (meta.name !== undefined) group.updateName(meta.name);
    if (meta.description !== undefined)
      group.updateDescription(meta.description);

    group.setColor(meta?.color || group.meta?.color);

    return group;
  }

  /* ================================
   * Membership Management
   * ================================ */

  /**
   * Adds a contact to a group.
   *
   * - Validates the contact exists in the directory.
   * - If the target group is the system Blocked group, also calls contact.block()
   *   on the directory to keep MajikContact state in sync.
   * - Throws if the contact is already a member (strict — use addMemberIfAbsent for idempotent).
   */
  addContactToGroup(groupId: string, contactId: string): MajikContactGroup {
    this.assertGroupId(groupId);
    this.assertContactId(contactId);

    const group = this.getGroupOrThrow(groupId);
    const contact = this.getContactOrThrow(contactId, "addContactToGroup");

    group.addMember(contactId);
    this.indexAdd(contactId, groupId);

    // Blocked group sync
    if (group.isBlocked() && !contact.isBlocked()) {
      contact.block();
    }

    return group;
  }

  /**
   * Idempotent variant — does not throw if the contact is already a member.
   * Still validates contact existence and handles Blocked sync.
   */
  addContactToGroupIfAbsent(
    groupId: string,
    contactId: string,
  ): MajikContactGroup {
    this.assertGroupId(groupId);
    this.assertContactId(contactId);

    const group = this.getGroupOrThrow(groupId);
    const contact = this.getContactOrThrow(
      contactId,
      "addContactToGroupIfAbsent",
    );

    if (!group.hasMember(contactId)) {
      group.addMember(contactId);
      this.indexAdd(contactId, groupId);

      if (group.isBlocked() && !contact.isBlocked()) {
        contact.block();
      }
    }

    return group;
  }

  /**
   * Adds multiple contacts to a group in one call.
   * All contacts are validated before any mutation is applied (all-or-nothing).
   */
  addContactsToGroup(groupId: string, contactIds: string[]): MajikContactGroup {
    this.assertGroupId(groupId);
    this.assertContactIdArray(contactIds, "addContactsToGroup");

    const group = this.getGroupOrThrow(groupId);

    // Validate all contacts exist before touching any state
    const contacts = contactIds.map((id) =>
      this.getContactOrThrow(id, "addContactsToGroup"),
    );

    // Check for existing membership up-front for a clean error
    const alreadyMembers = contactIds.filter((id) => group.hasMember(id));
    if (alreadyMembers.length > 0) {
      throw new MajikContactGroupManagerError(
        `addContactsToGroup: the following contacts are already members of "${group.meta.name}": ${alreadyMembers.join(", ")}`,
      );
    }

    contactIds.forEach((id, i) => {
      group.addMember(id);
      this.indexAdd(id, groupId);

      if (group.isBlocked() && !contacts[i].isBlocked()) {
        contacts[i].block();
      }
    });

    return group;
  }

  /**
   * Removes a contact from a group.
   *
   * - If removing from the system Blocked group, also calls contact.unblock()
   *   to keep MajikContact state in sync.
   * - Throws if the contact is not a member (strict — use removeContactFromGroupIfPresent for idempotent).
   */
  removeContactFromGroup(
    groupId: string,
    contactId: string,
  ): MajikContactGroup {
    this.assertGroupId(groupId);
    this.assertContactId(contactId);

    const group = this.getGroupOrThrow(groupId);

    group.removeMember(contactId); // throws if not a member
    this.indexRemove(contactId, groupId);

    // Blocked group sync — unblock only if not blocked by a different group
    if (group.isBlocked()) {
      this.syncUnblock(contactId);
    }

    return group;
  }

  /**
   * Idempotent variant — does not throw if the contact is not a member.
   */
  removeContactFromGroupIfPresent(
    groupId: string,
    contactId: string,
  ): MajikContactGroup {
    this.assertGroupId(groupId);
    this.assertContactId(contactId);

    const group = this.getGroupOrThrow(groupId);

    if (group.hasMember(contactId)) {
      group.removeMember(contactId);
      this.indexRemove(contactId, groupId);

      if (group.isBlocked()) {
        this.syncUnblock(contactId);
      }
    }

    return group;
  }

  /**
   * Moves a contact from one group to another atomically.
   * Throws if the contact is not a member of the source group.
   */
  moveContact(contactId: string, fromGroupId: string, toGroupId: string): void {
    this.assertContactId(contactId);
    this.assertGroupId(fromGroupId);
    this.assertGroupId(toGroupId);

    if (fromGroupId === toGroupId) {
      throw new MajikContactGroupManagerError(
        "moveContact: source and destination groups must be different",
      );
    }

    this.getContactOrThrow(contactId, "moveContact");

    // Validate both groups exist before touching state
    const fromGroup = this.getGroupOrThrow(fromGroupId);
    this.getGroupOrThrow(toGroupId);

    if (!fromGroup.hasMember(contactId)) {
      throw new MajikContactGroupManagerError(
        `moveContact: contact "${contactId}" is not a member of group "${fromGroupId}"`,
      );
    }

    this.removeContactFromGroup(fromGroupId, contactId);
    this.addContactToGroupIfAbsent(toGroupId, contactId);
  }

  /* ================================
   * Querying
   * ================================ */

  /**
   * Returns all group IDs the contact belongs to.
   * O(1) — backed by the reverse index.
   */
  getGroupIdsForContact(contactId: string): string[] {
    this.assertContactId(contactId);
    return [...(this.contactGroupIndex.get(contactId) ?? [])];
  }

  /**
   * Returns all groups the contact belongs to as MajikContactGroup instances.
   */
  getGroupsForContact(contactId: string): MajikContactGroup[] {
    this.assertContactId(contactId);
    const groupIds = this.contactGroupIndex.get(contactId) ?? new Set();
    return [...groupIds]
      .map((id) => this.groups.get(id))
      .filter((g): g is MajikContactGroup => g !== undefined);
  }

  /**
   * Returns all hydrated MajikContact instances that are members of the given group.
   * Contacts that exist in the group but have been removed from the directory are silently skipped.
   */
  getContactsInGroup(groupId: string): MajikContact[] {
    const group = this.getGroupOrThrow(groupId);
    return group
      .listMemberIds()
      .map((id) => this.directory.getContact(id))
      .filter((c): c is MajikContact => c !== undefined);
  }

  /**
   * Returns hydrated contacts that are members of the given group,
   * sorted by their display label (or ID if no label set).
   */
  getContactsInGroupSorted(groupId: string): MajikContact[] {
    return this.getContactsInGroup(groupId).sort((a, b) =>
      (a.meta.label || a.id).localeCompare(b.meta.label || b.id),
    );
  }

  /**
   * Returns true if the contact is a member of the given group.
   */
  isContactInGroup(groupId: string, contactId: string): boolean {
    this.assertGroupId(groupId);
    this.assertContactId(contactId);
    return this.groups.get(groupId)?.hasMember(contactId) ?? false;
  }

  /**
   * Returns true if the contact is in the system Favorites group.
   */
  isFavorite(contactId: string): boolean {
    this.assertContactId(contactId);
    return (
      this.groups.get(SYSTEM_GROUP_IDS.FAVORITES)?.hasMember(contactId) ?? false
    );
  }

  /**
   * Returns true if the contact is in the system Blocked group.
   */
  isBlocked(contactId: string): boolean {
    this.assertContactId(contactId);
    return (
      this.groups.get(SYSTEM_GROUP_IDS.BLOCKED)?.hasMember(contactId) ?? false
    );
  }

  /* ================================
   * System Group Convenience Methods
   * ================================ */

  addToFavorites(contactId: string): MajikContactGroup {
    return this.addContactToGroupIfAbsent(
      SYSTEM_GROUP_IDS.FAVORITES,
      contactId,
    );
  }

  removeFromFavorites(contactId: string): MajikContactGroup {
    return this.removeContactFromGroupIfPresent(
      SYSTEM_GROUP_IDS.FAVORITES,
      contactId,
    );
  }

  /**
   * Adds the contact to the Blocked group and calls contact.block() on the directory.
   */
  blockContact(contactId: string): MajikContactGroup {
    return this.addContactToGroupIfAbsent(SYSTEM_GROUP_IDS.BLOCKED, contactId);
  }

  /**
   * Removes the contact from the Blocked group.
   * Calls contact.unblock() only if the contact is not re-blocked by any other mechanism.
   */
  unblockContact(contactId: string): MajikContactGroup {
    return this.removeContactFromGroupIfPresent(
      SYSTEM_GROUP_IDS.BLOCKED,
      contactId,
    );
  }

  getFavoritesGroup(): MajikContactGroup {
    return this.getGroupOrThrow(SYSTEM_GROUP_IDS.FAVORITES);
  }

  getBlockedGroup(): MajikContactGroup {
    return this.getGroupOrThrow(SYSTEM_GROUP_IDS.BLOCKED);
  }

  /* ================================
   * Directory Sync Hook
   * ================================ */

  /**
   * Must be called whenever a contact is removed from MajikContactDirectory.
   * Auto-removes the contact from every group it belongs to and cleans up the reverse index.
   *
   * Usage:
   *   const response = directory.removeContact(id);
   *   if (response.success) manager.handleContactRemoved(id);
   */
  handleContactRemoved(contactId: string): void {
    this.assertContactId(contactId);

    const groupIds = this.contactGroupIndex.get(contactId);
    if (!groupIds || groupIds.size === 0) {
      this.contactGroupIndex.delete(contactId);
      return;
    }

    for (const groupId of [...groupIds]) {
      const group = this.groups.get(groupId);
      if (group?.hasMember(contactId)) {
        group.removeMemberIfPresent(contactId);
      }
    }

    this.contactGroupIndex.delete(contactId);
  }

  /* ================================
   * Serialization / Persistence
   * ================================ */

  toJSON(): MajikContactGroupManagerData {
    return {
      groups: [...this.groups.values()].map((g) => g.toJSON()),
    };
  }

  /**
   * Restores all groups from serialized data.
   * Clears existing user groups but preserves system groups (they are re-bootstrapped).
   * Rebuilds the reverse index from scratch.
   */
  fromJSON(data: MajikContactGroupManagerData): this {
    if (!data || !Array.isArray(data.groups)) {
      throw new MajikContactGroupManagerError(
        "fromJSON: invalid serialized data — expected { groups: [...] }",
      );
    }

    // Clear only user groups; system groups are re-bootstrapped below
    for (const [id] of this.groups) {
      if (!isSystemGroupId(id)) this.groups.delete(id);
    }
    this.contactGroupIndex.clear();

    // Re-bootstrap so system groups are always present
    this.bootstrapSystemGroups();

    for (const serialized of data.groups) {
      if (!serialized || typeof serialized !== "object" || !serialized.id) {
        throw new MajikContactGroupManagerError(
          "fromJSON: encountered an invalid serialized group entry",
        );
      }

      try {
        const group = MajikContactGroup.fromJSON(serialized);

        // System groups are already bootstrapped — just restore their membership
        if (isSystemGroupId(group.id)) {
          const existing = this.groups.get(group.id)!;
          existing.clearMembers();
          group.listMemberIds().forEach((cId) => {
            existing.addMemberIfAbsent(cId);
            this.indexAdd(cId, group.id);
          });
        } else {
          if (this.groups.has(group.id)) {
            throw new MajikContactGroupManagerError(
              `fromJSON: duplicate group id "${group.id}"`,
            );
          }
          this.groups.set(group.id, group);
          group.listMemberIds().forEach((cId) => this.indexAdd(cId, group.id));
        }
      } catch (err) {
        if (err instanceof MajikContactGroupManagerError) throw err;
        throw new MajikContactGroupManagerError(
          `fromJSON: failed to restore group "${serialized.id}"`,
          err,
        );
      }
    }

    return this;
  }

  /* ================================
   * Reverse Index Helpers
   * ================================ */

  private indexAdd(contactId: string, groupId: string): void {
    if (!this.contactGroupIndex.has(contactId)) {
      this.contactGroupIndex.set(contactId, new Set());
    }
    this.contactGroupIndex.get(contactId)!.add(groupId);
  }

  private indexRemove(contactId: string, groupId: string): void {
    const groupSet = this.contactGroupIndex.get(contactId);
    if (!groupSet) return;
    groupSet.delete(groupId);
    if (groupSet.size === 0) {
      this.contactGroupIndex.delete(contactId);
    }
  }

  /* ================================
   * Blocked Sync Helper
   * ================================ */

  /**
   * Unblocks a contact on the directory only if the contact is no longer
   * a member of the system Blocked group. Guards against a race where
   * the contact was re-added before unblock is processed.
   */
  private syncUnblock(contactId: string): void {
    const blockedGroup = this.groups.get(SYSTEM_GROUP_IDS.BLOCKED);
    const stillBlocked = blockedGroup?.hasMember(contactId) ?? false;

    if (!stillBlocked) {
      const contact = this.directory.getContact(contactId);
      if (contact?.isBlocked()) {
        contact.unblock();
      }
    }
  }

  /* ================================
   * Assertions / Validation
   * ================================ */

  private assertDirectory(directory: unknown): void {
    if (!directory || !(directory instanceof MajikContactDirectory)) {
      throw new MajikContactGroupManagerError(
        "MajikContactGroupManager requires a valid MajikContactDirectory instance",
      );
    }
  }

  private assertGroupId(id: string): void {
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      throw new MajikContactGroupManagerError(
        "Group ID must be a non-empty string",
      );
    }
  }

  private assertContactId(id: string): void {
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      throw new MajikContactGroupManagerError(
        "Contact ID must be a non-empty string",
      );
    }
  }

  private assertContactIdArray(ids: unknown, caller: string): void {
    if (!Array.isArray(ids)) {
      throw new MajikContactGroupManagerError(
        `${caller}: contactIds must be an array`,
      );
    }
    if (ids.length === 0) {
      throw new MajikContactGroupManagerError(
        `${caller}: contactIds array must not be empty`,
      );
    }
    ids.forEach((id, index) => {
      if (!id || typeof id !== "string" || id.trim().length === 0) {
        throw new MajikContactGroupManagerError(
          `${caller}: invalid contact ID at index ${index}`,
        );
      }
    });
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new MajikContactGroupManagerError(
        `${caller}: contactIds must not contain duplicates`,
      );
    }
  }

  private assertGroupInstance(group: unknown, caller: string): void {
    if (!group || !(group instanceof MajikContactGroup)) {
      throw new MajikContactGroupManagerError(
        `${caller}: expected a MajikContactGroup instance`,
      );
    }
  }

  private assertNotSystemId(id: string, caller: string): void {
    if (isSystemGroupId(id)) {
      throw new MajikContactGroupManagerError(
        `${caller}: cannot perform this operation on system group "${id}"`,
      );
    }
  }

  /**
   * Resolves a contact from the directory and throws a descriptive error if not found.
   */
  private getContactOrThrow(contactId: string, caller: string): MajikContact {
    const contact = this.directory.getContact(contactId);
    if (!contact) {
      throw new MajikContactGroupManagerError(
        `${caller}: contact "${contactId}" does not exist in the directory`,
      );
    }
    return contact;
  }

  /**
   * Validates that all provided contact IDs exist in the directory.
   * Collects all missing IDs and throws once with the full list,
   * rather than failing on the first missing contact.
   */
  private assertContactsExist(contactIds: string[], caller: string): void {
    const missing = contactIds.filter((id) => !this.directory.hasContact(id));
    if (missing.length > 0) {
      throw new MajikContactGroupManagerError(
        `${caller}: the following contacts do not exist in the directory: ${missing.join(", ")}`,
      );
    }
  }
}
