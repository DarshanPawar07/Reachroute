import { createHash } from 'node:crypto';
import { config } from '../config.js';

/**
 * The Terms of Service and Privacy Policy. Each has a version: change the text, change the version (a date).
 * A new version means everyone must accept again before they start another campaign.
 *
 * These are a sound starting point written for how this service really works. They are not legal advice:
 * have a lawyer who knows your country's rules read them before you open the service to the public.
 */
export const VERSIONS = { terms: '2026-10-27', privacy: '2026-10-27' };
export const DOC_NAMES = Object.keys(VERSIONS);
// Pages anyone can read but nobody has to accept (they are linked from Terms).
export const INFO_DOCS = { refunds: '2026-10-27' };
export const PAGE_DOCS = [...DOC_NAMES, ...Object.keys(INFO_DOCS)];

const days = (n) => (n > 0 ? `${n} days` : 'until the account is deleted');

function terms() {
  const who = config.legalName;
  return {
    title: 'Terms of Service',
    sections: [
      { heading: '1. The service', paragraphs: [
        `${who} ("we", "us") provides a tool to send emails and WhatsApp messages to people you choose, in bulk (the "Service"). By creating an account or using the Service you agree to these Terms. If you do not agree, do not use it.`,
        'You must be at least 18 years old and able to enter into a contract.',
      ] },
      { heading: '2. Your account', paragraphs: [
        'You are responsible for everything done through your account and for keeping your password safe. Tell us at once if you think someone else has used it. Give us a real email address: we use it for security and service messages.',
      ] },
      { heading: '3. Who you may message', paragraphs: [
        'You may only message people who have agreed to hear from you, or whom you may lawfully contact for the message you send. When you start a campaign you confirm this. You are the one responsible for that permission, not us.',
        'Do not use the Service for spam, scams, phishing, harassment, adult or illegal content, or anything that breaks the law that applies to you or to the people you message. Do not hide who you are. Every email includes an unsubscribe link and you must not remove it or ignore requests to stop. People who opt out or whose address bounces will not be messaged again from your account.',
      ] },
      { heading: '4. WhatsApp', paragraphs: [
        'WhatsApp is linked by scanning a QR code, the way WhatsApp Web works. This is not an official WhatsApp business connection. WhatsApp may restrict or ban a number that sends many messages, especially to people who did not expect them. We slow sending down and offer safety checks, but we cannot promise your number will not be restricted. Using the Service for WhatsApp is at your own risk, and we advise against using a number you cannot afford to lose.',
      ] },
      { heading: '5. Email', paragraphs: [
        'Emails are sent through the mail server (SMTP) that you set up. Your sender reputation depends on your list quality, your domain settings (SPF, DKIM and DMARC) and your mail provider\'s rules. You must follow your provider\'s terms as well as these.',
      ] },
      { heading: '6. Limits and plans', paragraphs: [
        'Each account has limits, such as messages per day, saved lists and unfinished campaigns. They depend on your plan and may be changed by us. You can see yours in the app. The free plan gives a one-time allowance of messages that is not refilled.',
      ] },
      { heading: '7. Payments and subscriptions', paragraphs: [
        'Paid plans are subscriptions. You choose a monthly or yearly price and pay in advance, in Indian rupees, through Razorpay (cards, UPI and net banking). The subscription renews automatically at the end of each period, at the price you agreed when you subscribed, until you cancel. We do not see or store your card or bank details; Razorpay does.',
        'You can cancel at any time in the app. A cancelled plan stays active until the end of the period you already paid for and then moves back to the free limits. If a renewal payment fails, Razorpay tries again for a few days; if it keeps failing the plan ends.',
        'If we change the price of a plan, subscriptions you already have keep their price until you subscribe again. Prices include GST where we are registered for it. Refunds are covered by the Refund and Cancellation Policy at /legal/refunds.',
      ] },
      { heading: '8. Your content', paragraphs: [
        'You keep all rights to the contact lists, messages and files you put into the Service. You allow us to store and process them only to run the Service for you. You promise you have the right to use them this way.',
      ] },
      { heading: '9. Suspension and ending', paragraphs: [
        'We may pause or suspend an account that breaks these Terms, causes complaints, or puts the Service or other people at risk. Your data is kept while an account is suspended. You may stop using the Service at any time; ask us to delete your account and data (see the Privacy Policy).',
      ] },
      { heading: '10. No guarantees', paragraphs: [
        'The Service is provided "as is". Delivery depends on others (mail servers, WhatsApp, phone networks), so we cannot promise that a message is delivered, opened, or read, or that the Service is always available.',
      ] },
      { heading: '11. Our responsibility', paragraphs: [
        'To the extent the law allows, we are not liable for lost profit, lost business, a restricted or banned phone number or email domain, or indirect damage, and our total liability for any claim is limited to the amount you paid us in the 3 months before it. Nothing here limits liability that cannot be limited by law.',
        'You will cover our losses if a claim is made against us because of the messages you send or the people you message.',
      ] },
      { heading: '12. Changes', paragraphs: [
        'We may change these Terms. When we do, we change the version date at the top and ask you to accept the new version before you start another campaign.',
      ] },
      { heading: '13. Law and contact', paragraphs: [
        'These Terms are governed by the laws of India. Courts in India have jurisdiction, unless the law gives you the right to go elsewhere.',
        config.legalContactEmail ? `Questions and complaints: ${config.legalContactEmail}.` : 'Questions and complaints: use the contact address given by the person running this service.',
      ] },
    ],
  };
}

