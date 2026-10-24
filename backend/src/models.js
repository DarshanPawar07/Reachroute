import mongoose from 'mongoose';
import { LIMIT_KEYS } from './plans/definitions.js';

const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true });

// Campaign lifecycle: preparing (recipients being created) -> running <-> paused -> completed | cancelled
const CAMPAIGN_STATUSES = ['preparing', 'running', 'paused', 'completed', 'cancelled'];
// Recipient lifecycle: pending -> sending (claimed by one worker) -> sent | failed | skipped
const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

// "Only send between these hours": minutes after local midnight (end exclusive), an IANA timezone, allowed weekdays (empty = all).
const sendWindowSchema = new Schema(
  {
    start: { type: Number, required: true, min: 0, max: 1439 },
    end: { type: Number, required: true, min: 0, max: 1439 },
    timezone: { type: String, required: true },
    days: { type: [Number], default: [] },
  },
  { _id: false }
);

const attachmentRefSchema = new Schema(
  { attachmentId: { type: Schema.Types.ObjectId, required: true }, name: String, size: Number, mime: String, kind: String },
  { _id: false }
);

const campaignFields = () => ({
  userId: ref('User'),
  name: { type: String, required: true, trim: true },
  status: { type: String, enum: CAMPAIGN_STATUSES, default: 'preparing' },
  pauseReason: { type: String, default: null },
  total: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  skippedCount: { type: Number, default: 0 },
  consecutiveFailures: { type: Number, default: 0 },
  finishedAt: { type: Date, default: null },
  // Scheduled start (null = started as soon as it was created) and the hours sending is allowed in (null = any time).
  startAt: { type: Date, default: null },
  sendWindow: { type: sendWindowSchema, default: null },
  // Files sent with every message of the campaign (a snapshot: the stored file itself is in the attachment library).
  attachments: { type: [attachmentRefSchema], default: [] },
});

/** Fields shared by both recipient collections. */
const recipientFields = (campaignModel) => ({
  campaignId: ref(campaignModel),
  userId: ref('User'),
  name: { type: String, default: '' },
  // The contact's other columns (company, city, ...) for {{column}} variables in the message. Keys are a-z, 0-9 and _.
  fields: { type: Schema.Types.Mixed, default: undefined },
  status: { type: String, enum: RECIPIENT_STATUSES, default: 'pending' },
  // When this recipient may be sent. null = not scheduled (campaign paused or still preparing).
  scheduledFor: { type: Date, default: null },
  claimedAt: { type: Date, default: null },
  claimedBy: { type: String, default: null },
  deferCount: { type: Number, default: 0 },
  // true when we could not tell whether the message went out (crash or timeout while sending).
  ambiguous: { type: Boolean, default: false },
  error: { type: String, default: null },
  sentAt: { type: Date, default: null },
});

function recipientIndexes(schema, contactField) {
  schema.index({ status: 1, scheduledFor: 1 }); // dispatcher: what is due now
  schema.index({ userId: 1, status: 1, scheduledFor: -1 }); // latest scheduled send for a user
  schema.index({ campaignId: 1, status: 1 }); // progress counts, completion check
  schema.index({ userId: 1, createdAt: 1 }); // daily cap
  schema.index({ userId: 1, status: 1, sentAt: -1 }); // hourly cap and health checks
  schema.index({ userId: 1, [contactField]: 1, sentAt: -1 }); // which campaign message a reply answers
  schema.index({ userId: 1, updatedAt: -1 }); // usage statistics
  schema.index({ status: 1, claimedAt: 1 }); // reaper for stuck sends
  schema.index({ status: 1, sentAt: -1 }); // platform-wide sent counts (admin overview)
  schema.index({ campaignId: 1, [contactField]: 1 }, { unique: true }); // no duplicate rows per campaign
}

