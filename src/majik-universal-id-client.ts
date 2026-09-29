/**
 * MajikUniversalIdClient.ts
 *
 */

import { MajikKey, MajikKeyAddress } from "@majikah/majik-key";

import {
  MajikContact,
  MajikContactGroup,
  MajikContactGroupMeta,
  type MajikContactMeta,
  type SerializedMajikContact,
} from "@majikah/majik-contact";

import {
  EnvelopeInput,
  FileLike,
  MajikSignature,
  MajikTimestamp,
} from "@majikah/majik-signature";
import {
  ExpectedSigner,
  MajikSignatureEnvelope,
  MajikSignatureEnvelopeJSON,
  MajikSignatureJSON,
  MajikSignerPublicKeys,
  SignOptions,
  VerificationResult,
} from "@majikah/majik-signature";

import { base64ToUint8Array } from "./core/utils/utilities";

import { MAJIK_API_RESPONSE } from "./core/types";
import {
  ImageSignatureStub,
  ImageSignOptions,
  ImageVerificationResult,
} from "@majikah/majik-signature/dist/core/stamp";

import {
  CreateUniversalIDOptions,
  MajikUniversalID,
} from "@majikah/majik-universal-id";
import { MajikUser } from "@thezelijah/majik-user";
import { MajikSLink } from "@majikah/majik-slink";
import { MajikContactDirectoryData } from "./core/contacts/types";
import {
  MajikContactManager,
  MajikContactManagerAdapters,
} from "./core/contacts/majik-contact-manager";

import { ClientStateManager } from "./core/client-state-manager";
import { MajikIdentity } from "@majikah/majik-universal-id/dist/core/types";
import {
  MajikKeyClient,
  MajikKeyClientBaseEvents,
  MajikKeyClientConfig,
} from "@majikah/majik-key-client";
import {
  ClientStateStorageAdapter,
  InMemoryClientStateAdapter,
  UserAppPreferences,
} from "./core/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

type MajikUniversalIdClientEvents =
  | MajikKeyClientBaseEvents
  | "create-id"
  | "sign"
  | "verify"
  | "new-stamp"
  | "removed-stamp"
  | "new-contact"
  | "new-contact-group"
  | "removed-contact"
  | "removed-contact-group"
  | "contact-group-change"
  | "history-log"
  | "activity-log";

export interface MajikUniversalIdClientConfig extends MajikKeyClientConfig {
  clientStateManager?: ClientStateManager;
  contactManager?: MajikContactManager;

  adapters?: MajikKeyClientConfig["adapters"] & {
    contacts?: MajikContactManagerAdapters;
  };
}

export interface SignResult {
  signature: MajikSignature;
  signerId: string;
  contentHash: string;
  timestamp: string;
  contentType?: string;
}

export interface VerifyResult extends VerificationResult {
  signerLabel?: string; // resolved from contact directory if available
}

export interface MajikUniversalIdClientJSON {
  id: string;
  contacts: MajikContactDirectoryData;
  ownAccounts?: {
    accounts: SerializedMajikContact[];
    order: string[];
  };
}

// ─── MajikUniversalIdClient ─────────────────────────────────────────────────────

export class MajikUniversalIdClient extends MajikKeyClient<
  MajikContact,
  MajikContactMeta,
  MajikUniversalIdClientEvents,
  ClientStateManager
