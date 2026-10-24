import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { WaAuth } from '../models.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'wa-auth' });

/**
 * Baileys auth state kept in MongoDB instead of files, encrypted with ENCRYPTION_KEY.
 * Sessions then survive restarts and redeploys on hosts with throw-away disks, and any
 * instance can take over a user's session.
 *
 * Returns { state, saveCreds, flush }. `flush()` resolves once every save started so far has reached the
 * database. WhatsApp makes the client reconnect right after the QR scan, and that new connection reads the login
 * back from the database, so we must be sure it is really there before reconnecting.
 */
export async function useMongoAuthState(userId) {
  const uid = String(userId);
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    const done = () => pending.delete(promise);
    promise.then(done, done);
    return promise;
  };

  const read = async (key) => {
    const doc = await WaAuth.findOne({ userId: uid, key }).lean();
    if (!doc) return null;
    try {
      return JSON.parse(decrypt(doc.value), BufferJSON.reviver);
    } catch (err) {
      // Unreadable (e.g. ENCRYPTION_KEY changed): behave as if it was never saved, but say so, because the user
      // will be asked to scan the QR code again and that should not be a mystery.
      log.warn({ userId: uid, key, err: err.message }, 'saved WhatsApp data could not be decrypted (did ENCRYPTION_KEY change?)');
      return null;
    }
  };

  const writeOnce = (key, data) =>
    WaAuth.updateOne({ userId: uid, key }, { $set: { value: encrypt(JSON.stringify(data, BufferJSON.replacer)) } }, { upsert: true });

  // Two upserts of the same key at the same moment can collide on the unique index: just try again.
  const write = async (key, data) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await writeOnce(key, data);
      } catch (err) {
        if (err.code === 11000 && attempt < 4) continue;
        log.error({ userId: uid, key, err: err.message }, 'could not save WhatsApp login data');
        throw err;
      }
    }
  };
  const remove = (key) => WaAuth.deleteOne({ userId: uid, key });

  const creds = (await read('creds')) || initAuthCreds();
  log.info({ userId: uid, registered: Boolean(creds.registered), hasAccount: Boolean(creds.me) }, 'loaded WhatsApp login state');

  // Saves of the main login record happen one after another, so an older save can never land after a newer one.
  let credsChain = Promise.resolve();
  const saveCreds = () => {
    const run = credsChain.then(() => write('creds', creds));
    credsChain = run.catch(() => {});
    return track(run);
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[id] = value;
            })
          );
          return data;
        },
        set: (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          return track(Promise.all(tasks));
        },
      },
    },
    saveCreds,
    flush: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}

/** Forget a user's WhatsApp login completely. */
export const clearAuthState = (userId) => WaAuth.deleteMany({ userId: String(userId) });

/** User ids that have a saved login (used to re-adopt sessions after a restart or an instance failure). */
export const usersWithSavedLogin = () => WaAuth.distinct('userId', { key: 'creds' });