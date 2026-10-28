// All the words on the public pages. Every claim here describes something the app does today,
// except where a line says "planned" or "coming": Instagram and Facebook are not built yet.
import { PATHS } from './siteConfig.js';

export const HOME_FAQ = [
  {
    q: 'What is Reachroute?',
    a: 'Reachroute is a web app for sending bulk WhatsApp messages and bulk emails to the people on your contact lists. You upload your contacts, write the message once, and Reachroute sends it one by one at a safe pace and gives you a report of what happened.',
  },
  {
    q: 'Is Reachroute free?',
    a: 'Yes, to start. The free plan includes 50 WhatsApp messages and 100 emails in total, with scheduling, templates, contact lists and reports. It does not refill, so when you have used them you choose Pro or Premium to keep sending. You do not need a card to start.',
  },
  {
    q: 'Do I need the official WhatsApp Business API?',
    a: 'No. You link your own WhatsApp number by scanning a QR code, the same way you link WhatsApp Web, so there is no approval process and no per-message fee. This is not Meta’s official Business API, so please read the next answer about risk.',
  },
  {
    q: 'Is there a risk to my WhatsApp number?',
    a: 'WhatsApp can restrict numbers that message people who do not want to hear from them. Reachroute lowers the risk with random pauses between messages, hourly and daily limits, and a STOP rule that never messages the same person again. It also pauses your campaigns if WhatsApp starts refusing messages. Only message people who agreed to hear from you, and start small with a new number.',
  },
  {
    q: 'Which email accounts can I send from?',
    a: 'Any account that offers SMTP: Gmail, Outlook, Zoho, Brevo, Amazon SES and others. You prove you own the sending address with a code before your first campaign. For large lists, use a sending service instead of a personal Gmail account.',
  },
  {
    q: 'Is bulk messaging legal?',
    a: 'The rules depend on your country, and this is not legal advice. In general you need the permission of the people you message and a way for them to opt out. Reachroute asks you to confirm consent for every campaign, adds an unsubscribe link to every email, and stops messaging anyone who replies STOP on WhatsApp.',
  },
  {
    q: 'Can I send Instagram or Facebook messages?',
    a: 'Not yet. Instagram and Facebook Messenger are planned. Tell us what you would use them for on the contact page and we will let you know when they are ready.',
  },
  {
    q: 'How do I upgrade to a paid plan?',
    a: 'Log in, open Plan and billing and choose Pro or Premium, monthly or yearly. You pay through Razorpay and the plan starts straight away. Your campaigns and lists stay exactly as they are.',
  },
];

export const PRICING_FAQ = [
  { q: 'Do I need a card for the free plan?', a: 'No. Create an account and start sending within the free allowance of 50 WhatsApp messages and 100 emails.' },
  {
    q: 'What happens when I reach a limit?',
    a: 'Daily limits count the messages sent in the last 24 hours, and the monthly amount counts the last 30 days. A campaign that would go over a limit does not start, and Reachroute tells you how many messages you have left. The limits also protect your WhatsApp number and your email reputation.',
  },
  { q: 'How do I pay for a paid plan?', a: 'Choose Pro or Premium on the Plan and billing page and pay with Razorpay: UPI, cards or net banking. It renews every month or every year until you cancel. The yearly price is two months cheaper.' },
  { q: 'Can I get a refund?', a: 'If you are not satisfied with a new paid plan, write to us within 7 days of your first payment. The full policy, including cancelling and changing plans, is on the refund and cancellation page.' },
  { q: 'Do I get an invoice?', a: 'Yes. After every payment you can open and print an invoice from the Plan and billing page, and we email you a payment confirmation. You can add your business name, address and GSTIN before you pay so they appear on it.' },
  { q: 'Can I switch plans later?', a: 'Yes. Cancel any time and keep the plan until the period you paid for ends, or move up to a bigger plan. Your lists, templates and reports are kept.' },
  { q: 'Do the limits include emails sent through my own SMTP provider?', a: 'Reachroute counts every email it sends for you. Your email provider has its own limits too: for example, a personal Gmail account allows roughly 500 emails a day, so a sending service suits bigger lists.' },
];