// ---------------------------------------------------------------- users
// Limits an account or a plan can change (see plans/definitions.js). A missing value means "use the next level down".
const limitsSchema = new Schema(Object.fromEntries(LIMIT_KEYS.map((k) => [k, { type: Number }])), { _id: false });

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    // No default on purpose: accounts created before this field existed have none, and count as verified.
    // New accounts are created with false.
    tokenVersion: { type: Number, default: 0 }, // raised to sign the account out of every device
    emailVerified: { type: Boolean },
    emailVerifiedAt: { type: Date },
    // Secret part of this account's email-feedback webhook URL (bounces and spam complaints from the sending provider).
    // The hash finds the account, the encrypted copy lets the owner see the URL again.
    webhookKeyHash: { type: String },
    webhookKeyEnc: { type: String },
    // 'admin' can open the admin area. Only set from the command line (npm run make-admin), never through the API.
    // Accounts created before roles existed have none and count as 'user'.
    role: { type: String, enum: ['user', 'admin'] },
    // Set while an administrator has suspended the account: it cannot log in and its campaigns were paused.
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: '' },
    lastLoginAt: { type: Date, default: null },
    // The plan this account is on (null = the default plan: the server settings), and limits set for this account alone.
    planKey: { type: String, default: null },
    limitOverrides: { type: limitsSchema, default: undefined },
  },
  { timestamps: true }
);
userSchema.index({ createdAt: -1 }); // the admin user list
userSchema.index({ webhookKeyHash: 1 }, { unique: true, partialFilterExpression: { webhookKeyHash: { $type: 'string' } } });