function privacy() {
  const who = config.legalName;
  const contact = config.legalContactEmail || 'the contact address given by the person running this service';
  return {
    title: 'Privacy Policy',
    sections: [
      { heading: '1. Who this covers', paragraphs: [
        `${who} runs the Service. This explains what information we keep, why, and what you can ask us to do. There are two kinds of people: you (the account holder), and the people you message (your "recipients").`,
      ] },
      { heading: '2. What we keep about you', paragraphs: [
        'Your email address, a scrambled form of your password (we cannot read it), when you signed up and last logged in, your plan and limits, and proof that you accepted these documents (which version, when, and from which address).',
        'The mail server details you enter (the password is stored encrypted), your WhatsApp connection data (kept encrypted so the link survives restarts), your subscription and invoice records (plan, amount, dates, and the billing name, address and GSTIN if you give them), and a record of important actions on your account, such as password changes and sign-in problems, with the internet address they came from. Our servers also keep short-lived technical logs.',
      ] },
      { heading: '3. What we keep about your recipients', paragraphs: [
        'The names, email addresses, phone numbers and other columns you upload, the messages you write, and what happened to each message (sent, failed, bounced, opted out, replied). WhatsApp replies you receive are stored so you can read them.',
        'For this information you decide why and how it is used; we only handle it for you, to run the Service. You are responsible for having a lawful reason to hold and use it.',
      ] },
      { heading: '4. Why we use it', paragraphs: [
        'To run your campaigns and keep the Service safe and working: signing you in, sending your messages, respecting opt-outs, limiting abuse, finding faults, and answering your questions. We do not sell your information or your recipients\' information, and we do not use it for advertising.',
      ] },
      { heading: '5. Who else sees it', paragraphs: [
        'Your messages go through the services needed to deliver them: your own mail server for email, and WhatsApp for WhatsApp messages. Our hosting and database providers store the data for us. Payments are handled by Razorpay, which receives the details you enter to pay and tells us whether the payment worked; we never see or store your full card or bank details. An administrator of the Service can see account details and counts for support and safety; they cannot read your message texts, passwords or mail server passwords. We share information with authorities only when the law requires it.',
      ] },
      { heading: '6. How long we keep it', paragraphs: [
        `Message records are deleted ${days(config.retentionDays)} after they are finished. Action records (the audit log) are deleted after ${days(config.auditRetentionDays)}. Your account and lists stay until you ask us to delete them. Invoices and payment records are kept for as long as tax and accounting law requires, even if you delete your account. Backups are rotated and may hold deleted data for a short while.`,
      ] },
      { heading: '7. How we protect it', paragraphs: [
        'Passwords are hashed; mail server passwords and WhatsApp data are encrypted; connections use HTTPS; access is limited and logged. No system is perfectly safe, so we cannot promise absolute security. If we find a breach that affects you we will tell you as the law requires.',
      ] },
      { heading: '8. Your choices and rights', paragraphs: [
        `You can ask to see, correct, export or delete your information, withdraw your consent, or complain. Write to ${contact}. Recipients can opt out of emails with the link in every email, or by replying to a WhatsApp message with a stop word; we remember that and do not message them again from that account. A recipient who wants their details removed from someone's list should also ask the account holder who sent the message.`,
      ] },
      { heading: '9. Cookies', paragraphs: [
        'We do not use advertising or tracking cookies. The app keeps your sign-in token in your browser so you stay logged in.',
      ] },
      { heading: '10. Children', paragraphs: [
        'The Service is for people aged 18 and over. We do not knowingly keep information about children as account holders.',
      ] },
      { heading: '11. Changes and contact', paragraphs: [
        'When this policy changes, we change the version date and ask you to accept the new version before you start another campaign.',
        `Contact: ${contact}.`,
      ] },
    ],
  };
}

