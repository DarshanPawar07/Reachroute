import { Router } from 'express';
import multer from 'multer';
import { record } from '../audit/audit.js';
import { MB, deleteAttachment, ingest, present, removeStoredFile, usageOf, getBucket } from '../attachments/store.js';
import { safeFileName } from '../attachments/types.js';
import { Attachment } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { bad, validId } from '../utils/http.js';

/** Multer storage that streams the file into GridFS while it arrives, so a big upload never sits in memory. */
const gridStorage = {
  _handleFile(req, file, cb) {
    ingest(file.stream, { filename: file.originalname, maxBytes: req.attachmentMaxBytes })
      .then((stored) => cb(null, stored))
      .catch(cb);
  },
  _removeFile(_req, file, cb) {
    (file.gridId ? removeStoredFile(file.gridId) : Promise.resolve()).then(() => cb(null), () => cb(null));
  },
};

// The real size limit is checked while streaming (it depends on the plan); this only has to be above every plan.
const upload = multer({ storage: gridStorage, limits: { fileSize: 1024 * MB, files: 1, fields: 5 } });

/**
 * The files an account has uploaded to send with its campaigns.
 *   GET    /            the files, and how much of the storage is used
 *   POST   /            upload one file (form field "file")
 *   GET    /:id/download   get a file back
 *   DELETE /:id         delete a file (refused while an unfinished campaign still needs it)
 */
export function attachmentsRouter(limiters = {}) {
  const router = Router();
  router.param('id', validId);

  router.get('/', async (req, res) => {
    const [items, used, { limits }] = await Promise.all([Attachment.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(200).lean(), usageOf(req.userId), resolveLimits(req.userId)]);
    res.json({
      items: items.map(present),
      usage: { files: used.count, bytes: used.bytes, limitBytes: limits.storageMb * MB },
      limits: { whatsappFileMb: limits.waAttachmentMb, emailFileMb: limits.emailAttachmentMb, storageMb: limits.storageMb },
    });
  });

  const prepare = async (req, _res, next) => {
    try {
      const { limits } = await resolveLimits(req.userId);
      const used = await usageOf(req.userId);
      const room = limits.storageMb * MB - used.bytes;
      if (room <= 0) throw bad(`Your file storage is full (${limits.storageMb} MB). Delete files you no longer need.`, 413);
      req.attachmentMaxBytes = Math.min(Math.max(limits.waAttachmentMb, limits.emailAttachmentMb) * MB, room);
      next();
    } catch (err) {
      next(err);
    }
  };

  router.post('/', ...(limiters.attachmentUpload ? [limiters.attachmentUpload] : []), prepare, upload.single('file'), async (req, res) => {
    if (!req.file) throw bad('Choose a file to upload (form field "file")');
    const { gridId, size, sha256, type } = req.file;
    try {
      // The same file again: keep the first copy.
      const same = await Attachment.findOne({ userId: req.userId, sha256 });
      if (same) {
        await removeStoredFile(gridId);
        return res.status(200).json({ attachment: present(same), duplicate: true });
      }
      const doc = await Attachment.create({ userId: req.userId, name: safeFileName(req.file.originalname, type.ext), ext: type.ext, mime: type.mime, kind: type.kind, size, sha256, gridId });
      record({ actorId: req.userId, targetId: req.userId, action: 'attachment.upload', detail: { name: doc.name, size } });
      res.status(201).json({ attachment: present(doc), duplicate: false });
    } catch (err) {
      await removeStoredFile(gridId);
      throw err;
    }
  });

  router.get('/:id/download', async (req, res) => {
    const doc = await Attachment.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!doc) throw bad('Attachment not found', 404);
    res.set({
      'Content-Type': doc.mime,
      'Content-Length': String(doc.size),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.name)}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    getBucket()
      .openDownloadStream(doc.gridId)
      .on('error', () => res.destroy())
      .pipe(res);
  });

  router.delete('/:id', async (req, res) => {
    const gone = await deleteAttachment(req.userId, req.params.id);
    record({ actorId: req.userId, targetId: req.userId, action: 'attachment.delete', detail: gone });
    res.json({ ok: true });
  });

  return router;
}
