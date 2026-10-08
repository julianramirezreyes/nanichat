import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VaultKeyInvalidError, VaultKeyMissingError } from '../core/errors.ts';
import type { EncryptedSecret } from '../core/domain.ts';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface CredentialVault {
  encrypt(contextId: string, token: string): EncryptedSecret;
  decrypt(contextId: string, secret: EncryptedSecret): string;
}

export type StoredEncryptedCredential = {
  contextId: string;
  secret: EncryptedSecret;
};

export function createVault(
  dataDir: string,
  loadEncryptedCredentials: () => StoredEncryptedCredential[],
): CredentialVault {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const keyPath = join(directory, 'vault.key');
  const credentials = loadEncryptedCredentials();
  const key = loadOrCreateKey(keyPath, () => credentials.length > 0);

  const vault: CredentialVault = {
    encrypt(contextId, token) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(contextId, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return {
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },
    decrypt(contextId, secret) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.nonce, 'base64'));
      decipher.setAAD(Buffer.from(contextId, 'utf8'));
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };

  try {
    for (const credential of credentials) {
      vault.decrypt(credential.contextId, credential.secret);
    }
  } catch {
    throw new VaultKeyInvalidError();
  }

  return vault;
}

function loadOrCreateKey(keyPath: string, hasEncryptedSecrets: () => boolean): Buffer {
  if (existsSync(keyPath)) {
    try {
      const key = readFileSync(keyPath);
      if (key.length !== KEY_BYTES) throw new VaultKeyInvalidError();
      chmodSync(keyPath, 0o600);
      return key;
    } catch (error) {
      if (error instanceof VaultKeyInvalidError) throw error;
      throw new VaultKeyInvalidError();
    }
  }
  if (hasEncryptedSecrets()) throw new VaultKeyMissingError();

  const key = randomBytes(KEY_BYTES);
  let fd: number;
  try {
    fd = openSync(keyPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateKey(keyPath, hasEncryptedSecrets);
    throw error;
  }
  try {
    writeSync(fd, key);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(keyPath, 0o600);
  return key;
}