function refunds() {
  const days = config.refundWindowDays;
  const contact = config.legalContactEmail || 'the contact address given by the person running this service';
  return {
    title: 'Refund and Cancellation Policy',
    sections: [
      { heading: '1. Cancelling', paragraphs: [
        'You can cancel a paid plan at any time from the Plan and billing page. You keep the plan until the end of the period you paid for, and it does not renew. Cancelling does not delete your account, lists or reports.',
      ] },
      { heading: '2. Refunds', paragraphs: [
        days > 0
          ? `If you are not satisfied with a new paid plan, write to ${contact} within ${days} days of your first payment and we will refund it in full, provided the plan was not used to send a large volume of messages. Renewals are not refunded automatically, but write to us within ${days} days if you were charged by mistake or did not mean to renew, and we will look at it fairly.`
          : 'Payments are not refundable once made, except where the law says otherwise or we charged you by mistake.',
        'We always refund a payment taken twice, a payment taken after you cancelled, and a payment for a plan that the service could not provide.',
      ] },
      { heading: '3. Changing plans', paragraphs: [
        'When you move to a different plan, the new plan starts at once and your previous subscription stops. The unused part of the previous period is not refunded automatically. If this affects you, write to us within the refund window above and we will sort it out.',
      ] },
      { heading: '4. The free allowance', paragraphs: [
        'The free plan costs nothing. Its message allowance is given once and is not refilled or exchanged for money.',
      ] },
      { heading: '5. How refunds are paid', paragraphs: [
        'Refunds go back to the card, UPI account or bank you paid with, through Razorpay. They usually reach you in 5 to 7 working days, depending on your bank.',
      ] },
      { heading: '6. Failed or stopped payments', paragraphs: [
        'If a renewal fails, we email you and Razorpay retries for a few days. If it still fails, the plan ends and the account moves back to the free limits. Nothing is charged after that unless you subscribe again.',
      ] },
      { heading: '7. Contact', paragraphs: [`Questions about a payment or a refund: ${contact}. Please include the email address of your account and the date of the payment.`] },
    ],
  };
}

const BUILDERS = { terms, privacy, refunds };

/** One document as data: { doc, title, version, hash, sections: [{ heading, paragraphs }] }. null for an unknown name. */
export function getDocument(doc) {
  if (!Object.hasOwn(BUILDERS, doc)) return null;
  const body = BUILDERS[doc]();
  const version = VERSIONS[doc] || INFO_DOCS[doc];
  const hash = createHash('sha256').update(JSON.stringify([doc, version, body])).digest('hex');
  return { doc, title: body.title, version, hash, sections: body.sections };
}

export const allDocuments = () => DOC_NAMES.map(getDocument);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain, self-contained web page for a document, so it can be linked from emails and the sign-up form. */
export function renderHtml(document) {
  const body = document.sections.map((s) => `<h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}`).join('');
  const other = PAGE_DOCS.filter((d) => d !== document.doc).map((d) => `<a href="/legal/${d}">${esc(getDocument(d).title)}</a>`).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(document.title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.5rem 1rem;color:#1a1a1a}h1{font-size:1.7rem}h2{font-size:1.15rem;margin-top:1.8rem}.meta,nav{color:#555;font-size:.9rem}@media(prefers-color-scheme:dark){body{background:#111;color:#eaeaea}.meta,nav{color:#aaa}a{color:#8ab4ff}}</style></head>
<body><h1>${esc(document.title)}</h1><p class="meta">Version ${esc(document.version)}</p>${body}<nav>${other}</nav></body></html>`;
}