// One-time links for password reset and email verification. Only a hash of the token is stored.
const authTokenSchema = new Schema(
  {
    userId: ref('User'),
    type: { type: String, enum: ['reset', 'verify'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
authTokenSchema.index({ userId: 1, type: 1 });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo removes expired tokens on its own

// ---------------------------------------------------------------- WhatsApp
const campaignSchema = new Schema(
  { ...campaignFields(), template: { type: String, required: true }, appendOptOut: { type: Boolean, default: true } },
  { timestamps: true }
);
campaignSchema.index({ userId: 1, createdAt: -1 });
campaignSchema.index({ userId: 1, status: 1 });
campaignSchema.index({ status: 1, updatedAt: 1 });

const recipientSchema = new Schema(
  { ...recipientFields('Campaign'), phone: { type: String, required: true } }, // digits only, E.164 without '+'
  { timestamps: true }
);
recipientIndexes(recipientSchema, 'phone');

// A message a contact sent back after a campaign message. Only people the account messaged in a campaign are stored.
const replySchema = new Schema(
  {
    userId: ref('User'),
    phone: { type: String, required: true },
    name: { type: String, default: '' }, // the name from the campaign list, or the contact's own WhatsApp name
    text: { type: String, default: '' },
    kind: { type: String, default: 'text' }, // text, image, video, audio, document, sticker, contact, location, other
    messageId: { type: String, required: true }, // WhatsApp's id for the message, so a repeat delivery is stored once
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
    recipientId: { type: Schema.Types.ObjectId, ref: 'Recipient', default: null },
    optOut: { type: Boolean, default: false }, // the reply was STOP / unsubscribe
    receivedAt: { type: Date, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
replySchema.index({ userId: 1, messageId: 1 }, { unique: true });
replySchema.index({ userId: 1, receivedAt: -1 });
replySchema.index({ userId: 1, readAt: 1 });
replySchema.index({ userId: 1, campaignId: 1, receivedAt: -1 });
replySchema.index({ receivedAt: 1 }); // retention clean-up

const optOutSchema = new Schema({ userId: ref('User'), phone: { type: String, required: true } }, { timestamps: true });
optOutSchema.index({ userId: 1, phone: 1 }, { unique: true });

// One doc per user while a WhatsApp session is alive somewhere. Whoever holds an unexpired lease owns the socket.
const sessionLeaseSchema = new Schema(
  {
    _id: { type: String },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, default: 'connecting' },
    qr: { type: String, default: null },
    command: { type: String, default: null }, // e.g. 'logout', sent by an instance that doesn't own the session
    phone: { type: String, default: null }, // the linked number while connected, so any instance can tell who is linked
  },
  { timestamps: true }
);
sessionLeaseSchema.index({ expiresAt: 1 });

// A WhatsApp number that WhatsApp refused (restricted or banned for a while). At most one 'active' per account.
const waRestrictionSchema = new Schema(
  {
    userId: ref('User'),
    phone: { type: String, default: '' }, // the number that was refused ('' when it was not known)
    status: { type: String, enum: ['active', 'resolved'], default: 'active' },
    detectedAt: { type: Date, required: true },
    until: { type: Date, required: true }, // after this the number may try again
    source: { type: String, enum: ['connection', 'send'], required: true },
    code: { type: String, default: '' },
    reason: { type: String, default: '' },
    switchRequestedAt: { type: Date, default: null }, // the owner started linking a different number
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, enum: ['switched', 'expired', null], default: null },
  },
  { timestamps: true }
);
waRestrictionSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
waRestrictionSchema.index({ status: 1, until: 1 });
waRestrictionSchema.index({ resolvedAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 }); // old history is removed

// Baileys auth state, stored encrypted so sessions survive restarts and can move between instances.
const waAuthSchema = new Schema({ userId: { type: String, required: true }, key: { type: String, required: true }, value: { type: String, required: true } });
waAuthSchema.index({ userId: 1, key: 1 }, { unique: true });

// ---------------------------------------------------------------- Email
const smtpSettingsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, required: true },
    secure: { type: Boolean, default: false }, // true = implicit TLS (port 465)
    user: { type: String, default: '' },
    passEncrypted: { type: String, default: '' }, // AES-256-GCM, never returned to the client
    fromName: { type: String, default: '', trim: true },
    fromEmail: { type: String, required: true, lowercase: true, trim: true },
    replyTo: { type: String, default: '', lowercase: true, trim: true },
    // The address the owner proved they can read mail at (by entering a code we sent there). Sending needs it to equal fromEmail,
    // so changing the "from" address means proving the new one.
    verifiedEmail: { type: String, default: '', lowercase: true, trim: true },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const emailCampaignSchema = new Schema(
  {
    ...campaignFields(),
    subject: { type: String, required: true },
    // A/B test: a second subject line and the share (percent) of people who get it. Empty = no test.
    subjectB: { type: String, default: '' },
    splitB: { type: Number, default: 50 },
    body: { type: String, required: true },
    bodyFormat: { type: String, enum: ['text', 'html'], default: 'text' },
  },
  { timestamps: true }
);
emailCampaignSchema.index({ userId: 1, createdAt: -1 });
emailCampaignSchema.index({ userId: 1, status: 1 });
emailCampaignSchema.index({ status: 1, updatedAt: 1 });

const emailRecipientSchema = new Schema(
  {
    ...recipientFields('EmailCampaign'),
    email: { type: String, required: true, lowercase: true, trim: true },
    // Which subject line this person gets in an A/B test (null when there is no test).
    variant: { type: String, enum: ['A', 'B', null], default: null },
    // What happened after delivery: the address bounced later, the person reported spam, or unsubscribed.
    feedback: { type: String, enum: ['bounced', 'complaint', 'unsubscribed', null], default: null },
    feedbackAt: { type: Date, default: null },
  },
  { timestamps: true }
);
recipientIndexes(emailRecipientSchema, 'email');

// Addresses we must never email again: they unsubscribed, reported spam, or the mailbox does not exist (hard bounce).
const emailOptOutSchema = new Schema(
  {
    userId: ref('User'),
    email: { type: String, required: true, lowercase: true, trim: true },
    reason: { type: String, enum: ['unsubscribed', 'bounced', 'complaint'], default: 'unsubscribed' },
    detail: { type: String, default: '' }, // what the provider said, when it told us
  },
  { timestamps: true }
);
emailOptOutSchema.index({ userId: 1, email: 1 }, { unique: true });

// ---------------------------------------------------------------- saved contact lists
const contactListSchema = new Schema(
  {
    userId: ref('User'),
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['whatsapp', 'email'], required: true },
    columns: { type: [String], default: [] }, // the extra columns of the contacts (usable as {{column}})
  },
  { timestamps: true }
);
contactListSchema.index({ userId: 1, kind: 1, createdAt: -1 });
contactListSchema.index({ userId: 1, kind: 1, name: 1 }, { unique: true }); // one list per name

const listContactSchema = new Schema(
  {
    listId: ref('ContactList'),
    userId: ref('User'),
    name: { type: String, default: '' },
    fields: { type: Schema.Types.Mixed, default: undefined }, // the contact's other columns
    value: { type: String, required: true }, // phone digits (WhatsApp) or lower-case email (email)
    lastCampaignAt: { type: Date, default: null }, // null = never included in a campaign
  },
  { timestamps: true }
);
listContactSchema.index({ listId: 1, value: 1 }, { unique: true });
listContactSchema.index({ listId: 1, lastCampaignAt: 1, _id: 1 }); // "next batch of people not messaged yet"
listContactSchema.index({ userId: 1, listId: 1 }); // counts per list

// ---------------------------------------------------------------- saved message templates
const templateSchema = new Schema(
  {
    userId: ref('User'),
    kind: { type: String, enum: ['whatsapp', 'email'], required: true },
    name: { type: String, required: true, trim: true },
    message: { type: String, default: '' }, // WhatsApp
    subject: { type: String, default: '' }, // email
    body: { type: String, default: '' }, // email
    bodyFormat: { type: String, enum: ['text', 'html'], default: 'text' },
  },
  { timestamps: true }
);
templateSchema.index({ userId: 1, kind: 1, name: 1 }, { unique: true }); // one template per name
templateSchema.index({ userId: 1, kind: 1, updatedAt: -1 });

// ---------------------------------------------------------------- alerts
const notificationSchema = new Schema(
  {
    userId: ref('User'),
    type: { type: String, required: true }, // whatsapp_disconnected | campaign_paused | campaign_completed
    level: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    link: { type: String, default: '' }, // page inside the app
    read: { type: Boolean, default: false },
    emailed: { type: Boolean, default: false },
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true }
);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 }); // Mongo deletes alerts after 60 days

// ---------------------------------------------------------------- locks
const lockSchema = new Schema({ _id: { type: String }, owner: { type: String }, expiresAt: { type: Date, required: true } });
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo removes expired locks on its own

// A named set of limits that an administrator can give to accounts (for example "free" or "pro").
const planSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    limits: { type: limitsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Who did what, and when: administrator actions and security-relevant account events. Entries are only ever added
// (nothing in the API changes or removes them); old ones are deleted after AUDIT_RETENTION_DAYS.
// Email addresses are copied in, so an entry still makes sense after the account is gone. Never holds passwords or tokens.
const auditLogSchema = new Schema(
  {
    action: { type: String, required: true, maxlength: 40 }, // e.g. 'user.suspended', 'password.changed'
    actorId: { type: Schema.Types.ObjectId, default: null }, // null for the command line
    actorEmail: { type: String, default: '' },
    targetId: { type: Schema.Types.ObjectId, default: null }, // the account acted on, when someone else's
    targetEmail: { type: String, default: '' },
    ip: { type: String, default: '' },
    requestId: { type: String, default: '' },
    detail: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: { createdAt: 'at', updatedAt: false } }
);
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ targetId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ actorEmail: 1, at: -1 });
auditLogSchema.index({ targetEmail: 1, at: -1 });

