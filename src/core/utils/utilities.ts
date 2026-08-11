/* ================================
 * Utilities
 * ================================ */

import { MnemonicJSON } from "@majikah/majik-key";

// utils/utilities.ts
export function arrayToBase64(data: Uint8Array): string {
  let binary = "";
  const bytes = data;
  const len = bytes.byteLength;

  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

export function base64ToUtf8(base64: string): string {
  const buf = base64ToArrayBuffer(base64);
  return new TextDecoder().decode(new Uint8Array(buf));
}

export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return arrayBufferToBase64(bytes.buffer);
}

export function concatArrayBuffers(
  a: ArrayBuffer,
  b: ArrayBuffer,
): ArrayBuffer {
  const tmp = new Uint8Array(a.byteLength + b.byteLength);
  tmp.set(new Uint8Array(a), 0);
  tmp.set(new Uint8Array(b), a.byteLength);
  return tmp.buffer;
}

export function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Converts a space-separated seed phrase string into MnemonicJSON
 */
export function seedToJSON(
  seed: string,
  id: string,
  phrase?: string,
): MnemonicJSON {
  return {
    seed: seed
      .trim()
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean),
    id,
    phrase,
  };
}

/**
 * Converts MnemonicJSON into a single space-separated string
 */
export function jsonToSeed(json: MnemonicJSON): string {
  return json.seed.join(" ");
}

export function seedStringToArray(seed: string): string[] {
  return seed
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}
