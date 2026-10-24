import sanitizeHtml from 'sanitize-html';
import { fillVariables } from './template.js';

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only simple formatting is allowed in user-written HTML (no scripts, forms, iframes, images).
const HTML_OPTIONS = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'blockquote', 'hr', 'span', 'div'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
};

const htmlToText = (html) =>
  sanitizeHtml(html.replace(/<(br|\/p|\/div|\/li|\/h[1-3])\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Build the subject/text/html parts of one email.
 * - {{name}}, {{first_name}} and {{any_other_column}} are filled in for this contact (see utils/template.js)
 * - an unsubscribe footer with a per-recipient link is always added
 */
export function renderEmail(campaign, recipient, unsubscribeUrl) {
  const contact = { name: recipient.name, fields: recipient.fields };

  const chosen = recipient.variant === 'B' && campaign.subjectB ? campaign.subjectB : campaign.subject; // A/B test
  const subject = fillVariables(chosen, contact).replace(/[\r\n]+/g, ' ').trim();

  let bodyHtml;
  let bodyText;
  if (campaign.bodyFormat === 'html') {
    const filled = fillVariables(campaign.body, contact, escapeHtml);
    bodyHtml = sanitizeHtml(filled, HTML_OPTIONS);
    bodyText = htmlToText(bodyHtml);
  } else {
    bodyText = fillVariables(campaign.body, contact);
    bodyHtml = `<div style="white-space:pre-wrap">${escapeHtml(bodyText)}</div>`;
  }

  const footerText = `\n\n--\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
  const footerHtml =
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
    `<p style="font-size:12px;color:#777;margin:0">Don't want these emails? ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#777">Unsubscribe</a></p>`;

  return {
    subject,
    text: bodyText + footerText,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${bodyHtml}${footerHtml}</div>`,
  };
}
