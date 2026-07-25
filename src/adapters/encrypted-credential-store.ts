import { z } from "zod";
import {
  EncryptedCredentialStateSchema,
  type EncryptedCredentialState,
} from "../domain/schemas";
import { KvStateStore } from "./kv-state-store";

const STATE_KEY = "credentials:v1";
const HKDF_INFO = new TextEncoder().encode("later-gator:credentials:v1");
const CredentialNameSchema = z.enum(["raindrop", "anthropic", "openai", "mcpPath"]);

export type CredentialName = z.infer<typeof CredentialNameSchema>;

export interface CredentialStatus {
  configured: boolean;
  updatedAt: string | null;
}

export type CredentialStatusMap = Record<CredentialName, CredentialStatus>;

export class CredentialDecryptionError extends Error {
  override readonly name = "CredentialDecryptionError";
}

export class EncryptedCredentialStore {
  private readonly stateStore: KvStateStore<EncryptedCredentialState>;

  constructor(
    namespace: KVNamespace,
    private readonly rootSecret: string,
  ) {
    this.stateStore = new KvStateStore(namespace, STATE_KEY, EncryptedCredentialStateSchema);
  }

  async getStatus(): Promise<CredentialStatusMap> {
    const state = await this.stateStore.get();
    return {
      raindrop: toStatus(state?.raindrop ?? null),
      anthropic: toStatus(state?.anthropic ?? null),
      openai: toStatus(state?.openai ?? null),
      mcpPath: toStatus(state?.mcpPath ?? null),
    };
  }

  async set(nameInput: CredentialName, plaintext: string): Promise<void> {
    const name = CredentialNameSchema.parse(nameInput);
    const current = (await this.stateStore.get()) ?? createEmptyState();
    const encryptedValue = await encryptCredential(
      plaintext,
      this.rootSecret,
      current.salt,
      name,
    );
    await this.stateStore.put({
      ...current,
      [name]: encryptedValue,
      revision: current.revision + 1,
    });
  }

  async get(nameInput: CredentialName): Promise<string | null> {
    const name = CredentialNameSchema.parse(nameInput);
    const state = await this.stateStore.get();
    const encryptedValue = state?.[name] ?? null;
    if (state === null || encryptedValue === null) return null;

    try {
      return await decryptCredential(
        encryptedValue.ciphertext,
        encryptedValue.nonce,
        this.rootSecret,
        state.salt,
        name,
      );
    } catch {
      throw new CredentialDecryptionError("Stored credential cannot be decrypted");
    }
  }

  async remove(nameInput: Exclude<CredentialName, "raindrop">): Promise<void> {
    const name = CredentialNameSchema.exclude(["raindrop"]).parse(nameInput);
    const current = await this.stateStore.get();
    if (current?.[name] === undefined || current[name] === null) return;

    await this.stateStore.put({
      ...current,
      [name]: null,
      revision: current.revision + 1,
    });
  }
}

function createEmptyState(): EncryptedCredentialState {
  return {
    schemaVersion: 1,
    salt: randomBase64Url(32),
    raindrop: null,
    anthropic: null,
    openai: null,
    mcpPath: null,
    revision: 0,
  };
}

async function encryptCredential(
  plaintext: string,
  rootSecret: string,
  salt: string,
  name: CredentialName,
): Promise<EncryptedCredentialState["raindrop"]> {
  const key = await deriveKey(rootSecret, salt);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(additionalData(name)),
      },
      key,
      toArrayBuffer(plaintextBytes),
    );
    return {
      algorithm: "AES-GCM",
      keyDerivation: "HKDF-SHA-256",
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    plaintextBytes.fill(0);
  }
}

async function decryptCredential(
  ciphertext: string,
  nonce: string,
  rootSecret: string,
  salt: string,
  name: CredentialName,
): Promise<string> {
  const key = await deriveKey(rootSecret, salt);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64UrlToBytes(nonce)),
      additionalData: toArrayBuffer(additionalData(name)),
    },
    key,
    toArrayBuffer(base64UrlToBytes(ciphertext)),
  );
  const plaintextBytes = new Uint8Array(decrypted);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintextBytes);
  } finally {
    plaintextBytes.fill(0);
  }
}

async function deriveKey(rootSecret: string, salt: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(rootSecret);
  try {
    const baseKey = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, [
      "deriveKey",
    ]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(base64UrlToBytes(salt)),
        info: toArrayBuffer(HKDF_INFO),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    secretBytes.fill(0);
  }
}

function additionalData(name: CredentialName): Uint8Array {
  return new TextEncoder().encode(`later-gator:credential:${name}:v1`);
}

function toStatus(value: EncryptedCredentialState["raindrop"]): CredentialStatus {
  return {
    configured: value !== null,
    updatedAt: value?.updatedAt ?? null,
  };
}

function randomBase64Url(size: number): string {
  const value = new Uint8Array(size);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer;
}
