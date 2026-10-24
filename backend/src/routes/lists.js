import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { config } from '../config.js';
import { ContactList, ListContact } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { parseContacts, parseEmailContacts } from '../utils/contacts.js';
import { bad, validId } from '../utils/http.js';
import { MAX_COLUMNS } from '../utils/contacts.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 10 } });

// Both parsers return contacts as [{ name, phone }] or [{ name, email }]. Lists store one `value` either way.
const PARSERS = {
  whatsapp: (buffer, filename, maxRows) => parseContacts(buffer, filename, { defaultCountry: config.defaultCountry, maxRows }),
  email: (buffer, filename, maxRows) => parseEmailContacts(buffer, filename, { maxRows }),
};
const valueOf = (kind, c) => (kind === 'whatsapp' ? c.phone : c.email);

async function insertContacts(list, userId, contacts) {
  const docs = contacts.map((c) => ({ listId: list._id, userId, name: c.name, value: valueOf(list.kind, c), ...(c.fields ? { fields: c.fields } : {}) }));
  for (let i = 0; i < docs.length; i += 1000) {
    await ListContact.insertMany(docs.slice(i, i + 1000), { ordered: false });
  }
}

/** { total, fresh } per list id, for all of a user's lists in one query. fresh = never included in a campaign. */
async function countsFor(userId, listIds) {
  const rows = await ListContact.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)), listId: { $in: listIds } } },
    { $group: { _id: '$listId', total: { $sum: 1 }, fresh: { $sum: { $cond: [{ $eq: ['$lastCampaignAt', null] }, 1, 0] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { total: r.total, fresh: r.fresh }]));
}

const present = (list, counts) => ({
  id: list._id,
  name: list.name,
  kind: list.kind,
  total: counts?.total || 0,
  fresh: counts?.fresh || 0,
  columns: list.columns || [], // extra columns of the contacts: each can be used as {{column}} in a message
  createdAt: list.createdAt,
});

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw bad('Give the list a name');
  if (name.length > 100) throw bad('The list name is too long (max 100 characters)');
  return name;
}

const duplicateName = (err) => (err?.code === 11000 ? bad('You already have a list with that name', 409) : err);

