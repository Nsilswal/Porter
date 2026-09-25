import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Authenticated envelopes bind a wrapped key to the row it belongs to. */
export function wrapKey(plaintext: Buffer, masterKey: Buffer, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function unwrapKey(envelope: string, masterKey: Buffer, context: string): Buffer {
  try {
    const [version, iv, ciphertext, tag, extra] = envelope.split(".");
    if (version !== "v1" || !iv || !ciphertext || !tag || extra !== undefined) throw new Error();
    const nonce = Buffer.from(iv, "base64url");
    const authTag = Buffer.from(tag, "base64url");
    if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch {
    throw new Error("Unable to decrypt stored key; verify the deployment encryption key and database integrity");
  }
}