> {
  private _contacts: MajikContactManager;

  private user_data: MajikUser | null = null;

  constructor(config: MajikUniversalIdClientConfig) {
    super(config);

    this._contacts =
      config.contactManager ??
      new MajikContactManager(undefined, undefined, config.adapters?.contacts);

    this._registerEventNames([
      "create-id",
      "sign",
      "verify",
      "new-stamp",
      "removed-stamp",
      "new-contact",
      "new-contact-group",
      "removed-contact",
      "removed-contact-group",
      "contact-group-change",
      "history-log",
      "activity-log",
    ]);
  }

  get user(): MajikUser | null {
    return this.user_data;
  }

  set user(user: MajikUser) {
    if (!user) {
      throw new Error("User cannot be null or undefined");
    }

    const userValidation = user.validate();

    if (!userValidation.isValid) {
      throw new Error(userValidation.errors.join(", "));
    }
    this.user_data = user;
  }

  clearUser(): void {
    this.user_data = null;
  }

  /**
   * Override — without this, MajikKeyClient's constructor falls back to
   * building a plain MajikKeyClientStateManager (ACCOUNT_ORDER only),
   * and every call to getUserAppPreferences() etc. throws at runtime.
   */
  protected _createDefaultStateManager(
    adapter?: ClientStateStorageAdapter,
  ): ClientStateManager {
    return new ClientStateManager(adapter ?? new InMemoryClientStateAdapter());
  }

  // ==========================================================================
  // ── MajikKeyClient HOOKS ──────────────────────────────────────────────────
  // ==========================================================================

  protected _buildOwnAccountContact(
    key: MajikKey,
    meta?: Partial<MajikContactMeta>,
  ): MajikContact {
    return key.toContact(meta);
  }

  protected async _onAccountRegistered(contact: MajikContact): Promise<void> {
    if (!this._contacts.hasContact(contact.id)) {
      await this._contacts.addContact(contact);
    }
  }

  protected async _onAccountRemoved(id: string): Promise<void> {
    await this._contacts.removeContact(id);
  }

  protected async _onResetKeyData(): Promise<void> {
    await this._contacts.clear();
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all domains from their adapters and restore client state.
   * Call once on startup.
   *
   * ```ts
   * const client = new MajikBuwizClient({ adapters: { keys: idbAdapter, ... } });
   * await client.hydrate();
   * ```
   */
  async hydrate(): Promise<void> {
    // 1. Keys — load into manager cache
    await this._keys.hydrate();

    // 2. Contacts + groups
    await this._contacts.hydrate();

    // 4. Client state — account order, invoice defaults, etc.
    await this._state.hydrate();

    // 5. Own accounts — rebuild from keys loaded in step 1
    await this._hydrateOwnAccounts();

    // 6. Account order — restore from state manager, prune stale IDs
    await this._restoreAccountOrder();
  }

  /**
   * Construct a client and immediately hydrate it.
   */
  static async create<T extends MajikUniversalIdClient>(
    this: new (config: MajikUniversalIdClientConfig) => T,
    config: MajikUniversalIdClientConfig = {},
  ): Promise<T> {
    const client = new this(config);
    await client.hydrate();
    return client;
  }

  /**
   * Resolve the decryption identity for an own account.
   * Ensures the account is unlocked and has ML-KEM keys.
   */
  private async _resolveIdentity(
    id: string,
    promptFn?: (id: string) => string | Promise<string>,
  ): Promise<MajikIdentity> {
    await this.keyManager.ensureUnlocked(id, promptFn);
    const key = this.keyManager.get(id);
    if (!key) throw new Error(`Account not found: ${id}`);
    if (!key.hasMlKem) {
      throw new Error(
        `Account "${id}" has no ML-KEM keys. ` +
          `Re-import via importAccountFromMnemonicBackup() to upgrade.`,
      );
    }
    return {
      fingerprint: key.fingerprint,
      mlKemSecretKey: key.getMlKemSecretKey(),
    } satisfies MajikIdentity;
  }

  // ==========================================================================
  // ── CONTACT MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  getContactByID(id: string): MajikContact | null {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.getContact(id) ?? null;
  }

  hasContact(id: string): boolean {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.hasContact(id);
  }

  async hasContactByAddress(publicKey: MajikKeyAddress): Promise<boolean> {
    if (!publicKey?.trim())
      throw new Error("Invalid contact public key address");
    return await this._contacts.hasContactByAddress(publicKey);
  }

  async getContactByAddress(
    address: MajikKeyAddress,
  ): Promise<MajikContact | null> {
    if (!address?.trim()) throw new Error("Invalid public key address");
    return (await this._contacts.getContactByAddress(address)) ?? null;
  }

  getContactsByID(ids: string[], strict = false): MajikContact[] {
    if (!ids?.length) throw new Error("At least 1 id is required");
    return this._contacts.getContactsByIds(ids, strict);
  }

  async getContactsByPublicKey(publicKeys: string[]): Promise<MajikContact[]> {
    if (!publicKeys?.length)
      throw new Error("At least 1 public key is required");
    return await this._contacts.getContactsByPublicKeys(publicKeys);
  }

  async exportContactAsJSON(id: string): Promise<string | null> {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.exportContactAsJSON(id);
  }

  async exportContactAsString(id: string): Promise<string | null> {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.exportContactAsString(id);
  }

  async importContactFromJSON(jsonStr: string): Promise<MAJIK_API_RESPONSE> {
    if (!jsonStr?.trim()) throw new Error("Invalid contact JSON");
    return this._contacts.importContactFromJSON(jsonStr);
  }

  async importContactFromString(
    base64Str: string,
  ): Promise<MAJIK_API_RESPONSE> {
    if (!base64Str?.trim()) throw new Error("Invalid contact string");

    const response = await this._contacts.importContactFromString(base64Str);

    if (response.success) {
      this._emit("new-contact", response.data);
    } else {
      this._emit("error", response.message);
    }

    return response;
  }

  async exportContactCompressed(contact: MajikContact): Promise<string> {
    if (!contact?.id?.trim()) throw new Error("Invalid contact");
    return this._contacts.exportContactCompressed(contact);
  }

  async importContactCompressed(base64Str: string): Promise<MajikContact> {
    if (!base64Str?.trim()) throw new Error("Invalid contact string");
    return this._contacts.importContactCompressed(base64Str);
  }

  async addContact(contact: MajikContact): Promise<void> {
    if (
      !contact?.id ||
      !contact?.publicKey ||
      !contact?.fingerprint ||
      !contact?.mlKey
    ) {
      throw new Error("Invalid contact — missing required fields");
    }
    await this._contacts.addContact(contact);

    this._emit("new-contact", contact);
  }

  async removeContact(id: string): Promise<void> {
    const result = await this._contacts.removeContact(id);
    if (!result.success) throw new Error(result.message);

    this._emit("removed-contact", id);
  }

  listContacts(
    includeOwnAccounts = false,
    majikahOnly: boolean = false,
  ): MajikContact[] {
    const contacts = this._contacts.listContacts(true, majikahOnly);
    if (includeOwnAccounts) return contacts;
    const ownIds = new Set(this.listOwnAccounts().map((a) => a.id));
    return contacts.filter((c) => !ownIds.has(c.id));
  }

  async updateContactMeta(
    id: string,
    meta: Partial<MajikContactMeta>,
  ): Promise<void> {
    await this._contacts.updateContactMeta(id, meta);
  }

  async createGroup(
    id: string,
    name: string,
    meta?: Partial<Omit<MajikContactGroupMeta, "name">>,
    initialMemberIds?: string[],
  ): Promise<this> {
    const newGroup = await this._contacts.createGroup(
      id,
      name,
      meta,
      initialMemberIds,
    );
    this._emit("new-contact-group", newGroup);
    return this;
  }

  async addGroup(group: MajikContactGroup): Promise<this> {
    await this._contacts.addGroup(group);
    this._emit("new-contact-group", group);
    return this;
  }

  async removeGroup(id: string): Promise<MAJIK_API_RESPONSE> {
    const response = await this._contacts.removeGroup(id);
    this._emit("removed-contact-group", response.data as MajikContactGroup);
    return response;
  }

  getContactGroup(id: string): MajikContactGroup | undefined {
    return this._contacts.getGroup(id);
  }

  getGroupOrThrow(id: string): MajikContactGroup {
    return this._contacts.getGroupOrThrow(id);
  }

  hasGroup(id: string): boolean {
    return this._contacts.hasGroup(id);
  }

  listContactGroups(
    includeSystem = true,
    sortedByName = false,
  ): MajikContactGroup[] {
    return this._contacts.listGroups(includeSystem, sortedByName);
  }

  listUserGroups(sortedByName = true): MajikContactGroup[] {
    return this._contacts.listGroups(false, sortedByName);
  }

  listSystemGroups(): MajikContactGroup[] {
    return this._contacts.listGroups(true).filter((g) => g.isSystem);
  }

  async updateGroupMeta(
    id: string,
    meta: Partial<
      Pick<MajikContactGroupMeta, "name" | "description" | "color">
    >,
  ): Promise<this> {
    const updatedGroup = await this._contacts.updateGroupMeta(id, meta);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  async addContactToGroup(groupID: string, contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.addContactToGroup(
      groupID,
      contactID,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  async addContactsToGroup(
    groupID: string,
    contactIds: string[],
  ): Promise<this> {
    const updatedGroup = await this._contacts.addContactsToGroup(
      groupID,
      contactIds,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  async removeContactFromGroup(
    groupID: string,
    contactID: string,
  ): Promise<this> {
    const updatedGroup = await this._contacts.removeContactFromGroup(
      groupID,
      contactID,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  async moveContactBetweenGroups(
    contactID: string,
    fromGroupId: string,
    toGroupId: string,
  ): Promise<this> {
    const updatedGroup = await this._contacts.moveContactBetweenGroups(
      contactID,
      fromGroupId,
      toGroupId,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  getContactsInGroup(groupID: string): MajikContact[] {
    return this._contacts.getContactsInGroup(groupID);
  }

  getContactsInGroupSorted(groupID: string): MajikContact[] {
    return this._contacts.getContactsInGroupSorted(groupID);
  }

  isContactInGroup(groupID: string, contactID: string): boolean {
    return this._contacts.isContactInGroup(groupID, contactID);
  }

  getGroupsForContact(contactID: string): MajikContactGroup[] {
    return this._contacts.getGroupsForContact(contactID);
  }

  getGroupIdsForContact(contactID: string): string[] {
    return this._contacts.getGroupIdsForContact(contactID);
  }

  async addContactToFavorites(contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.addToFavorites(contactID);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  async removeContactFromFavorites(contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.removeFromFavorites(contactID);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  isContactFavorite(contactID: string): boolean {
    return this._contacts.isFavorite(contactID);
  }
  isContactBlocked(contactID: string): boolean {
    return this._contacts.isContactBlocked(contactID);
  }
  getFavoritesGroup(): MajikContactGroup {
    return this._contacts.getFavoritesGroup();
  }
  getBlockedGroup(): MajikContactGroup {
    return this._contacts.getBlockedGroup();
  }

  getFavoriteContacts(): MajikContact[] {
    return this._contacts.getContactsInGroup(
      this._contacts.getFavoritesGroup().id,
    );
  }

  getBlockedContacts(): MajikContact[] {
    return this._contacts.getContactsInGroup(
      this._contacts.getBlockedGroup().id,
    );
  }

  async clearDirectory(): Promise<this> {
    await this._contacts.clear();
    return this;
  }

  resolveSignerLabel(signerId: string): string {
    const ownAccount = this._ownAccounts.get(signerId);
    if (ownAccount?.meta?.label) return ownAccount.meta.label;
    const contact = this._contacts.getContact(signerId);
    if (contact?.meta?.label) return contact.meta.label;
    return `${signerId.slice(0, 16)}…`;
  }

  // ── Signing ───────────────────────────────────────────────────────────────

  /**
   * Creates a cryptographic signature for text or raw bytes using a selected signing account. The selected account must have usable signing keys and be unlocked when the underlying operation requires private-key access.
   * @param content - Content to process, supplied as text or raw bytes.
   * @param options - Optional operation-specific settings.
   * @param accountId - Account identifier to use. When omitted, the currently active account is used where supported.
   * @returns The result of the sign operation (`Promise<SignResult>`).
   */
  async sign(
    content: Uint8Array | string,
    options?: SignOptions,
    accountId?: string,
  ): Promise<SignResult> {
    return this._withSigningKey(accountId, "sign", async (key) => {
      const signature = await MajikSignature.sign(content, key, options);

      const result: SignResult = {
        signature,
        signerId: signature.signerId,
        contentHash: signature.contentHash,
        timestamp: signature.timestamp,
        contentType: signature.contentType,
      };

      this._emit("sign", result);
      return result;
    });
  }

  /**
   * Sign content and immediately serialize to a base64 string.
   * Convenience wrapper around sign() + serialize().
   * @param content - Content to process, supplied as text or raw bytes.
   * @param options - Optional operation-specific settings.
   * @param accountId - Account identifier to use. When omitted, the currently active account is used where supported.
   * @returns The result of the sign and serialize operation (`Promise<string>`).
   */
  async signAndSerialize(
    content: Uint8Array | string,
    options?: SignOptions,
    accountId?: string,
  ): Promise<string> {
    const { signature } = await this.sign(content, options, accountId);
    return signature.serialize();
  }

  /**
   * Sign content and return the full JSON envelope.
   * Convenience wrapper around sign() + toJSON().
   * @param content - Content to process, supplied as text or raw bytes.
   * @param options - Optional operation-specific settings.
   * @param accountId - Account identifier to use. When omitted, the currently active account is used where supported.
   * @returns The result of the sign to j s o n operation (`Promise<MajikSignatureJSON>`).
   */
  async signToJSON(
    content: Uint8Array | string,
    options?: SignOptions,
    accountId?: string,
  ): Promise<MajikSignatureJSON> {
    const { signature } = await this.sign(content, options, accountId);
    return signature.toJSON();
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verify a signature against content.
   *
   * Public keys can be supplied directly, extracted from the envelope itself,
   * or resolved from a known MajikKey account or contact in the directory.
   *
   * No private key is needed. Safe to call on locked accounts.
   *
   * @param content     - The original content that was signed
   * @param signature   - MajikSignature instance, JSON object, or base64 string
   * @param publicKeys  - Optional. If omitted, public keys are extracted from
   *                        the envelope (self-reported — cross-check signerId
   *                        against a trusted source for full security).
   * @param now - Optional point-in-time used when evaluating temporal validity; defaults to the current time when omitted.
   * @returns The result of the verify operation (`VerifyResult`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  verify(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    publicKeys?: MajikSignerPublicKeys,
    now?: Date,
  ): VerifyResult {
    try {
      // Deserialize if base64 string
      const sig =
        typeof signature === "string"
          ? MajikSignature.deserialize(signature)
          : signature instanceof MajikSignature
            ? signature
            : MajikSignature.fromJSON(signature);

      // Resolve public keys
      const keys: MajikSignerPublicKeys =
        publicKeys ??
        (sig instanceof MajikSignature
          ? sig.extractPublicKeys()
          : MajikSignature.fromJSON(
              sig as MajikSignatureJSON,
            ).extractPublicKeys());

      const result = MajikSignature.verify(content, sig, keys, now);

      const verifyResult: VerifyResult = {
        ...result,
        signerLabel: result.signerId?.trim()
          ? this.resolveSignerLabel(result.signerId)
          : undefined,
      };

      this._emit("verify", verifyResult);
      return verifyResult;
    } catch (err) {
      this._emit("error", err, { context: "verify" });
      throw err;
    }
  }

  /**
   * Verify against a specific known MajikKey account.
   * Automatically extracts public keys from the key client.
   * Works on locked accounts — only public key fields are used.
   * @param content - Content to process, supplied as text or raw bytes.
   * @param signature - Signature value, supplied as a MajikSignature, JSON representation, or serialized string as supported by the method.
   * @param accountId - Account identifier to use. When omitted, the currently active account is used where supported.
   * @param now - Optional point-in-time used when evaluating temporal validity; defaults to the current time when omitted.
   * @returns The result of the verify with account operation (`VerifyResult`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  verifyWithAccount(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    accountId: string,
    now?: Date,
  ): VerifyResult {
    const key = this._keys.get(accountId);
    if (!key) throw new Error(`Account not found: "${accountId}"`);

    if (!key.hasSigningKeys) {
      throw new Error(
        `Account "${accountId}" has no signing public keys. ` +
          `Re-import via importAccountFromMnemonicBackup() to enable verification.`,
      );
    }

    const publicKeys = MajikSignature.publicKeysFromMajikKey(key);
    return this.verify(content, signature, publicKeys, now);
  }

  /**
   * Verify against a contact from the directory by their ID.
   * Useful when you have the signer's contact card stored locally.
   * @param content - Content to process, supplied as text or raw bytes.
   * @param signature - Signature value, supplied as a MajikSignature, JSON representation, or serialized string as supported by the method.
   * @param contactId - Contact identifier used to resolve and trust a signer.
   * @param now - Optional point-in-time used when evaluating temporal validity; defaults to the current time when omitted.
   * @returns The result of the verify with contact operation (`Promise<VerifyResult>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async verifyWithContact(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    contactId: string,

    now?: Date,
  ): Promise<VerifyResult> {
    const contact = this._contacts.getContact(contactId);
    if (!contact) throw new Error(`Contact not found: "${contactId}"`);

    const sig =
      typeof signature === "string"
        ? MajikSignature.deserialize(signature)
        : signature instanceof MajikSignature
          ? signature
          : MajikSignature.fromJSON(signature as MajikSignatureJSON);

    // Cross-check: the envelope's signerId must match the contact's fingerprint
    const envelopeSignerId =
      sig instanceof MajikSignature
        ? sig.signerId
        : (sig as MajikSignatureJSON).signerId;

    if (envelopeSignerId !== contact.fingerprint) {
      const result: VerifyResult = {
        valid: false,
        signerId: envelopeSignerId,
        contentHash:
          sig instanceof MajikSignature
            ? sig.contentHash
            : (sig as MajikSignatureJSON).contentHash,
        timestamp:
          sig instanceof MajikSignature
            ? sig.timestamp
            : (sig as MajikSignatureJSON).timestamp,
        signerLabel: this.resolveSignerLabel(envelopeSignerId),
        reason: "Signer does not match contact",
      };
      this._emit("verify", result);
      return result;
    }

    if (!contact.edPublicKeyBase64 || !contact.mlDsaPublicKeyBase64) {
      throw new Error(`Contact "${contactId}" has no signing public keys.`);
    }
    const publicKeys: MajikSignerPublicKeys = {
      signerId: contact.fingerprint,
      edPublicKey: base64ToUint8Array(contact.edPublicKeyBase64),
      mlDsaPublicKey: base64ToUint8Array(contact.mlDsaPublicKeyBase64),
    };

    return this.verify(content, sig, publicKeys, now);
  }

  /**
   * Batch verify multiple signatures against the same content.
   * Returns one VerifyResult per signature in the same order.
   * @param content - Content to process, supplied as text or raw bytes.
   * @param signatures - Collection of signatures to verify or process.
   * @param publicKeys - Collection of public keys used to resolve contacts or verify signatures.
   * @param now - Optional point-in-time used when evaluating temporal validity; defaults to the current time when omitted.
   * @returns The result of the verify batch operation (`VerifyResult[]`).
   */
  verifyBatch(
    content: Uint8Array | string,
    signatures: Array<MajikSignature | MajikSignatureJSON | string>,
    publicKeys?: MajikSignerPublicKeys,
    now?: Date,
  ): VerifyResult[] {
    return signatures.map((sig) => {
      try {
        return this.verify(content, sig, publicKeys, now);
      } catch (err) {
        this._emit("error", err, { context: "verifyBatch" });
        return {
          valid: false,
          signerId: "",
          contentHash: "",
          timestamp: "",
          signerLabel: undefined,
        };
      }
    });
  }
  // ── Text / Detached Signing ───────────────────────────────────────────────────

  /**
   * Convenience alias for signing a plain string.
   *
   * Identical to signContent() but accepts only strings — makes call-sites
   * that deal exclusively with text cleaner (no Uint8Array overload noise).
   *
   * @example
   *   const sig = await majik.signText("Hello world", { contentType: "text/plain" });
   *   const b64 = sig.serialize(); // store alongside the text
   */
  async signText(
    text: string,
    options?: {
      contentType?: string;
      timestamp?: string;
      accountId?: string;
    },
  ): Promise<MajikSignature> {
    if (!text?.trim())
      throw new Error("signText: text must be a non-empty string");
    return this.signContent(text, options);
  }

  /**
   * Sign content and return both the MajikSignature instance and a portable
   * base64-serialized string in one call.
   *
   * The serialized string is safe to store in a database column, embed in a
   * JSON field, pass in an HTTP header, or encode in a QR code alongside the
   * original content. Pass it back to verifyDetached() to verify.
   *
   * @example — sign a document and store the detached signature
   *   const { serialized } = await majik.signAndDetach(docBytes, {
   *     contentType: "application/pdf",
   *   });
   *   await db.insert({ doc_id, signature: serialized });
   *
   * @example — sign a text message
   *   const { signature, serialized } = await majik.signAndDetach("Hello!", {
   *     contentType: "text/plain",
   *   });
   */
  async signAndDetach(
    content: Uint8Array | string,
    options?: {
      contentType?: string;
      timestamp?: string;
      accountId?: string;
    },
  ): Promise<{ signature: MajikSignature; serialized: string }> {
    const signature = await this.signContent(content, options);
    return { signature, serialized: signature.serialize() };
  }

  // ── Text / Detached Verification ──────────────────────────────────────────────

  /**
   * Verify a plain string against a MajikSignature.
   *
   * Accepts the signature as a MajikSignature instance, a MajikSignatureJSON
   * object, or a base64-serialized string — whichever form is easiest at the
   * call-site.
   *
   * The signer can be identified by contact ID, raw public key base64, or a
   * MajikKey client. If none is provided the public keys embedded in the
   * signature envelope are used (self-reported — cross-check result.signerId
   * against a known contact fingerprint before trusting).
   *
   * @example
   *   const result = await majik.verifyText("Hello world", sig, {
   *     contactId: "contact_abc",
   *   });
   *   if (result.valid) console.log("Authentic");
   */
  async verifyText(
    text: string,
    signature: MajikSignature | MajikSignatureJSON | string,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
    },
  ): Promise<VerificationResult> {
    if (!text?.trim())
      throw new Error("verifyText: text must be a non-empty string");

    const sig =
      typeof signature === "string"
        ? MajikSignature.deserialize(signature)
        : signature;

    return this.verifyContent(text, sig, options);
  }
  /**
   * Verify content against a base64-serialized detached signature string.
   *
   * @example
   *     const row = await db.findOne({ doc_id });
   *     const result = await majik.verifyDetached(docBytes, row.signature, {
   *       contactId: row.signer_contact_id,
   *     });
   *     if (result.valid) console.log("Signed by", result.signerId);
   * @param content - Content to process, supplied as text or raw bytes.
   * @param serializedSignature - Detached serialized signature to parse and verify.
   * @param options - Optional operation-specific settings.
   * @returns The result of the verify detached operation (`Promise<VerificationResult>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async verifyDetached(
    content: Uint8Array | string,
    serializedSignature: string,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      now?: Date;
    },
  ): Promise<VerificationResult> {
    if (!serializedSignature?.trim()) {
      throw new Error(
        "verifyDetached: serializedSignature must be a non-empty string",
      );
    }

    let sig: MajikSignature;
    try {
      sig = MajikSignature.deserialize(serializedSignature);
    } catch {
      // Fallback: maybe caller passed raw JSON rather than base64
      try {
        sig = MajikSignature.fromJSON(serializedSignature);
      } catch {
        throw new Error(
          "verifyDetached: could not parse signature — expected a base64 " +
            "string from sig.serialize() or a JSON string from sig.toJSON()",
        );
      }
    }

    const verifyResult = await this.verifyContent(content, sig, options);

    return verifyResult;
  }

  // ── Signature Serialization Helpers ──────────────────────────────────────────

  /**
   * Deserialize a base64 signature string into a MajikSignature client.
   *
   * Round-trip partner for MajikSignature.serialize() / sig.toString().
   * Use when you have a stored base64 string and need to inspect or pass
   * the instance to another method.
   *
   * Throws MajikSignatureSerializationError on malformed input.
   *
   * @example
   *   const sig = majik.deserializeSignature(storedBase64);
   *   console.log(sig.signerId, sig.timestamp);
   */
  deserializeSignature(serialized: string): MajikSignature {
    if (!serialized?.trim()) {
      throw new Error("deserializeSignature: input must be a non-empty string");
    }
    return MajikSignature.deserialize(serialized);
  }

  /**
   * Extract lightweight metadata from a base64 or JSON signature string
   * without performing cryptographic verification.
   *
   * Useful for displaying "Signed by X at Y" in a UI before the user
   * explicitly triggers a verification step.
   *
   * Returns null if the string cannot be parsed as a MajikSignature.
   *
   * @example
   *   const meta = majik.getSignatureMetadata(storedSig);
   *   if (meta) {
   *     const contact = majik.getContactByID(meta.signerId);
   *     console.log(`Signed by ${contact?.meta?.label ?? meta.signerId} at ${meta.timestamp}`);
   *   }
   */
  getSignatureMetadata(serialized: string): {
    signerId: string;
    timestamp: string;
    contentType: string | undefined;
    contentHash: string;
    version: number;
  } | null {
    if (!serialized?.trim()) return null;

    try {
      let sig: MajikSignature;
      try {
        sig = MajikSignature.deserialize(serialized);
      } catch {
        sig = MajikSignature.fromJSON(serialized);
      }

      return {
        signerId: sig.signerId,
        timestamp: sig.timestamp,
        contentType: sig.contentType,
        contentHash: sig.contentHash,
        version: sig.version,
      };
    } catch {
      return null;
    }
  }

  // ── Signing Capability Guard ──────────────────────────────────────────────────

  /**
   * Check whether an account has signing keys without throwing.
   *
   * Use this as a fast boolean guard before showing signing UI or before
   * calling any sign* method — those methods throw if signing keys are absent,
   * so checking first lets you degrade gracefully (e.g. hide a "Sign" button).
   *
   * Checks the in-memory keystore cache only — the account must be loaded.
   * Returns false for unknown accounts rather than throwing.
   *
   * @example
   *   if (!majik.hasSigningCapability()) {
   *     showUpgradePrompt("Re-import your account to enable signing");
   *     return;
   *   }
   *   const sig = await majik.signText(message);
   */
  hasSigningCapability(accountId?: string): boolean {
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id) return false;
    const key = this._keys.get(id);
    return key?.hasSigningKeys === true;
  }

  // ── Content & File Signing ────────────────────────────────────────────────

  /**
   * Sign raw bytes or a string using the active account.
   *
   * @example
   *     const sig = await majik.signContent(documentBytes, { contentType: "application/pdf" });
   *     const b64 = sig.serialize(); // store alongside the document
   * @param content - Content to process, supplied as text or raw bytes.
   * @param options - Optional operation-specific settings.
   * @returns The result of the sign content operation (`Promise<MajikSignature>`).
   */
  async signContent(
    content: Uint8Array | string,
    options?: {
      contentType?: string;
      timestamp?: string;
      accountId?: string;
      validUntil?: string;
    },
  ): Promise<MajikSignature> {
    const { signature } = await this.sign(
      content,
      {
        contentType: options?.contentType,
        timestamp: options?.timestamp,
        validUntil: options?.validUntil,
      },
      options?.accountId,
    );
    return signature;
  }

  /**
   * Sign a file and embed the signature directly into it using the active account.
   *
   * @example
   *     const { blob: signedPdf } = await majik.signFile(pdfBlob);
   *
   * @example — non-active account
   *     const { blob } = await majik.signFile(wavBlob, { accountId: "acc_xyz" });
   * @param file - Input file or Blob-like value to sign, verify, inspect, or transform.
   * @param options - Optional operation-specific settings.
   * @returns The result of the sign file operation (`Promise<Awaited<ReturnType<typeof MajikSignature.signFile>>>`).
   */

  async signFile(
    file: FileLike,
    options?: {
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      accountId?: string;
      expectedSigners?: ExpectedSigner[];
      validUntil?: string;
      /** Pre-stamp original, when the current file's embedded envelope was
       *  destroyed by a wholesale re-encode (PDF flatten, image re-render,
       *  audio re-mux). Lets the prior signature chain be recovered. */
      priorSignedFile?: Blob;
      /** Optional note attached to this specific revision. */
      message?: string;
    },
  ): Promise<Awaited<ReturnType<typeof MajikSignature.signFile>>> {
    return this._withSigningKey(options?.accountId, "signFile", async (key) => {
      const signedResponse = await MajikSignature.signFile(file, key, {
        contentType: options?.contentType,
        timestamp: options?.timestamp,
        mimeType: options?.mimeType,
        expectedSigners: options?.expectedSigners,
        validUntil: options?.validUntil,
        priorSignedFile: options?.priorSignedFile,
        message: options?.message,
      });

      const signedBytes = new Uint8Array(
        await signedResponse.blob.arrayBuffer(),
      );

      return signedResponse;
    });
  }

  /**
   * Sign a file with a detached signature envelope.
   *
   * @example
   *     const { blob: signedPdf } = await majik.signFileDetached(pdfBlob);
   *
   * @example — non-active account
   *     const { blob } = await majik.signFileDetached(wavBlob, { accountId: "acc_xyz" });
   * @param file - Input file or Blob-like value to sign, verify, inspect, or transform.
   * @param options - Optional operation-specific settings.
   * @returns The result of the sign file detached operation (`Promise<Awaited<ReturnType<typeof MajikSignature.signFileDetached>>>`).
   */

  async signFileDetached(
    file: FileLike,
    options?: {
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      accountId?: string;
      expectedSigners?: ExpectedSigner[];
      validUntil?: string;
      existingEnvelope?: EnvelopeInput;
      tsa?: MajikTimestamp;
    },
  ): Promise<Awaited<ReturnType<typeof MajikSignature.signFileDetached>>> {
    return this._withSigningKey(
      options?.accountId,
      "signFileDetached",
      async (key) => {
        const signedResponse = await MajikSignature.signFileDetached(
          file,
          key,
          {
            contentType: options?.contentType,
            timestamp: options?.timestamp,
            mimeType: options?.mimeType,
            expectedSigners: options?.expectedSigners,
            existingEnvelope: options?.existingEnvelope,
            tsa: options?.tsa,
            validUntil: options?.validUntil,
          },
        );

        const envelopeBytes = signedResponse.envelope.toMJKSIGBytes();

        return signedResponse;
      },
    );
  }

  /**
   * Sign multiple files with one account in a single unlock.
   * Per-file failures are returned in `error`, not thrown; unlock/key failures
   * (no account, no signing keys) still throw, as before.
   * @param files - Collection of files to process as a batch.
   * @param options - Optional operation-specific settings.
   * @returns The result of the batch sign files operation (`Promise< Array<{ blob: Blob | null; signature: MajikSignature | null; serialized: string | null; handler: string | null; mimeType: string | null; error: Error | null; }> >`).
   */
  async batchSignFiles(
    files: Array<{
      file: Blob;
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      validUntil?: string;
    }>,
    options?: { accountId?: string },
  ): Promise<
    Array<{
      blob: Blob | null;
      signature: MajikSignature | null;
      serialized: string | null;
      handler: string | null;
      mimeType: string | null;
      error: Error | null;
    }>
  > {
    return this._withSigningKey(options?.accountId, "batchSignFiles", (key) =>
      Promise.all(
        files.map(
          async ({ file, contentType, timestamp, mimeType, validUntil }) => {
            try {
              const result = await MajikSignature.signFile(file, key, {
                contentType,
                timestamp,
                mimeType,
                validUntil,
              });

              return {
                blob: result.blob,
                signature: result.signature,
                serialized: result.signature.serialize(),
                handler: result.handler,
                mimeType: result.mimeType,
                error: null,
              };
            } catch (err) {
              this._emit("error", err, { context: "batchSignFiles" });
              return {
                blob: null,
                signature: null,
                serialized: null,
                handler: null,
                mimeType: null,
                error: err instanceof Error ? err : new Error(String(err)),
              };
            }
          },
        ),
      ),
    );
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verify raw bytes or a string against a MajikSignature.
   *
   * > ⚠️ When no signer is provided, the extracted public keys are self-reported
   * > by whoever created the signature. Always cross-check `result.signerId`
   * > against a known contact fingerprint before trusting the result.
   *
   * @example — verify against a known contact
   *     const result = await majik.verifyContent(docBytes, sig, { contactId: "contact_abc" });
   *     if (result.valid) console.log("Authentic, signed by:", result.signerId);
   * @param content - Content to process, supplied as text or raw bytes.
   * @param signature - Signature value, supplied as a MajikSignature, JSON representation, or serialized string as supported by the method.
   * @param options - Optional operation-specific settings.
   * @returns The result of the verify content operation (`Promise<VerificationResult>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async verifyContent(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      now?: Date;
    },
  ): Promise<VerificationResult> {
    try {
      const publicKeys = await this._resolveSignerPublicKeys(options);
      return this.verify(
        content,
        signature,
        publicKeys ?? undefined,
        options?.now,
      );
    } catch (err) {
      this._emit("error", err, { context: "verifyContent" });
      throw err;
    }
  }

  /**
   * Verify a file's embedded signature.
   *
   * @example — verify a signed PDF against a known contact
   *     const result = await majik.verifyFile(signedPdf, { contactId: "contact_abc" });
   *     if (result.valid) console.log("Verified:", result.signerId, result.timestamp);
   * @param file - Input file or Blob-like value to sign, verify, inspect, or transform.
   * @param options - Optional operation-specific settings.
   * @param source - History source recorded for the operation.
   * @returns The result of the verify file operation (`Promise<VerificationResult & { handler?: string; reason?: string }>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async verifyFile(
    file: FileLike,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      mimeType?: string;
      now?: Date;
    },
  ): Promise<VerificationResult & { handler?: string; reason?: string }> {
    try {
      const publicKeys = await this._resolveSignerPublicKeys(options);
      let result: VerificationResult & { handler?: string; reason?: string };

      if (publicKeys) {
        const results = await MajikSignature.verifyFile(file, publicKeys, {
          expectedSignerId: options?.expectedSignerId,
          mimeType: options?.mimeType,
          now: options?.now,
        });
        result = results[0];
      } else {
        const extracted = await MajikSignature.extractFrom(file, {
          mimeType: options?.mimeType,
        });
        if (!extracted.length) {
          result = {
            valid: false,
            signerId: "",
            contentHash: "",
            timestamp: new Date().toISOString(),
            reason: "No embedded signature found",
          };
        } else {
          // Honor expectedSignerId when resolving which embedded signature to
          // check — previously this always fell back to extracted[0], so every
          // iteration of a per-signer verify loop (verifySignersForFile) ended
          // up re-checking the SAME first signer instead of each one in turn.
          const targetSig = options?.expectedSignerId
            ? (extracted.find((s) => s.signerId === options.expectedSignerId) ??
              extracted[0])
            : extracted[0];

          const results = await MajikSignature.verifyFile(
            file,
            targetSig.extractPublicKeys(),
            {
              expectedSignerId: targetSig.signerId,
              mimeType: options?.mimeType,
              now: options?.now,
            },
          );
          result = results[0];
        }
      }

      return result;
    } catch (err) {
      this._emit("error", err, { context: "verifyFile" });
      throw err;
    }
  }

  /**
   * Verify a file's detached signature.
   *
   * @example — verify a signed PDF's detached signature against a known contact
   *     const result = await majik.verifyFileDetached(signedPdf, envelope, { contactId: "contact_abc" });
   *     if (result.valid) console.log("Verified:", result.signerId, result.timestamp);
   * @param file - Input file or Blob-like value to sign, verify, inspect, or transform.
   * @param envelope - Detached envelope containing the signatures associated with the file.
   * @param options - Optional operation-specific settings.
   * @param source - History source recorded for the operation.
   * @returns The result of the verify file detached operation (`Promise<VerificationResult & { handler?: string; reason?: string }>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async verifyFileDetached(
    file: FileLike,
    envelope: EnvelopeInput,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      mimeType?: string;
      now?: Date;
    },
  ): Promise<VerificationResult & { handler?: string; reason?: string }> {
    try {
      const publicKeys = await this._resolveSignerPublicKeys(options);
      let result: VerificationResult & { handler?: string; reason?: string };

      if (publicKeys) {
        const results = await MajikSignature.verifyFileDetached(
          file,
          envelope,
          publicKeys,
          {
            expectedSignerId: options?.expectedSignerId,
            mimeType: options?.mimeType,
          },
        );
        result = results[0];
      } else {
        const resolvedEnvelope = await MajikSignatureEnvelope.from(envelope);
        const firstSigJson = resolvedEnvelope.signatures[0];

        if (!firstSigJson) {
          result = {
            valid: false,
            signerId: "",
            contentHash: "",
            timestamp: new Date().toISOString(),
            reason: "Envelope contains no signatures",
          };
        } else {
          const targetSig = options?.expectedSignerId
            ? (resolvedEnvelope.signatures.find(
                (s) => s.signerId === options.expectedSignerId,
              ) ?? resolvedEnvelope.signatures[0])
            : resolvedEnvelope.signatures[0];

          const parsedTargetSig = MajikSignature.fromJSON(targetSig);

          const results = await MajikSignature.verifyFileDetached(
            file,
            resolvedEnvelope,
            parsedTargetSig.extractPublicKeys(),
            {
              expectedSignerId: parsedTargetSig.signerId,
              mimeType: options?.mimeType,
              now: options?.now,
            },
          );
          result = results[0];
        }
      }

      return result;
    } catch (err) {
      this._emit("error", err, { context: "verifyFileDetached" });
      throw err;
    }
  }

  // ── Verify ALL signatures (embedded) ──────────────────────────────────────

  /**
   * Verify every embedded signature in a file, each checked against its own
   * self-reported public keys.
   *
   * ⚠️ Self-reported: for each result, cross-check `signerId` against your
   * contact directory (see `resolveSignerLabel`) before trusting authenticity.
   * A tampered envelope can carry a signature whose self-reported keys pass
   * verification but don't belong to who they claim to be.
   */
  async verifyFileAllSignatures(
    file: Blob,
    options?: { mimeType?: string },
  ): Promise<VerifyResult[]> {
    try {
      const signatures = await this.extractSignature(file, options);
      if (!signatures.length) {
        return [
          {
            valid: false,
            signerId: "",
            contentHash: "",
            timestamp: new Date().toISOString(),
            reason: "No embedded signature found",
          } as VerifyResult,
        ];
      }

      const strippedBlob = await this.stripSignature(file, options);
      const contentBytes = new Uint8Array(await strippedBlob.arrayBuffer());

      return signatures.map((sig) => {
        try {
          const result = MajikSignature.verify(
            contentBytes,
            sig,
            sig.extractPublicKeys(),
          );

          return {
            ...result,
            signerLabel: result.signerId
              ? this.resolveSignerLabel(result.signerId)
              : undefined,
          };
        } catch (err) {
          return {
            valid: false,
            signerId: sig.signerId,
            contentHash: sig.contentHash,
            timestamp: sig.timestamp,
            reason: err instanceof Error ? err.message : String(err),
          } as VerifyResult;
        }
      });
    } catch (err) {
      this._emit("error", err, { context: "verifyFileAllSignatures" });
      throw err;
    }
  }

  // ── Verify ALL signatures (detached) ──────────────────────────────────────

  /**
   * Verify every signature inside a detached envelope against the stripped
   * content, each checked against its own self-reported public keys.
   */
  async verifyFileDetachedAllSignatures(
    file: Blob,
    envelope:
      | MajikSignatureEnvelope
      | MajikSignatureEnvelopeJSON
      | Uint8Array
      | Blob,
  ): Promise<VerifyResult[]> {
    try {
      const resolvedEnvelope = await MajikSignatureEnvelope.from(envelope);

      const integrity = resolvedEnvelope.verifyAllowlistIntegrity();
      if (!integrity.valid) {
        return [
          {
            valid: false,
            signerId: "",
            contentHash: "",
            timestamp: new Date().toISOString(),
            reason: integrity.reason,
          } as VerifyResult,
        ];
      }

      const signatures = resolvedEnvelope.signatures;
      if (!signatures.length) {
        return [
          {
            valid: false,
            signerId: "",
            contentHash: "",
            timestamp: new Date().toISOString(),
            reason: "Envelope contains no signatures",
          } as VerifyResult,
        ];
      }

      const contentBytes = new Uint8Array(await file.arrayBuffer());
      const activeFingerprint = this.getActiveAccountKey()?.fingerprint;

      return signatures.map((sigJson) => {
        try {
          const sig = MajikSignature.fromJSON(sigJson);
          const result = MajikSignature.verify(
            contentBytes,
            sig,
            sig.extractPublicKeys(),
          );

          return {
            ...result,
            signerLabel: result.signerId
              ? this.resolveSignerLabel(result.signerId)
              : undefined,
          };
        } catch (err) {
          return {
            valid: false,
            signerId: sigJson.signerId,
            contentHash: sigJson.contentHash,
            timestamp: sigJson.timestamp,
            reason: err instanceof Error ? err.message : String(err),
          } as VerifyResult;
        }
      });
    } catch (err) {
      this._emit("error", err, { context: "verifyFileDetachedAllSignatures" });
      throw err;
    }
  }

  /**
   * Verify multiple files' embedded signatures against the same signer in
   * one call.
   *
   * @example
   *   const results = await majik.batchVerifyFiles(
   *     [pdfBlob, wavBlob, mp4Blob],
   *     { contactId: "contact_abc" },
   *   );
   *   const allValid = results.every(r => r.valid);
   */
  async batchVerifyFiles(
    files: Array<
      Blob | { file: Blob; mimeType?: string; expectedSignerId?: string }
    >,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
    },
  ): Promise<
    Array<
      VerificationResult & {
        handler: string | undefined;
        mimeType: string | undefined;
        error: Error | null;
      }
    >
  > {
    const publicKeys = await this._resolveSignerPublicKeys(options).catch(
      () => null,
    );
    const activeFingerprint = this.getActiveAccountKey()?.fingerprint;

    return Promise.all(
      files.map(async (entry) => {
        const { file, mimeType, expectedSignerId } =
          entry instanceof Blob
            ? {
                file: entry,
                mimeType: undefined,
                expectedSignerId: options?.expectedSignerId,
              }
            : {
                ...entry,
                expectedSignerId:
                  entry.expectedSignerId ?? options?.expectedSignerId,
              };

        try {
          let result: VerificationResult;

          if (publicKeys) {
            const results = await MajikSignature.verifyFile(file, publicKeys, {
              mimeType,
              expectedSignerId,
            });
            result = results[0];
          } else {
            const extracted = await MajikSignature.extractFrom(file, {
              mimeType,
            });
            if (!extracted.length) {
              return {
                valid: false,
                signerId: undefined,
                contentHash: undefined,
                timestamp: new Date().toISOString(),
                reason: "No embedded signature found",
                handler: undefined,
                mimeType,
                error: null,
              };
            }

            const firstSig = extracted[0];
            const results = await MajikSignature.verifyFile(
              file,
              firstSig.extractPublicKeys(),
              { mimeType, expectedSignerId: firstSig.signerId },
            );
            result = results[0];
          }

          return { ...result, handler: result.handler, mimeType, error: null };
        } catch (err) {
          this._emit("error", err, { context: "batchVerifyFiles" });
          return {
            valid: false,
            signerId: undefined,
            contentHash: undefined,
            timestamp: new Date().toISOString(),
            handler: undefined,
            mimeType,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );
  }

  // ── Signature Utilities ───────────────────────────────────────────────────

  /**
   * Extract the embedded MajikSignature from a file.
   * Does not verify — use verifyFile() to verify.
   */
  async extractSignature(
    file: Blob,
    options?: { mimeType?: string },
  ): Promise<MajikSignature[]> {
    try {
      return MajikSignature.extractFrom(file, options);
    } catch (err) {
      this._emit("error", err, { context: "extractSignature" });
      throw err;
    }
  }
  /**
   * Return a clean copy of the file with any embedded signature removed.
   * The returned bytes are exactly what was originally signed.
   *
   * Useful before re-processing or re-encrypting a signed file.
   *
   * @example
   *   const originalBlob = await majik.stripSignature(signedMp4);
   */
  async stripSignature(
    file: Blob,
    options?: { mimeType?: string },
  ): Promise<Blob> {
    try {
      return MajikSignature.stripFrom(file, options);
    } catch (err) {
      this._emit("error", err, { context: "stripSignature" });
      throw err;
    }
  }

  /**
   * Check whether a file contains an embedded MajikSignature.
   * Does not verify — purely a structural presence check.
   *
   * @example
   *   if (await majik.isFileSigned(file)) {
   *     const result = await majik.verifyFile(file, { contactId });
   *   }
   */
  async isFileSigned(
    file: Blob,
    options?: { mimeType?: string },
  ): Promise<boolean> {
    try {
      return MajikSignature.isSigned(file, options);
    } catch (err) {
      this._emit("error", err, { context: "isFileSigned" });
      throw err;
    }
  }

  /**
   * Get the public keys for the active account, ready for use with
   * MajikSignature.verify() or for sharing with another party.
   *
   * Works on locked keys — only reads public fields.
   *
   * @example
   *   const myKeys = await majik.getSigningPublicKeys();
   *   // share myKeys with someone so they can verify your signatures
   */
  async getSigningPublicKeys(
    accountId?: string,
  ): Promise<MajikSignerPublicKeys> {
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    const key = this._keys.get(id);
    if (!key) throw new Error(`Account not found in keystore: "${id}"`);
    if (!key.hasSigningKeys) {
      throw new Error(
        `Account "${id}" has no signing keys. ` +
          `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
      );
    }

    return MajikSignature.publicKeysFromMajikKey(key);
  }

  /**
   * Re-sign a file blob — strips any existing embedded signature, signs
   * with the active (or specified) account, and returns the newly signed blob.
   *
   * Use after key rotation or when the signing account changes. The returned
   * blob is the same format as the input — PDF stays PDF, WAV stays WAV.
   *
   * Distinct from resignMajikFile() which operates on a MajikFile instance
   * (the encrypted .mjkb container). This operates on a plain file Blob.
   *
   * @example
   *   const { blob } = await majik.resignFile(oldSignedPdf);
   *   await r2.put(key, await blob.arrayBuffer());
   */
  async resignFile(
    file: Blob,
    options?: {
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      accountId?: string;
    },
  ): Promise<{
    blob: Blob;
    signature: MajikSignature;
    handler: string;
    mimeType: string;
  }> {
    // signFile already strips before signing — resignFile is a named alias
    // that makes the caller's intent explicit at the call-site.
    return this.signFile(file, options);
  }

  /**
   * Extract metadata from a file's embedded signature without verifying it.
   *
   * Useful for rendering "Signed by X at Y" in a UI before the user
   * explicitly triggers a verify step, or for routing to the correct
   * contact record before calling verifyFile().
   *
   * Returns null if the file has no embedded signature or the JSON is
   * structurally malformed.
   *
   * @example
   *   const info = await majik.getFileSignatureInfo(pdfBlob);
   *   if (info) {
   *     const contact = majik.getContactByID(info.signerId);
   *     console.log(`Signed by ${contact?.meta?.label ?? info.signerId}`);
   *     console.log(`Format handled by: ${info.handler}`);
   *   }
   */
  async getFileSignatureInfo(
    file: Blob,
    options?: { mimeType?: string },
  ): Promise<MajikSignature[] | null> {
    try {
      return MajikSignature.extractFrom(file, options);
    } catch (err) {
      this._emit("error", err, { context: "getFileSignatureInfo" });
      throw err;
    }
  }

  // ── Majik SLink ───────────────────────────

  async signURL(
    url: string,
    muid: string,
    verified: boolean = false,
  ): Promise<MajikSLink> {
    const id = this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    if (!this.user)
      throw new Error("Login required - A valid Majikah account is required");

    try {
      await this._keys.ensureUnlocked(id);
      const key = this._keys.get(id);
      if (!key) throw new Error(`Account not found in keystore: "${id}"`);
      if (!key.hasSigningKeys) {
        throw new Error(
          `Account "${id}" has no signing keys. ` +
            `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
        );
      }

      return await MajikSLink.create(url, key, this.user.id, muid, {
        status: verified ? "verified" : undefined,
      });
    } catch (err) {
      this._emit("error", err, { context: "signURL" });
      throw err;
    }
  }

  async verifySLink(
    slink: MajikSLink,
  ): Promise<VerificationResult & { handler?: string; reason?: string }> {
    try {
      const id = this.getActiveAccount()?.id;
      if (!id)
        throw new Error("No active account — call setActiveAccount() first");

      await this._keys.ensureUnlocked(id);
      const key = this._keys.get(id);
      if (!key) throw new Error(`Account not found in keystore: "${id}"`);

      const publicKeys = await this._resolveSignerPublicKeys({
        key: key,
      });

      if (!publicKeys) {
        throw new Error("No public keys available for verification.");
      }

      const results = slink.verify(publicKeys);
      return results;
    } catch (err) {
      this._emit("error", err, { context: "verifySLink" });
      throw err;
    }
  }

  // ── Identity / Passphrase ─────────────────────────────────────────────────

  /**
   * Ensure an identity is unlocked.
   * Delegates entirely to this._keys.ensureUnlocked() — passphrase prompting
   * is handled there via onUnlockRequested or the optional promptFn.
   */
  async ensureIdentityUnlocked(
    id: string,
    promptFn?: (id: string) => string | Promise<string>,
  ): Promise<CryptoKey | { raw: Uint8Array }> {
    return this._keys.ensureUnlocked(id, promptFn);
  }

  async isPassphraseValid(passphrase: string, id?: string): Promise<boolean> {
    const target = id ? this.getOwnAccountById(id) : this.getActiveAccount();
    if (!target) return false;
    return this._keys.isPassphraseValid(target.id, passphrase);
  }

  // ── Private: Signer resolution ────────────────────────────────────────────

  /**
   *
   * Callers pass { contactId, publicKeyBase64 } but the old resolver only read
   * { contactID, address }. Result: contactId was silently ignored, the method
   * returned null, and verifyContent/verifyFile/verifyFileDetached/batchVerifyFiles
   * fell back to SELF-REPORTED envelope keys — i.e. "verify against a known
   * contact" wasn't happening. This accepts both spellings.
   *
   * (Assumes publicKeyBase64 is the contact's MajikKeyAddress, as in
   *  getContactByAddress — adjust if not.)
   * @param options - Optional operation-specific settings.
   * @returns The result of the resolve signer public keys operation (`Promise<MajikSignerPublicKeys | null>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  private async _resolveSignerPublicKeys(options?: {
    contactId?: string;
    address?: MajikKeyAddress;
    publicKeyBase64?: string;
    key?: MajikKey;
    expectedSignerId?: string;
  }): Promise<MajikSignerPublicKeys | null> {
    if (!options) return null;

    if (options.key) return MajikSignature.publicKeysFromMajikKey(options.key);
    const contactId = options.contactId;
    const address = options.address ?? options.publicKeyBase64;
    let contact: MajikContact | undefined | null;

    if (contactId) {
      contact = this._contacts.getContact(contactId);
      if (!contact) throw new Error(`No contact found for id "${contactId}"`);

      const own = this._keys.get(contactId);
      if (own?.hasSigningKeys)
        return MajikSignature.publicKeysFromMajikKey(own);
    } else if (address) {
      contact = await this._contacts.getContactByAddress(address);
      if (!contact)
        throw new Error(`No contact found for public key "${address}"`);
    } else {
      return null;
    }

    if (!contact.edPublicKeyBase64 || !contact.mlDsaPublicKeyBase64) {
      throw new Error(
        `Contact "${contact.id}" has no signing public keys. ` +
          `They may need to share an updated contact card.`,
      );
    }

    return {
      signerId: contact.fingerprint,
      edPublicKey: base64ToUint8Array(contact.edPublicKeyBase64),
      mlDsaPublicKey: base64ToUint8Array(contact.mlDsaPublicKeyBase64),
    };
  }

  /**
   * One place for unlock -> signing-keys check -> one-time-unlock relock.
   * New methods use this; you can migrate sign()/signFile()/seal() onto it later
   * to delete the copy-pasted boilerplate.
   * @param accountId - Account identifier to use. When omitted, the currently active account is used where supported.
   * @param context - Value used by the _with signing key operation.
   * @param fn - Value used by the _with signing key operation.
   * @returns The result of the with signing key operation (`Promise<T>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  private async _withSigningKey<T>(
    accountId: string | undefined,
    context: string,
    fn: (key: MajikKey) => Promise<T>,
  ): Promise<T> {
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    let key: MajikKey | undefined;
    let shouldRelock = false;
    try {
      await this._keys.ensureUnlocked(id);
      key = this._keys.get(id);
      if (!key) throw new Error(`Account not found in keystore: "${id}"`);
      if (!key.hasSigningKeys) {
        throw new Error(
          `Account "${id}" has no signing keys. ` +
            `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
        );
      }
      shouldRelock = !(await this.isOnetimeUnlockEnabled());
      return await fn(key);
    } catch (err) {
      this._emit("error", err, { context });
      throw err;
    } finally {
      if (shouldRelock) key?.lock();
    }
  }

  /**
   * Create a new MajikUniversalID from a MajikUser and an unlocked MajikKey.
   *
   * The key must be unlocked and have all key fields: edPublicKey, mlDsaPublicKey,
   * mlKemPublicKey (for encryption), and mlKemSecretKey is not needed here —
   * only the public key is used during creation.
   *
   * Private personal info is immediately encrypted with the bound key's
   * ML-KEM-768 public key. The rehydrated value is kept in-memory so
   * privateInfo is accessible right after create() without a separate call.
   *
   * The identity starts at IDTier.UNVERIFIED.
   */
  async createUniversalID(
    user: MajikUser,
    key: MajikKey,
    options: CreateUniversalIDOptions,
  ): Promise<MajikUniversalID> {
    const createdID = MajikUniversalID.create(user, key, options);

    this._emit("create-id", createdID);
    return createdID;
  }

  // ==========================================================================
  // ── USER APP PREFERENCES ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Retrieve persisted user app prefernces, or `null` if none have been saved.
   */
  async getUserAppPreferences(): Promise<UserAppPreferences> {
    return this.stateManager.getUserAppPreferences();
  }

  /**
   * Persist user app prefernces.
   */
  async setUserAppPreferences(preferences: UserAppPreferences): Promise<void> {
    await this.stateManager.setUserAppPreferences(preferences);
  }

  /**
   * Remove persisted user app prefernces.
   */
  async removeUserAppPreferences(): Promise<void> {
    await this.stateManager.removeUserAppPreferences();
  }

  /**
   * Reset persisted user app prefernces to default settings.
   */
  async resetUserAppPreferences(): Promise<void> {
    await this.stateManager.resetUserAppPreferences();
  }

  async isAnalyticsEnabled(): Promise<boolean> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.privacy.shareAnalytics ?? false;
  }

  async isAutoLockOnMinimizeEnabled(): Promise<boolean> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.autoLockOnMinimize ?? false;
  }

  async autoLockInterval(): Promise<number | undefined> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.autoLockInterval;
  }

  async isOnetimeUnlockEnabled(): Promise<boolean> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.onetimeUnlock ?? true;
  }

  // ==========================================================================
  // ── ACCOUNT MANAGEMENT (overrides / additions on top of MajikKeyClient) ──
  // ==========================================================================

  /**
   * Update the metadata (e.g., label) of an owned account.
   * This updates both the contact directory and the local ownAccounts cache.
   */
  async updateOwnAccountMeta(
    id: string,
    meta: Partial<MajikContactMeta>,
  ): Promise<void> {
    if (!this._ownAccounts.has(id)) {
      throw new Error(`Account not found in own accounts: "${id}"`);
    }

    // 1. Update the contact record in the shared directory
    await this._contacts.updateContactMeta(id, meta);
    if (meta.label && meta.label.trim()) {
      await this.keyManager.updateLabel(id, meta.label);
    }

    // 2. Fetch the updated contact and sync the local _ownAccounts map
    const updatedContact = this._contacts.getContact(id);
    if (updatedContact) {
      this._ownAccounts.set(id, updatedContact);
    }
  }

  async hasOwnIdentity(fingerprint: string): Promise<boolean> {
    return this.keyManager.has(fingerprint);
  }
}
