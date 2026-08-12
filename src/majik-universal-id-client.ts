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

import { MajikSignature } from "@majikah/majik-signature";
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
   * Sign content with the active account.
   *
   * The active account must be unlocked and have signing keys.
   * Use unlockAccount() first if needed.
   *
   * @param content     - Raw bytes or UTF-8 string to sign
   * @param options     - Optional content type and timestamp override
   * @param accountId   - Override which account signs. Defaults to active account.
   */
  async sign(
    content: Uint8Array | string,
    options?: SignOptions,
    accountId?: string,
  ): Promise<SignResult> {
    try {
      const id = accountId ?? this.getActiveAccount()?.id;
      if (!id)
        throw new Error("No active account — call setActiveAccount() first");

      const key = this._keys.get(id);
      if (!key) throw new Error(`Account not found in keystore: "${id}"`);

      if (key.isLocked) {
        throw new Error(
          `Account "${id}" is locked. Call unlockAccount() before signing.`,
        );
      }

      if (!key.hasSigningKeys) {
        throw new Error(
          `Account "${id}" has no signing keys. ` +
            `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
        );
      }

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
    } catch (err) {
      this._emit("error", err, { context: "sign" });
      throw err;
    }
  }

  /**
   * Sign content and immediately serialize to a base64 string.
   * Convenience wrapper around sign() + serialize().
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
   *                      the envelope (self-reported — cross-check signerId
   *                      against a trusted source for full security).
   */
  verify(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    publicKeys?: MajikSignerPublicKeys,
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

      const result = MajikSignature.verify(content, sig, keys);

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
   */
  verifyWithAccount(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    accountId: string,
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
    return this.verify(content, signature, publicKeys);
  }

  /**
   * Verify against a contact from the directory by their ID.
   * Useful when you have the signer's contact card stored locally.
   */
  async verifyWithContact(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON | string,
    contactId: string,
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
      };
      this._emit("verify", result);
      return result;
    }

    const edPublicKeyBase64 =
      sig instanceof MajikSignature
        ? sig.signerEdPublicKey
        : (sig as MajikSignatureJSON).signerEdPublicKey;

    const mlDsaPublicKeyBase64 =
      sig instanceof MajikSignature
        ? sig.signerMlDsaPublicKey
        : (sig as MajikSignatureJSON).signerMlDsaPublicKey;

    const publicKeys: MajikSignerPublicKeys = {
      signerId: contact.fingerprint,
      edPublicKey: base64ToUint8Array(edPublicKeyBase64),
      mlDsaPublicKey: base64ToUint8Array(mlDsaPublicKeyBase64),
    };

    return this.verify(content, sig, publicKeys);
  }

  /**
   * Batch verify multiple signatures against the same content.
   * Returns one VerifyResult per signature in the same order.
   */
  verifyBatch(
    content: Uint8Array | string,
    signatures: Array<MajikSignature | MajikSignatureJSON | string>,
    publicKeys?: MajikSignerPublicKeys,
  ): VerifyResult[] {
    return signatures.map((sig) => {
      try {
        return this.verify(content, sig, publicKeys);
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
   * This is the pair to signAndDetach() — designed for call-sites that retrieve
   * a stored base64 signature from a database or API and want to verify without
   * importing MajikSignature themselves.
   *
   * The signer can be identified by contact ID, raw public key base64, or a
   * MajikKey. If none is provided, self-reported keys from the envelope are used
   * (see security note on verifyContent).
   *
   * @example
   *   const row = await db.findOne({ doc_id });
   *   const result = await majik.verifyDetached(docBytes, row.signature, {
   *     contactId: row.signer_contact_id,
   *   });
   *   if (result.valid) console.log("Signed by", result.signerId);
   */
  async verifyDetached(
    content: Uint8Array | string,
    serializedSignature: string,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
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

    return this.verifyContent(content, sig, options);
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
   * The active account is unlocked automatically if needed.
   * This is the MajikMessage equivalent of MajikSignature.sign() — it resolves
   * the signing key from the keystore so you don't have to manage it yourself.
   *
   * @example
   *   const sig = await majik.signContent(documentBytes, { contentType: "application/pdf" });
   *   const b64 = sig.serialize(); // store alongside the document
   */
  async signContent(
    content: Uint8Array | string,
    options?: {
      contentType?: string;
      timestamp?: string;
      accountId?: string;
    },
  ): Promise<MajikSignature> {
    const id = options?.accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

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

      return MajikSignature.sign(content, key, {
        contentType: options?.contentType,
        timestamp: options?.timestamp,
      });
    } catch (err) {
      this._emit("error", err, { context: "signContent" });
      throw err;
    }
  }

  /**
   * Sign a file and embed the signature directly into it using the active account.
   *
   * @example
   *   const { blob: signedPdf } = await majik.signFile(pdfBlob);
   *
   * @example — non-active account
   *   const { blob } = await majik.signFile(wavBlob, { accountId: "acc_xyz" });
   */
  async signFile(
    file: Blob,
    options?: {
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      accountId?: string;
      expectedSigners?: ExpectedSigner[];
    },
  ): Promise<ReturnType<typeof MajikSignature.signFile>> {
    const id = options?.accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    let key: ReturnType<typeof this._keys.get> | undefined;
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

      const signedResponse = await MajikSignature.signFile(file, key, {
        contentType: options?.contentType,
        timestamp: options?.timestamp,
        mimeType: options?.mimeType,
        expectedSigners: options?.expectedSigners,
      });

      return signedResponse;
    } catch (err) {
      this._emit("error", err, { context: "signFile" });
      throw err;
    } finally {
      if (shouldRelock) key?.lock();
    }
  }

  /**
   * Sign multiple file blobs with the active (or specified) account in one call.
   *
   * @example
   *   const results = await majik.batchSignFiles([
   *     { file: pdfBlob, contentType: "application/pdf" },
   *     { file: wavBlob, contentType: "audio/wav" },
   *     { file: mp4Blob, contentType: "video/mp4" },
   *   ]);
   *   for (const r of results) {
   *     if (r.error) console.error("Failed:", r.error.message);
   *     else await r2.put(key, await r.blob!.arrayBuffer());
   *   }
   */
  async batchSignFiles(
    files: Array<{
      file: Blob;
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
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
    const id = options?.accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    await this._keys.ensureUnlocked(id);
    const key = this._keys.get(id);
    if (!key) throw new Error(`Account not found in keystore: "${id}"`);
    if (!key.hasSigningKeys) {
      throw new Error(
        `Account "${id}" has no signing keys. ` +
          `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
      );
    }

    return Promise.all(
      files.map(async ({ file, contentType, timestamp, mimeType }) => {
        try {
          const result = await MajikSignature.signFile(file, key, {
            contentType,
            timestamp,
            mimeType,
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
      }),
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
   *   const result = await majik.verifyContent(docBytes, sig, { contactId: "contact_abc" });
   *   if (result.valid) console.log("Authentic, signed by:", result.signerId);
   */
  async verifyContent(
    content: Uint8Array | string,
    signature: MajikSignature | MajikSignatureJSON,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
    },
  ): Promise<VerificationResult> {
    try {
      const publicKeys = await this._resolveSignerPublicKeys(options);
      return this.verify(content, signature, publicKeys ?? undefined);
    } catch (err) {
      this._emit("error", err, { context: "verifyContent" });
      throw err;
    }
  }

  /**
   * Verify a file's embedded signature.
   *
   * @example — verify a signed PDF against a known contact
   *   const result = await majik.verifyFile(signedPdf, { contactId: "contact_abc" });
   *   if (result.valid) console.log("Verified:", result.signerId, result.timestamp);
   */
  async verifyFile(
    file: Blob,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      mimeType?: string;
    },
  ): Promise<VerificationResult & { handler?: string; reason?: string }> {
    try {
      const publicKeys = await this._resolveSignerPublicKeys(options);
      let result: VerificationResult & { handler?: string; reason?: string };

      if (publicKeys) {
        const results = await MajikSignature.verifyFile(
          file,
          publicKeys,
          {
            expectedSignerId: options?.expectedSignerId,
            mimeType: options?.mimeType,
          },
          true,
        );
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
          const firstSig = extracted[0];
          const results = await MajikSignature.verifyFile(
            file,
            firstSig.extractPublicKeys(),
            {
              expectedSignerId: firstSig.signerId,
              mimeType: options?.mimeType,
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
   *   const result = await majik.verifyFileDetached(signedPdf, envelope, { contactId: "contact_abc" });
   *   if (result.valid) console.log("Verified:", result.signerId, result.timestamp);
   */
  async verifyFileDetached(
    file: Blob,
    envelope:
      | MajikSignatureEnvelope
      | MajikSignatureEnvelopeJSON
      | Uint8Array
      | Blob,
    options?: {
      contactId?: string;
      publicKeyBase64?: string;
      key?: MajikKey;
      expectedSignerId?: string;
      mimeType?: string;
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
          const firstSig = MajikSignature.fromJSON(firstSigJson);
          const results = await MajikSignature.verifyFileDetached(
            file,
            resolvedEnvelope,
            firstSig.extractPublicKeys(),
            {
              expectedSignerId: firstSig.signerId,
              mimeType: options?.mimeType,
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

  // ── STAMP (compression-resistant image signing) ───────────────────────────
  //
  // These methods delegate to MajikImageSignature, passing `MajikSignature`
  // itself as the adapter — the same pattern used by signFile → MajikSignatureEmbed.
  //
  // The adapter is typed as MajikSignatureStaticAdapter (an interface defined
  // in core/stamp/image-signature.ts) so no circular import is introduced:
  //
  //   majik-signature → core/stamp/image-signature → (adapter interface only)
  //
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sign an image with dual-layer embedding.
   *
   * Every signed image carries two independent proofs:
   *
   *   Layer 1 — Pixel rows appended at the bottom (+~6px height)
   *     Full MajikSignature: Ed25519 + ML-DSA-87 (post-quantum)
   *     Survives: direct sharing, email attachments, Slack, internal tools
   *     Stripped by: platforms that crop/resize (Gmail, LinkedIn, Facebook)
   *
   *   Layer 2 — DCT coefficient steganography (invisible, no size change)
   *     Ed25519-only stub + Reed-Solomon ECC (205 bytes)
   *     Survives: Q70+ JPEG recompression, WebP conversion, platform uploads
   *     Does not survive: screenshots, heavy crop, below-Q70 recompression
   *
   * Output is PNG by default. When uploaded to a platform, Layer 1 may be
   * stripped but Layer 2 survives — verifyStamp() handles both automatically.
   *
   * Minimum image size: 600×600px (smaller images are padded with white).
   *
   * @param image    Any image format the browser supports (JPEG, PNG, WebP…)
   * @param key      Unlocked MajikKey with signing keys
   * @param options  Output MIME type, JPEG quality, timestamp override
   * @returns        blob (signed image), stub (DCT layer metadata),
   *                 fullEnvelope (complete MajikSignatureJSON for Layer 1)
   *
   * @example
   *   const { blob, stub } = await MajikSignature.stampImage(imageBlob, key);
   *   // blob  → upload or attach; visually identical to the original
   *   // stub  → signerId, timestamp, pHash for display
   */
  static async stampImage(
    image: Blob,
    key: MajikKey,
    options?: ImageSignOptions,
  ): Promise<{
    blob: Blob;
    stub: ImageSignatureStub;
    fullEnvelope: MajikSignatureJSON;
  }> {
    return MajikSignature.stampImage(image, key, options);
  }

  /**
   * Verify a stamped image's embedded MajikImageSignature.
   *
   * Tries both layers automatically:
   *   - Both present → both must pass (maximum integrity, post-quantum proof)
   *   - Pixel row only → pixel row must pass (full Ed25519 + ML-DSA-87)
   *   - DCT only → DCT must pass (Ed25519 fallback, typical after platform upload)
   *   - Neither → invalid
   *
   * The `layer` field in the result communicates the trust level so callers
   * can surface it in UI: 'both' > 'pixel-row' > 'dct-only'.
   *
   * @param image    The image to verify — may be platform-compressed
   * @param options  hammingThreshold override (default 8 — strict)
   *
   * @example
   *   const result = await MajikSignature.verifyStamp(imageBlob);
   *   if (result.valid) {
   *     console.log(`✓ Signed by ${result.signerId}`);
   *     console.log(`  Verified via: ${result.layer}`);
   *     // result.layer: 'both' | 'pixel-row' | 'dct-only'
   *   }
   */
  static async verifyStamp(
    image: Blob,
    options?: { hammingThreshold?: number },
  ): Promise<ImageVerificationResult> {
    return MajikSignature.verifyStamp(image, options);
  }

  /**
   * Inspect which stamp layers are present without verifying.
   *
   * Fast — useful for rendering a "Signed by X on Y" badge in a UI before
   * committing to a full cryptographic verify call.
   *
   * Does NOT confirm the signatures are valid — call verifyStamp() for that.
   *
   * @example
   *   const info = await MajikSignature.inspectStamp(imageBlob);
   *   if (info.hasPixelRow) console.log('Full post-quantum proof present');
   *   if (info.hasDct)      console.log('Compression-resistant stub present');
   *   info.dctMeta?.signerId        // signer ID (unverified — display only)
   *   info.pixelRowMeta?.timestamp  // timestamp (unverified — display only)
   */
  static async inspectStamp(image: Blob): Promise<{
    hasPixelRow: boolean;
    hasDct: boolean;
    pixelRowMeta?: { signerId: string; timestamp: string };
    dctMeta?: { signerId: string; timestamp: string; pHash: string };
  }> {
    return MajikSignature.inspectStamp(image);
  }

  /**
   * Returns true if the image contains any MajikImageSignature layer.
   *
   * Does not verify — structural presence check only.
   * Use verifyStamp() to confirm the signature is cryptographically valid.
   *
   * @example
   *   if (await MajikSignature.isStamped(imageBlob)) { ... }
   */
  static async isStamped(image: Blob): Promise<boolean> {
    return MajikSignature.isStamped(image);
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
   * Resolve MajikSignerPublicKeys from whichever signer hint was provided.
   * Returns null if no hint was given (caller should fall back to self-reported keys).
   *
   * Mirrors the _resolveRecipients / _resolveFileIdentity pattern used
   * throughout MajikMessage — consistent account/contact resolution in one place.
   */
  private async _resolveSignerPublicKeys(options?: {
    contactID?: string;
    address?: MajikKeyAddress;
    key?: MajikKey;
    expectedSignerId?: string;
  }): Promise<MajikSignerPublicKeys | null> {
    if (!options) return null;

    // Option A: caller passed a MajikKey instance directly
    if (options.key) {
      return MajikSignature.publicKeysFromMajikKey(options.key);
    }

    // Option B: contact ID looked up from the contact directory
    if (options.contactID) {
      const contact = this._contacts.getContact(options.contactID);
      if (!contact) {
        throw new Error(`No contact found for id "${options.contactID}"`);
      }

      // Own accounts are in the keystore — get their signing keys directly
      const ownAccount = this.getOwnAccountById(options.contactID);
      if (ownAccount) {
        const key = this.keyManager.get(options.contactID);
        if (key?.hasSigningKeys) {
          return MajikSignature.publicKeysFromMajikKey(key);
        }
      }

      // External contact — resolve from their contact card fields
      if (!contact.edPublicKeyBase64 || !contact.mlDsaPublicKeyBase64) {
        throw new Error(
          `Contact "${options.contactID}" has no signing public keys. ` +
            `They may need to share an updated contact card.`,
        );
      }

      return {
        signerId: contact.fingerprint,
        edPublicKey: base64ToUint8Array(contact.edPublicKeyBase64),
        mlDsaPublicKey: base64ToUint8Array(contact.mlDsaPublicKeyBase64),
      };
    }

    // Option C: raw base64 public key — look up via contact directory
    if (options.address) {
      const contact = await this._contacts.getContactByAddress(options.address);
      if (!contact) {
        throw new Error(`No contact found for public key "${options.address}"`);
      }

      if (!contact.edPublicKeyBase64 || !contact.mlDsaPublicKeyBase64) {
        throw new Error(
          `Contact for key "${options.address}" has no signing public keys.`,
        );
      }

      return {
        signerId: contact.fingerprint,
        edPublicKey: base64ToUint8Array(contact.edPublicKeyBase64),
        mlDsaPublicKey: base64ToUint8Array(contact.mlDsaPublicKeyBase64),
      };
    }

    return null;
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
}