export const User = mongoose.model('User', userSchema);
export const Campaign = mongoose.model('Campaign', campaignSchema);
export const Recipient = mongoose.model('Recipient', recipientSchema);
export const OptOut = mongoose.model('OptOut', optOutSchema);
export const Reply = mongoose.model('Reply', replySchema);
export const SessionLease = mongoose.model('SessionLease', sessionLeaseSchema);
export const WaAuth = mongoose.model('WaAuth', waAuthSchema);
// Where to read replies to email campaigns: the owner's own mailbox, read over IMAP.
const imapSettingsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, default: 993 },
    secure: { type: Boolean, default: true },
    user: { type: String, required: true, trim: true },
    passEncrypted: { type: String, default: '' }, // AES-256-GCM, never returned to the client
    enabled: { type: Boolean, default: true },
    // Where reading stopped: the mailbox's UID validity and the last message number handled, so each message is read once.
    uidValidity: { type: Number, default: null },
    lastUid: { type: Number, default: null },
    nextCheckAt: { type: Date, default: () => new Date(), index: true },
    leaseUntil: { type: Date, default: null }, // while set and in the future, one server instance is reading this mailbox
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    errorCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// A reply to an email campaign. Only people the account emailed in a campaign are stored; other mail is never kept.
const emailReplySchema = new Schema(
  {
    userId: ref('User'),
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: '' },
    subject: { type: String, default: '' },
    text: { type: String, default: '' }, // what the person wrote, without the quoted earlier mail
    messageId: { type: String, required: true }, // the mail's Message-ID, so a message is stored once
    campaignId: { type: Schema.Types.ObjectId, ref: 'EmailCampaign', default: null },
    recipientId: { type: Schema.Types.ObjectId, ref: 'EmailRecipient', default: null },
    variant: { type: String, enum: ['A', 'B', null], default: null },
    optOut: { type: Boolean, default: false }, // the reply asked to stop
    receivedAt: { type: Date, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
emailReplySchema.index({ userId: 1, messageId: 1 }, { unique: true });
emailReplySchema.index({ userId: 1, receivedAt: -1 });
emailReplySchema.index({ userId: 1, campaignId: 1 });

export const SmtpSettings = mongoose.model('SmtpSettings', smtpSettingsSchema);
export const ImapSettings = mongoose.model('ImapSettings', imapSettingsSchema);
export const EmailReply = mongoose.model('EmailReply', emailReplySchema);
export const EmailCampaign = mongoose.model('EmailCampaign', emailCampaignSchema);
export const EmailRecipient = mongoose.model('EmailRecipient', emailRecipientSchema);
export const EmailOptOut = mongoose.model('EmailOptOut', emailOptOutSchema);
export const AuthToken = mongoose.model('AuthToken', authTokenSchema);
export const Lock = mongoose.model('Lock', lockSchema);
export const ContactList = mongoose.model('ContactList', contactListSchema);
export const ListContact = mongoose.model('ListContact', listContactSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const Template = mongoose.model('Template', templateSchema);
// Proof that an account accepted a version of the Terms or Privacy Policy. Never edited: a new version means a new row.
const consentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  doc: { type: String, enum: ['terms', 'privacy'], required: true },
  version: { type: String, required: true },
  textHash: { type: String, required: true }, // sha256 of the exact text that was shown
  via: { type: String, enum: ['register', 'accept'], required: true },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  acceptedAt: { type: Date, default: Date.now },
});
consentSchema.index({ userId: 1, doc: 1, version: 1 }, { unique: true });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export const Consent = mongoose.model('Consent', consentSchema);

// The one-time code sent to a sender address, one per account. Only a keyed hash of the code is stored.
const senderOtpSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true },
  email: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  sentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
senderOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // removed an hour after it stops working

// Counts how often something happened in a time window (for example codes sent to one address). Removed by Mongo when the window is long over.
const rateBucketSchema = new Schema({ _id: { type: String }, count: { type: Number, default: 0 }, resetAt: { type: Date, required: true } });
rateBucketSchema.index({ resetAt: 1 }, { expireAfterSeconds: 3600 });

// A file an account uploaded to send with messages. The bytes are in GridFS (bucket "attachments"); this is the record of them.
const attachmentSchema = new Schema(
  {
    userId: ref('User'),
    name: { type: String, required: true }, // the cleaned file name shown to the owner and used for email attachments
    ext: { type: String, required: true },
    mime: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio', 'document'], required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    gridId: { type: Schema.Types.ObjectId, required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
attachmentSchema.index({ userId: 1, createdAt: -1 });
attachmentSchema.index({ gridId: 1 });

export const Attachment = mongoose.model('Attachment', attachmentSchema);
export const SenderOtp = mongoose.model('SenderOtp', senderOtpSchema);
export const RateBucket = mongoose.model('RateBucket', rateBucketSchema);
export const WaRestriction = mongoose.model('WaRestriction', waRestrictionSchema);
export const Plan = mongoose.model('Plan', planSchema);
