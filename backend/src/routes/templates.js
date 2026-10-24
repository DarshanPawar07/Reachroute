import { Router } from 'express';
import { config } from '../config.js';
import { ContactList, ListContact, Template } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { bad, validId } from '../utils/http.js';
import { renderEmail } from '../utils/emailTemplate.js';
import { analyze, BUILT_IN, checkTemplate, columnKey, renderMessage } from '../utils/template.js';

const KINDS = ['whatsapp', 'email'];

const text = (v, label, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw bad(`${label} is required`);
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return s;
};

const kindOf = (value) => {
  if (!KINDS.includes(value)) throw bad('Choose whether this is a "whatsapp" or an "email" template');
  return value;
};

/** The content of a template of this kind from a request body (the same limits as a campaign). */
function readContent(kind, b) {
  if (kind === 'whatsapp') return { message: text(b.message, 'Message', 1000) };
  return { subject: text(b.subject, 'Subject', 200), body: text(b.body, 'Body', 20_000), bodyFormat: b.bodyFormat === 'html' ? 'html' : 'text' };
}

const textsOf = (kind, c) => (kind === 'whatsapp' ? [c.message] : [c.subject, c.body]);

const present = (t) => ({
  id: t._id,
  kind: t.kind,
  name: t.name,
  ...(t.kind === 'whatsapp' ? { message: t.message } : { subject: t.subject, body: t.body, bodyFormat: t.bodyFormat }),
  updatedAt: t.updatedAt,
});

const duplicateName = (err) => (err?.code === 11000 ? bad('You already have a template with that name', 409) : err);

/** Saved message templates, and a preview that shows a message the way real contacts will get it. */
export function templatesRouter() {
  const router = Router();
  router.param('id', validId);

  // What can be written in a message.
  router.get('/variables', (_req, res) =>
    res.json({
      builtIn: BUILT_IN.map((key) => ({ key, example: `{{${key}}}`, fallback: 'there' })),
      syntax: [
        { example: '{{name}}', meaning: "The contact's name, or \"there\" when there is none" },
        { example: '{{first_name}}', meaning: 'The first word of the name' },
        { example: '{{city}}', meaning: 'Any other column of your contact file (lower case, spaces become _)' },
        { example: '{{city|your city}}', meaning: 'The same, with a fallback for contacts that have no value' },
        { example: '{Hi|Hello|Hey}', meaning: 'One of the options, picked at random for each message' },
      ],
    })
  );

  router.get('/', async (req, res) => {
    const query = { userId: req.userId };
    if (req.query.kind) query.kind = kindOf(req.query.kind);
    const { limits } = await resolveLimits(req.userId);
    const templates = await Template.find(query).sort({ updatedAt: -1 }).limit(limits.maxTemplates).lean();
    res.json({ templates: templates.map(present), limit: limits.maxTemplates });
  });

  router.post('/', async (req, res) => {
    const b = req.body || {};
    const kind = kindOf(b.kind);
    const name = text(b.name, 'Template name', 100);
    const content = readContent(kind, b);
    const problems = checkTemplate(textsOf(kind, content));
    if (problems.length) throw bad(problems.join(' '));
    const { limits } = await resolveLimits(req.userId);
    if ((await Template.countDocuments({ userId: req.userId })) >= limits.maxTemplates) {
      throw bad(`You can save at most ${limits.maxTemplates} templates. Delete one first.`, 429);
    }
    try {
      const t = await Template.create({ userId: req.userId, kind, name, ...content });
      res.status(201).json({ template: present(t) });
    } catch (err) {
      throw duplicateName(err);
    }
  });

  // Replace a template's name and content. Its kind cannot change.
  router.put('/:id', async (req, res) => {
    const t = await Template.findOne({ _id: req.params.id, userId: req.userId });
    if (!t) throw bad('Template not found', 404);
    const b = req.body || {};
    const name = text(b.name ?? t.name, 'Template name', 100);
    const content = readContent(t.kind, b);
    const problems = checkTemplate(textsOf(t.kind, content));
    if (problems.length) throw bad(problems.join(' '));
    t.set({ name, ...content });
    try {
      await t.save();
    } catch (err) {
      throw duplicateName(err);
    }
    res.json({ template: present(t) });
  });

  router.delete('/:id', async (req, res) => {
    const gone = await Template.deleteOne({ _id: req.params.id, userId: req.userId });
    if (!gone.deletedCount) throw bad('Template not found', 404);
    res.json({ ok: true });
  });

  /**
   * See a message as contacts will get it. Body: the content (message, or subject + body + bodyFormat) and `kind`, plus
   *   listId   use the first contacts of that list, with their real columns (up to `count`, default 3, most 5)
   *   sample   or: { name, fields: { city: 'Pune' } } for one made-up contact
   * Answers with the rendered messages, the columns the message needs, and anything that would stop a campaign.
   */
  router.post('/preview', async (req, res) => {
    const b = req.body || {};
    const kind = kindOf(b.kind);
    const content = readContent(kind, b);
    const texts = textsOf(kind, content);

    let contacts;
    let columns = null;
    if (b.listId) {
      const list = await ContactList.findOne({ _id: b.listId, userId: req.userId, kind }).lean().catch(() => null);
      if (!list) throw bad('That list was not found', 404);
      const count = Math.min(Math.max(Number(b.count) || 3, 1), 5);
      contacts = (await ListContact.find({ listId: list._id }).sort({ _id: 1 }).limit(count).select('name value fields').lean()).map((c) => ({ name: c.name, fields: c.fields || {}, value: c.value }));
      if (!contacts.length) throw bad('That list has no contacts to preview with');
      columns = list.columns || [];
    } else {
      const s = b.sample && typeof b.sample === 'object' ? b.sample : {};
      const fields = {};
      for (const [k, v] of Object.entries(s.fields && typeof s.fields === 'object' ? s.fields : {})) {
        const key = columnKey(k);
        if (key && typeof v !== 'object') fields[key] = String(v ?? '');
      }
      contacts = [{ name: typeof s.name === 'string' ? s.name : 'Asha Rao', fields }];
      if (b.sample) columns = Object.keys(fields);
    }

    const previews = contacts.map((c) => {
      const recipient = { name: c.name, fields: c.fields };
      const contact = { name: c.name, fields: c.fields };
      if (kind === 'whatsapp') {
        return { contact, text: renderMessage(content.message, c.name, { appendOptOut: b.appendOptOut !== false && b.appendOptOut !== 'false', fields: c.fields }) };
      }
      const { subject, text: plain, html } = renderEmail(content, recipient, `${config.publicUrl}/unsubscribe/preview`);
      return { contact, subject, text: plain, html };
    });

    const { variables } = analyze(texts);
    res.json({ previews, variables, columns, problems: checkTemplate(texts, columns) });
  });

  return router;
}
