/**
 * AES-256-GCM authenticated encryption helpers.
 *
 * Uses the Node.js built-in `crypto` module — no external dependencies.
 * The key is derived from the KITE_TOKEN_ENCRYPTION_KEY environment variable
 * which must be exactly 64 hex characters (= 32 bytes = 256 bits).
 *
 * Wire format: base64( iv[12] || authTag[16] || ciphertext )
 *
 * THIS FILE IS SERVER-ONLY. Never import it in client components.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;   // GCM recommended nonce length
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.KITE_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.trim().length !== 64) {
    throw new Error(
      "KITE_TOKEN_ENCRYPTION_KEY must be a 64-hex-character (32-byte) string. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex.trim(), "hex");
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a base64-encoded blob containing IV + auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Wire: iv || tag || ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a blob produced by `encrypt()`.
 * Throws if the key is wrong or the ciphertext has been tampered with.
 */
export function decrypt(blob: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(blob, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Hash an opaque session ID for database storage (SHA-256).
 * The plaintext ID lives only in the cookie; only its hash is stored in the DB.
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
