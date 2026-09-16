import { BadRequestError } from '../utils/errors';

/**
 * Converts a Uint8Array to a standard Base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a Base64 or Base64URL string to a Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Imports a 32-byte AES-GCM key from a strict Base64 string into Web Crypto API.
 * Rejects missing keys, invalid Base64, and keys whose length is not exactly 32 bytes (256 bits).
 */
export async function importDocumentPasswordKey(base64Key: string): Promise<CryptoKey> {
  if (!base64Key || typeof base64Key !== 'string' || !base64Key.trim()) {
    throw new BadRequestError('DOCUMENT_PASSWORD_ENCRYPTION_KEY must be a non-empty Base64 string.');
  }

  const trimmed = base64Key.trim();

  // Validate Base64 characters (standard or URL-safe, with optional padding)
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed) || /^[A-Za-z0-9_-]+={0,2}$/.test(trimmed);
  if (!isBase64) {
    throw new BadRequestError('DOCUMENT_PASSWORD_ENCRYPTION_KEY is not valid Base64.');
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(trimmed);
  } catch {
    throw new BadRequestError('DOCUMENT_PASSWORD_ENCRYPTION_KEY is not valid Base64.');
  }

  if (keyBytes.byteLength !== 32) {
    throw new BadRequestError(
      `DOCUMENT_PASSWORD_ENCRYPTION_KEY must represent exactly 32 bytes (256 bits) for AES-256-GCM. Got ${keyBytes.byteLength} bytes.`
    );
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface EncryptedDocumentPasswordResult {
  encryptedPassword: string;
  iv: string;
  algorithm: string;
  keyVersion: string;
}

/**
 * Encrypts a plaintext document password using AES-256-GCM with a freshly generated 12-byte IV.
 * Validates password length and format before encryption.
 * Never logs or exposes the password or key.
 */
export async function encryptDocumentPassword(
  plaintextPassword: string,
  base64Key: string
): Promise<EncryptedDocumentPasswordResult> {
  if (typeof plaintextPassword !== 'string') {
    throw new BadRequestError('Document password must be a string.');
  }

  const trimmed = plaintextPassword.trim();
  if (trimmed.length === 0) {
    throw new BadRequestError('Document password cannot be empty or whitespace-only.');
  }

  if (trimmed.length > 128) {
    throw new BadRequestError('Document password must not exceed 128 characters.');
  }

  const key = await importDocumentPasswordKey(base64Key);

  // Fresh 12-byte cryptographically random IV for every encryption operation
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = new TextEncoder().encode(plaintextPassword);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    encodedPlaintext
  );

  const ciphertextBytes = new Uint8Array(ciphertextBuffer);

  return {
    encryptedPassword: bytesToBase64(ciphertextBytes),
    iv: bytesToBase64(iv),
    algorithm: 'AES-256-GCM',
    keyVersion: '1'
  };
}

/**
 * Decrypts an AES-256-GCM encrypted document password record.
 * Never logs or exposes the decrypted password or key.
 */
export async function decryptDocumentPassword(
  params: {
    encryptedPassword: string;
    iv: string;
    algorithm?: string;
    keyVersion?: string;
  },
  base64Key: string
): Promise<string> {
  if (!params || !params.encryptedPassword || !params.iv) {
    throw new BadRequestError('Invalid encrypted document password payload: encryptedPassword and iv are required.');
  }

  let ivBytes: Uint8Array;
  let ciphertextBytes: Uint8Array;

  try {
    ivBytes = base64ToBytes(params.iv);
    ciphertextBytes = base64ToBytes(params.encryptedPassword);
  } catch {
    throw new BadRequestError('Invalid Base64 in encrypted document password payload.');
  }

  if (ivBytes.byteLength !== 12) {
    throw new BadRequestError(
      `Invalid IV length for AES-GCM: expected 12 bytes, got ${ivBytes.byteLength} bytes.`
    );
  }

  const key = await importDocumentPasswordKey(base64Key);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes
      },
      key,
      ciphertextBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch {
    throw new BadRequestError('Decryption failed: corrupted ciphertext, invalid key, or tampered payload.');
  }
}