export const HOW_IT_WORKS = [
  { title: 'Add your contacts', text: 'Upload a CSV or Excel file, or pick a saved list. Phone numbers and emails are checked and duplicates are removed before anything is sent.' },
  { title: 'Write the message once', text: 'Add each person’s name and any column from your file. Send yourself a test email first to see exactly how it will look.' },
  { title: 'Send at a safe pace', text: 'Messages go out one at a time with random pauses and daily limits. Start now, or schedule it and set the hours it may send.' },
  { title: 'Read the report', text: 'See who received what, send again to the people who failed, and download the whole campaign as a spreadsheet.' },
];

export const FEATURE_LEDGER = [
  { title: 'Personalised at scale', text: 'Use {{name}} and any column from your file, such as {{city}}. Vary wording with {Hi|Hello|Hey} so messages do not look copied.' },
  { title: 'A pace that protects you', text: 'Random pauses between messages and hourly and daily limits keep your WhatsApp number and your email reputation healthy.' },
  { title: 'Scheduling with sending hours', text: 'Start a campaign later and only send between the hours you choose, in your own time zone.' },
  { title: 'Attachments', text: 'Send an image, PDF or video on WhatsApp, and up to five files on an email.' },
  { title: 'Contact lists that stay organised', text: 'Save lists, put people in groups such as city or class, search and edit them, and message only the people you have not messaged yet.' },
  { title: 'Templates', text: 'Save the messages you reuse and load them into any new campaign in one click.' },
  { title: 'A/B tested email subjects', text: 'Send two subject lines to different shares of your list and compare how each one did.' },
  { title: 'Reports you can download', text: 'Every campaign shows who received it and who did not, with the reason, and exports to CSV.' },
  { title: 'Fix what failed', text: 'Retry the failures inside a campaign, or send again to them as a new campaign. Duplicate any campaign to start the next one.' },
  { title: 'Opt-outs and bounces handled', text: 'People who unsubscribe or reply STOP are never contacted again, and email addresses that bounce are removed from future sends.' },
];

export const RESPONSIBLE = [
  'You confirm that everyone on the list agreed to hear from you before every campaign.',
  'Every email carries an unsubscribe link that Reachroute adds for you.',
  'A WhatsApp reply of STOP puts the person on your do-not-message list straight away.',
  'Campaigns pause by themselves after repeated failures, or if WhatsApp restricts your number.',
];

export const USE_CASES = [
  { who: 'Coaching classes and colleges', what: 'Timetable changes, fee reminders and exam notices to students and parents.' },
  { who: 'Local shops and restaurants', what: 'A new batch, a festival offer or a restock, sent to your regulars.' },
  { who: 'Event organisers', what: 'Invitations, reminders and thank-you notes to everyone who registered.' },
  { who: 'Real estate and services', what: 'New listings and follow-ups for people who gave you their number.' },
  { who: 'Communities and NGOs', what: 'Meeting notices and volunteer calls for members who asked to be kept informed.' },
  { who: 'Freelancers and consultants', what: 'Proposals, newsletters and reminders to your own client list.' },
];

