import { loadAttachment, resolveForCampaign } from '../attachments/store.js';
import { config } from '../config.js';
import { emailChannel } from '../engine/channels.js';
import { User } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { renderEmail } from '../utils/emailTemplate.js';
import { bad } from '../utils/http.js';
import { analyze, BUILT_IN, checkTemplate } from '../utils/template.js';
import { signUnsubscribe } from '../utils/unsubscribeToken.js';
import { describeSmtpError } from '../utils/smtpErrors.js';
import { getSender, invalidateSender } from './mailer.js';

/**
 * Send the campaign as it is written to the account owner's own address, so they see exactly what people will get.
 * With an A/B test, one email goes out per subject line. Test emails never count toward the daily limit,
 * and they only ever go to the account's own email address.
 * Returns { sentTo, sent, notFilled } where notFilled lists {{columns}} that stay blank because they come from the contact file.
 */
export async function sendTestEmail(userId, body) {
  const fields = emailChannel.readFields({ ...body, name: body.name || 'Test' });
  const problems = checkTemplate(emailChannel.templateTexts(fields));
  if (problems.length) throw bad(problems.join(' '));

  const account = await User.findById(userId).select('email').lean();
  if (!account) throw bad('Account not found', 404);

  let sender;
  try {
    sender = await getSender(userId, { allowUnverified: true }); // the mail goes to the owner, so the "from" check does not apply
  } catch (err) {
    throw bad(err.userMessage || `Your email settings cannot be used: ${err.message}`, 409);
  }
  if (!sender) throw bad('Add your email (SMTP) settings first.', 409);

  const { limits } = await resolveLimits(userId);
  const refs = await resolveForCampaign(userId, body.attachmentIds, 'email', limits);
  const attachments = [];
  for (const ref of refs) {
    const file = await loadAttachment(userId, ref.attachmentId);
    attachments.push({ filename: file.name, content: file.buffer, contentType: file.mime });
  }

  const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${signUnsubscribe({ userId, email: account.email })}`;
  const sampleName = String(body.sampleName || '').trim().slice(0, 100) || 'Test name';
  const versions = fields.subjectB ? ['A', 'B'] : [null];

  try {
    for (const variant of versions) {
      const mail = renderEmail(fields, { name: sampleName, fields: {}, variant }, unsubscribeUrl);
      const label = variant ? `[Test, subject ${variant}] ` : '[Test] ';
      await sender.transport.sendMail({
        from: sender.from,
        replyTo: sender.replyTo,
        to: account.email,
        subject: label + mail.subject,
        text: mail.text,
        html: mail.html,
        ...(attachments.length ? { attachments } : {}),
      });
    }
  } catch (err) {
    invalidateSender(userId);
    throw bad(`The test email could not be sent: ${describeSmtpError(err)}`, 422);
  }

  const notFilled = analyze(emailChannel.templateTexts(fields)).variables.map((v) => v.key).filter((k) => !BUILT_IN.includes(k));
  return { sentTo: account.email, sent: versions.length, notFilled };
}
