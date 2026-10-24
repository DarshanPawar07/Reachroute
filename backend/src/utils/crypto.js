import crypto from 'node:crypto';
import { config } from '../config.js';

// 32-byte key derived from ENCRYPTION_KEY. Keep that secret out of git and back it up:
// if it changes, saved SMTP passwords can no longer be decrypted.
const key = crypto.createHash('sha256').update(config.encryptionKey).digest();

/** AES-256-GCM. Output format: iv.tag.ciphertext (all base64). */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = String(payload).split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