/** The four channels. `status: 'live'` ones are built; `'soon'` ones are described honestly as planned. */
export const CHANNELS = {
  whatsapp: {
    key: 'whatsapp',
    status: 'live',
    name: 'WhatsApp',
    short: 'Bulk WhatsApp',
    icon: 'whatsapp',
    color: 'wa',
    path: PATHS.whatsapp,
    summary: 'Send bulk WhatsApp messages from your own number, with pauses and limits that protect it.',
    h1: 'Send bulk WhatsApp messages from your own number',
    lead: 'Link your WhatsApp the way you link WhatsApp Web, upload your contacts, and Reachroute sends your message to each person at a safe pace. No Business API approval, no per-message fee, and no need to save the numbers in your phone first.',
    sections: [
      {
        title: 'Link your number in a minute',
        text: 'Scan a QR code from WhatsApp on your phone and your number is connected. Messages go out from your own number, so people see a name they already know.',
      },
      {
        title: 'Messages that do not look mass-produced',
        text: 'Add each person’s name and any column from your file, and vary the wording with options like {Hi|Hello|Hey}. Messages are sent one at a time with random pauses, within hourly and daily limits.',
      },
      {
        title: 'Send now or at the right time',
        text: 'Schedule a campaign for later and choose the hours and days it may send, so nobody gets a message at midnight.',
      },
      {
        title: 'Images, PDFs and video',
        text: 'Attach a file to your message, up to 16 MB on the free plan. Upload it once and reuse it in later campaigns.',
      },
      {
        title: 'STOP means stop',
        text: 'When someone replies STOP, they go on your do-not-message list and are skipped in every future campaign. You can read the replies you receive inside Reachroute.',
      },
      {
        title: 'Protection if WhatsApp pushes back',
        text: 'If WhatsApp starts refusing messages from your number, Reachroute pauses your campaigns and tells you, instead of pushing on and making it worse.',
      },
      {
        title: 'A report for every campaign',
        text: 'See which numbers received the message, which are not on WhatsApp, and which failed and why. Send again to the failures, or download everything as a CSV.',
      },
    ],
    specs: [
      ['Free plan', '50 messages in total, then choose a plan'],
      ['Contacts per upload', '50 on Free, 200 on Pro, 500 on Premium'],
      ['Attachment size', '16 MB'],
      ['Contact files', 'CSV, Excel or JSON'],
      ['Personalisation', 'Name and any column of your file'],
    ],
    goodToKnow: {
      title: 'Good to know before you start',
      text: 'Reachroute links to your own WhatsApp the way WhatsApp Web does. It is not Meta’s official Business API. WhatsApp can restrict numbers that message people who do not want to hear from them, so only message people who agreed to hear from you, begin with a small campaign on a new number, and keep your message useful.',
    },
    faq: [
      { q: 'Can I send bulk WhatsApp messages for free?', a: 'Yes, to try it: the free plan includes 50 WhatsApp messages from your own number, with no card needed. It does not refill. Pro sends up to 200 a day and Premium up to 500 a day.' },
      { q: 'Do I have to save my contacts’ numbers first?', a: 'No. Upload a file with names and phone numbers and Reachroute sends to them directly. Nothing is added to your phone’s contacts.' },
      { q: 'Will my WhatsApp number get banned?', a: 'Nobody can promise that it will not. WhatsApp restricts numbers that message people who do not want to hear from them. Reachroute paces your messages, enforces limits, honours STOP replies and pauses if WhatsApp refuses messages, but the best protection is to message only people who agreed to hear from you.' },
      { q: 'Do I need the WhatsApp Business API?', a: 'No. You link your own number with a QR code. The trade-off is that this is not the official API, so use it for people who know you, not for cold outreach.' },
      { q: 'Which phone number formats work?', a: 'Numbers with or without a country code. Numbers without one are read as Indian numbers, and invalid numbers are listed so you can fix them.' },
    ],
  },
  email: {
    key: 'email',
    status: 'live',
    name: 'Email',
    short: 'Bulk email',
    icon: 'mail',
    color: 'mail',
    path: PATHS.email,
    summary: 'Send bulk email from your own address, with an unsubscribe link on every message.',
    h1: 'Send bulk email from your own address',
    lead: 'Connect the email account you already use, upload your list, and Reachroute sends a personal email to each person. Every message carries an unsubscribe link, and you can test the whole thing on yourself first.',
    sections: [
      {
        title: 'Use the email account you already have',
        text: 'Connect any provider that offers SMTP, including Gmail, Outlook, Zoho, Brevo and Amazon SES. You prove you own the sending address with a code we email you, so nobody can send as an address that is not theirs.',
      },
      {
        title: 'Personal, not copied',
        text: 'Put each person’s name and any column from your file in the subject and the body. Write in plain text or basic HTML.',
      },
      {
        title: 'Send yourself a test first',
        text: 'One click sends the email to your own inbox exactly as your contacts will see it, without using up your daily limit.',
      },
      {
        title: 'Test two subject lines',
        text: 'Send subject A to some people and subject B to others, then compare how each one did in the campaign report.',
      },
      {
        title: 'Unsubscribes and bounces taken care of',
        text: 'An unsubscribe link is added to every email for you. People who unsubscribe are never emailed again, and addresses that bounce are stopped automatically when your mailbox or your email provider reports them.',
      },
      {
        title: 'Attach up to five files',
        text: 'Add PDFs, images and documents to your email, up to 10 MB each on the free plan.',
      },
      {
        title: 'Schedule it and read the report',
        text: 'Start later within the hours you choose. Afterwards see who received the email and who did not, send again to the failures, and download a CSV.',
      },
    ],
    specs: [
      ['Free plan', '100 emails in total, then choose a plan'],
      ['Contacts per upload', '50 on Free, 500 on Pro, 2,000 on Premium'],
      ['Attachments', 'Up to 5 files, 10 MB each'],
      ['Formats', 'Plain text or basic HTML'],
      ['Sending from', 'Your own SMTP account'],
    ],
    goodToKnow: {
      title: 'Good to know before you start',
      text: 'Reachroute sends through your email account, so your provider’s limits apply as well: a personal Gmail account allows roughly 500 emails a day. For larger lists use a sending service such as Brevo or Amazon SES with your own domain. Whether an email reaches the inbox depends on your domain and your content as well as on how it is sent.',
    },
    faq: [
      { q: 'How do I send bulk email from Gmail?', a: 'Turn on two-step verification in Google, create an app password, and enter it in Reachroute with smtp.gmail.com as the server. Then upload your list and send. Gmail allows roughly 500 emails a day on a personal account.' },
      { q: 'Will my emails go to spam?', a: 'Nobody can guarantee inbox delivery. It depends on your sending domain, your content and whether people want your mail. Reachroute helps by adding an unsubscribe link, pacing your sends and removing addresses that bounce. For larger lists, use a sending service with your own domain.' },
      { q: 'Is an unsubscribe link added automatically?', a: 'Yes. Every email carries one, and anyone who uses it is never emailed again by your account.' },
      { q: 'Can I see what the email looks like before sending?', a: 'Yes. Send a test email to your own address. It looks exactly like the real one and does not count towards your daily limit.' },
      { q: 'How many emails can I send for free?', a: 'The free plan includes 100 emails in total. Pro sends up to 400 a day and Premium up to 1,000 a day, within your email provider’s own limits.' },
    ],
  },
  instagram: {
    key: 'instagram',
    status: 'soon',
    name: 'Instagram',
    short: 'Bulk Instagram',
    icon: 'instagram',
    color: 'ig',
    path: PATHS.instagram,
    summary: 'Instagram messaging is planned. Tell us what you would use it for.',
    h1: 'Bulk Instagram messaging is coming to Reachroute',
    lead: 'We are planning to bring Instagram direct messages into the same dashboard as your WhatsApp and email campaigns, with the same templates, scheduling and reports. It is not available yet.',
    sections: [
      {
        title: 'What we are planning',
        text: 'Use one template across channels, schedule messages, and see every result in the same report. People who already talk to your Instagram account are the natural first audience.',
      },
      {
        title: 'Why it is not live yet',
        text: 'Instagram limits when a business may start a conversation, and automated messaging outside those rules puts accounts at risk. We would rather build on the rules Meta allows than ship something that gets your account restricted.',
      },
      {
        title: 'What it will not be',
        text: 'It will not ask for your Instagram password, and it will not message people who have never heard from you. That is not how we want to protect your account.',
      },
      {
        title: 'Help us build the right thing',
        text: 'Tell us how you would use it: replying to enquiries, following up on comments, or sending updates to people who messaged you. The answers decide what we build first.',
      },
    ],
    faq: [
      { q: 'When will bulk Instagram messaging be available?', a: 'We do not have a date yet, and we will not promise one. Tell us you are interested on the contact page and we will let you know when it is ready.' },
      { q: 'Can I use Reachroute for Instagram today?', a: 'No. Today Reachroute sends WhatsApp messages and emails. Instagram is planned.' },
      { q: 'Will it work for people who never contacted my account?', a: 'We expect Meta’s rules to limit when a business can start a conversation, so the first version will focus on people who already interact with you. We will publish the details when we build it.' },
    ],
  },
  facebook: {
    key: 'facebook',
    status: 'soon',
    name: 'Facebook Messenger',
    short: 'Bulk Facebook',
    icon: 'messenger',
    color: 'fb',
    path: PATHS.facebook,
    summary: 'Facebook Messenger is planned. Tell us what you would use it for.',
    h1: 'Bulk Facebook Messenger messaging is coming to Reachroute',
    lead: 'We are planning to add Facebook Messenger for your business Page, next to WhatsApp and email, with the same templates, scheduling and reports. It is not available yet.',
    sections: [
      {
        title: 'What we are planning',
        text: 'Messages to the people who have already messaged your Facebook Page, written once with the same templates and personalisation you use today, scheduled and reported on in one place.',
      },
      {
        title: 'Why it is not live yet',
        text: 'Meta controls when a business can message someone on Messenger, and it enforces those rules. We are building around them so your Page stays in good standing.',
      },
      {
        title: 'What it will not be',
        text: 'It will not scrape profiles or message strangers. Reachroute is for people who asked to hear from you.',
      },
      {
        title: 'Help us build the right thing',
        text: 'Tell us how your business uses Messenger today, and what would save you the most time. We read every message.',
      },
    ],
    faq: [
      { q: 'When will bulk Facebook Messenger messaging be available?', a: 'We do not have a date, and we will not guess. Tell us you are interested on the contact page and we will let you know when it is ready.' },
      { q: 'Can I message my Facebook friends or group members?', a: 'No, and it is not planned. Messenger for business is about the people who contact your Page.' },
      { q: 'Can I use Reachroute for Facebook today?', a: 'No. Today Reachroute sends WhatsApp messages and emails. Facebook Messenger is planned.' },
    ],
  },
};

