import { KEY_ALGO } from "../crypto/constants";
import { MAJIK_API_RESPONSE } from "../types";
import { base64ToArrayBuffer } from "../utils/utilities";
import {
  MajikContact,
  MajikContactData,
  SerializedMajikContact,
} from "@majikah/majik-contact";
import { MajikContactDirectoryError } from "./errors";
import { MajikContactDirectoryData } from "./types";
import { MajikKeyAddress } from "@majikah/majik-key";

/* -------------------------------
 * MajikContactDirectory Class
 * ------------------------------- */

export class MajikContactDirectory {
  private contacts: Map<string, MajikContact> = new Map();
  private fingerprintMap: Map<string, string> = new Map(); // fingerprint → contact id

  constructor(initialContacts?: MajikContact[]) {
    if (initialContacts?.length) {
      initialContacts.forEach((c) => this.addContact(c));
    }
  }

  /* ================================
   * Contact Management
   * ================================ */

  addContact(contact: MajikContact): this {
    if (
      !contact?.id ||
      !contact?.publicKey ||
      !contact?.fingerprint ||
      !contact?.mlKey
    ) {
      throw new MajikContactDirectoryError("Invalid contact");
    }

    if (this.contacts.has(contact.id)) {
      throw new MajikContactDirectoryError(
        `Contact with id "${contact.id}" already exists`,
      );
    }
    this.contacts.set(contact.id, contact);
    this.fingerprintMap.set(contact.fingerprint, contact.id);
    return this;
  }

  addContacts(contacts: MajikContact[]): this {
    contacts.forEach((c) => this.addContact(c));
    return this;
  }

  removeContact(id: string): MAJIK_API_RESPONSE {
    this.assertId(id);
    const contact = this.contacts.get(id);
    if (contact) {
      this.fingerprintMap.delete(contact.fingerprint);
      this.contacts.delete(id);
      return {
        message: "Contact removed successfully",
        success: true,
      };
    } else {
      return {
        message: "Contact not found",
        success: false,
      };
    }
  }

  updateContactMeta(
    id: string,
    meta: Partial<MajikContactData["meta"]>,
  ): MajikContact {
    const contact = this.getContact(id);
    if (!contact) throw new MajikContactDirectoryError("Contact not found");

    if (meta) {
      meta.label && contact.updateLabel(meta.label);
      meta.notes && contact.updateNotes(meta.notes);
      meta.blocked !== undefined && contact.setBlocked(meta.blocked);
    }

    return contact;
  }

  getContact(id: string): MajikContact | undefined {
    this.assertId(id);
    return this.contacts.get(id);
  }

  getContactByFingerprint(fingerprint: string): MajikContact | undefined {
    if (!fingerprint) {
      throw new MajikContactDirectoryError(
        "Fingerprint must be a non-empty string",
      );
    }
    const contactId = this.fingerprintMap.get(fingerprint);
    return contactId ? this.contacts.get(contactId) : undefined;
  }

  /**
   * Get contact by public key (base64)
   * Uses MajikContact.getPublicKeyBase64() for canonical comparison
   */
  async getContactByAddress(
    address: MajikKeyAddress,
  ): Promise<MajikContact | undefined> {
    if (!address || typeof address !== "string") {
      throw new MajikContactDirectoryError(
        "Public key must be a non-empty base64 MajikKeyAddress",
      );
    }

    for (const contact of this.contacts.values()) {
      const contactKey = await contact.getPublicKeyBase64();
      if (contactKey === address) {
        return contact;
      }
    }

    return undefined;
  }

  hasFingerprint(fingerprint: string): boolean {
    return this.fingerprintMap.has(fingerprint);
  }

  listContacts(sortedByLabel = false, majikahOnly = false): MajikContact[] {
    let contacts = [...this.contacts.values()];

    if (majikahOnly) {
      contacts = contacts.filter((c) => c.isMajikahRegistered());
    }

    if (sortedByLabel) {
      contacts.sort((a, b) =>
        (a.meta.label || "").localeCompare(b.meta.label || ""),
      );
    }

    return contacts;
  }

  blockContact(id: string): MajikContact {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikContactDirectoryError(
        `Contact with id "${id}" not found for block`,
      );
    return contact.block();
  }

  unblockContact(id: string): MajikContact {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikContactDirectoryError(
        `Contact with id "${id}" not found for unblock`,
      );
    return contact.unblock();
  }

  hasContact(id: string): boolean {
    return this.contacts.has(id);
  }

  /**
   * Checks if a contact exists by their public key (base64)
   */
  async hasContactByAddress(address: MajikKeyAddress): Promise<boolean> {
    if (!address || typeof address !== "string") {
      throw new MajikContactDirectoryError(
        "Public key must be a non-empty base64 MajikKeyAddress",
      );
    }

    const contact = await this.getContactByAddress(address);
    return contact !== undefined;
  }

  clear(): this {
    this.contacts.clear();
    this.fingerprintMap.clear();
    return this;
  }

  setMajikahStatus(id: string, status: boolean): MajikContact {
    const contact = this.getContact(id);
    if (!contact) throw new MajikContactDirectoryError("Contact not found");

    contact.setMajikahStatus(status);

    return contact;
  }

  isMajikahIdentityChecked(id: string): boolean {
    const contact = this.getContact(id);
    if (!contact) throw new MajikContactDirectoryError("Contact not found");
    return contact.isMajikahIdentityChecked();
  }

  isMajikahRegistered(id: string): boolean {
    const contact = this.getContact(id);
    if (!contact) throw new MajikContactDirectoryError("Contact not found");
    return contact.isMajikahRegistered();
  }

  /* ================================
   * Serialization / Persistence
   * ================================ */

  async toJSON(): Promise<MajikContactDirectoryData> {
    const contactsData: SerializedMajikContact[] = [];
    for (const contact of this.contacts.values()) {
      contactsData.push(await contact.toJSON());
    }
    return { contacts: contactsData };
  }

  async fromJSON(data: MajikContactDirectoryData): Promise<this> {
    if (!data?.contacts) {
      throw new MajikContactDirectoryError("Invalid serialized data");
    }

    this.clear();

    for (const item of data.contacts) {
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
      } catch (e) {
        // Fallback: create a raw-key wrapper when the browser does not support the namedCurve
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
      this.contacts.set(contact.id, contact);
      this.fingerprintMap.set(contact.fingerprint, contact.id);
    }

    return this;
  }

  /* ================================
   * Validation Helpers
   * ================================ */

  private assertId(id: string) {
    if (!id || typeof id !== "string") {
      throw new MajikContactDirectoryError(
        "Contact ID must be a non-empty string",
      );
    }
  }
}
