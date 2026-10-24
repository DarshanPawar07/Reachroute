// Check or restore a backup.
//   npm run restore -- --check                       check the newest backup (no database needed)
//   npm run restore -- backups/20261021-134500Z --check
//   npm run restore -- --latest --yes                restore the newest backup into an EMPTY database
//   npm run restore -- <folder> --yes --replace      clear the collections in the backup first, then restore
//   --only=users,templates                           restore just those collections
import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { listBackups, restoreBackup, verifyBackup } from '../src/backup/backup.js';

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));

try {
  let dir = positional && path.resolve(positional);
  if (!dir) {
    const [newest] = await listBackups(path.resolve(arg('dir') || config.backupDir));
    if (!newest) throw new Error('No backups found. Give the backup folder, or set BACKUP_DIR.');
    dir = newest.dir;
  }

  const manifest = await verifyBackup(dir);
  const docs = manifest.collections.reduce((n, c) => n + c.documents, 0);
  console.log(`Backup ${dir}\n  made ${manifest.createdAt} from "${manifest.database}": ${manifest.collections.length} collections, ${docs} documents. Checksums match.`);
  if (flag('check')) process.exit(0);

  if (!flag('yes')) {
    console.log('\nNothing was changed. To restore this backup add --yes (the target database is MONGO_URI from your .env).');
    process.exit(2);
  }
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  console.log(`\nRestoring into "${mongoose.connection.name}"${flag('replace') ? ' (existing data in those collections is removed first)' : ''}...`);
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean) || null;
  const { restored } = await restoreBackup(dir, { replace: flag('replace'), only });
  for (const r of restored) console.log(`  ${r.name}: ${r.documents}`);
  console.log('Done. Restart the backend so indexes and sessions are rebuilt.');
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