export const CHANNEL_LIST = [CHANNELS.whatsapp, CHANNELS.email, CHANNELS.instagram, CHANNELS.facebook];

export const ABOUT = {
  lead: 'Reachroute exists so that a small business can reach the people who asked to hear from it, without paying for an enterprise platform or learning a complicated one.',
  principles: [
    { title: 'Permission comes first', text: 'We built Reachroute for messages people expect. Consent is confirmed on every campaign, unsubscribing is built in, and accounts that abuse the service are suspended.' },
    { title: 'Honest about the limits', text: 'WhatsApp can restrict numbers and email can land in spam. We tell you where the risks are and build in pacing and safeguards, instead of promising what no tool can.' },
    { title: 'Your accounts stay yours', text: 'You send from your own WhatsApp number and your own email account. Saved passwords are encrypted, and you can disconnect them any time.' },
    { title: 'Plain pricing', text: 'A real free plan, clear daily limits on every plan, and no per-message fees.' },
  ],
  roadmap: [
    { when: 'Today', what: 'Bulk WhatsApp messaging and bulk email, with scheduling, templates, lists, reports and opt-out handling.' },
    { when: 'Next', what: 'Instagram and Facebook Messenger, built on the rules Meta allows.' },
    { when: 'Always', what: 'Better protection for your sender reputation, and fewer steps to get a campaign out.' },
  ],
};