export function listsRouter() {
  const router = Router();
  router.param('id', validId);
  router.param('contactId', validId);

  const findList = async (userId, id) => {
    const list = await ContactList.findOne({ _id: id, userId });
    if (!list) throw bad('List not found', 404);
    return list;
  };

  // All lists (optionally of one kind), with how many contacts each holds and how many were never messaged.
  router.get('/', async (req, res) => {
    const query = { userId: req.userId };
    if (req.query.kind === 'whatsapp' || req.query.kind === 'email') query.kind = req.query.kind;
    const { limits } = await resolveLimits(req.userId);
    const lists = await ContactList.find(query).sort({ createdAt: -1 }).limit(limits.maxLists).lean();
    const counts = await countsFor(req.userId, lists.map((l) => l._id));
    res.json({ lists: lists.map((l) => present(l, counts.get(String(l._id)))), limits: { maxLists: limits.maxLists, maxContacts: limits.maxListContacts } });
  });

  // Create a list from an uploaded file (.csv, .xlsx or .json).
  router.post('/', upload.single('file'), async (req, res) => {
    const name = cleanName(req.body.name);
    const kind = req.body.kind;
    if (!PARSERS[kind]) throw bad('Choose whether this is a WhatsApp or an email list');
    if (!req.file) throw bad('Upload a .csv, .xlsx or .json file of contacts');
    const { limits } = await resolveLimits(req.userId);
    if ((await ContactList.countDocuments({ userId: req.userId })) >= limits.maxLists) {
      throw bad(`You can have at most ${limits.maxLists} lists. Delete one first.`, 429);
    }

    const parsed = await PARSERS[kind](req.file.buffer, req.file.originalname, limits.maxListContacts);
    if (!parsed.contacts.length) return res.status(400).json({ error: 'No valid contacts in that file.', invalid: parsed.invalid.slice(0, 20) });

    let list;
    try {
      list = await ContactList.create({ userId: req.userId, name, kind, columns: parsed.columns });
    } catch (err) {
      throw duplicateName(err);
    }
    try {
      await insertContacts(list, req.userId, parsed.contacts);
    } catch (err) {
      await ListContact.deleteMany({ listId: list._id }).catch(() => {});
      await ContactList.deleteOne({ _id: list._id }).catch(() => {});
      throw err;
    }
    res.status(201).json({
      list: present(list, { total: parsed.contacts.length, fresh: parsed.contacts.length }),
      summary: { added: parsed.contacts.length, invalid: parsed.invalid.slice(0, 20), invalidCount: parsed.invalid.length, duplicatesRemoved: parsed.duplicates, columns: parsed.columns, ignoredColumns: parsed.ignoredColumns },
    });
  });

  // One list with a page of its contacts.
  router.get('/:id', async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [contacts, counts] = await Promise.all([
      ListContact.find({ listId: list._id }).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).select('name value fields lastCampaignAt').lean(),
      countsFor(req.userId, [list._id]),
    ]);
    res.json({ list: present(list, counts.get(String(list._id))), contacts, page, limit });
  });

  router.patch('/:id', async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    list.name = cleanName(req.body?.name);
    try {
      await list.save();
    } catch (err) {
      throw duplicateName(err);
    }
    res.json({ list: { id: list._id, name: list.name, kind: list.kind } });
  });

  // Add more contacts from another file. People already in the list are left alone.
  router.post('/:id/contacts', upload.single('file'), async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    if (!req.file) throw bad('Upload a .csv, .xlsx or .json file of contacts');

    const { limits } = await resolveLimits(req.userId);
    const parsed = await PARSERS[list.kind](req.file.buffer, req.file.originalname, limits.maxListContacts);
    const values = parsed.contacts.map((c) => valueOf(list.kind, c));
    const have = new Set((await ListContact.find({ listId: list._id, value: { $in: values } }).select('value').lean()).map((c) => c.value));
    const fresh = parsed.contacts.filter((c) => !have.has(valueOf(list.kind, c)));

    const existing = await ListContact.countDocuments({ listId: list._id });
    if (existing + fresh.length > limits.maxListContacts) {
      throw bad(`A list can hold ${limits.maxListContacts} contacts. This one has ${existing} and the file would add ${fresh.length} new ones.`, 400);
    }
    if (fresh.length) {
      await insertContacts(list, req.userId, fresh);
      // new columns join the list's columns (up to the limit)
      const columns = [...new Set([...list.columns, ...parsed.columns])].slice(0, MAX_COLUMNS);
      if (columns.length !== list.columns.length) await ContactList.updateOne({ _id: list._id }, { $set: { columns } });
    }
    res.json({ added: fresh.length, alreadyInList: have.size, invalid: parsed.invalid.slice(0, 20), invalidCount: parsed.invalid.length, columns: parsed.columns, ignoredColumns: parsed.ignoredColumns });
  });

  // Forget which contacts were messaged, so "only people not messaged yet" includes everyone again.
  router.post('/:id/reset', async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    // Only contacts that carry a mark: others are already "not messaged yet", and are not counted as reset.
    const result = await ListContact.updateMany({ listId: list._id, lastCampaignAt: { $ne: null } }, { $set: { lastCampaignAt: null } });
    res.json({ reset: result.modifiedCount });
  });

  router.delete('/:id/contacts/:contactId', async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    const result = await ListContact.deleteOne({ _id: req.params.contactId, listId: list._id });
    if (!result.deletedCount) throw bad('Contact not found', 404);
    res.json({ ok: true });
  });

  router.delete('/:id', async (req, res) => {
    const list = await findList(req.userId, req.params.id);
    await ListContact.deleteMany({ listId: list._id });
    await ContactList.deleteOne({ _id: list._id });
    res.json({ ok: true });
  });

  return router;
}
