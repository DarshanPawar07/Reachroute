// The plans shown on the Home, Pricing and channel pages.
//
// These pages are built ahead of time, so they cannot ask the server. The numbers here are the STARTING plans from
// backend/src/plans/defaults.js. If you change a plan in Admin > Plans, change it here too (and rebuild the site).
// The Billing page inside the app (after login) always shows the live prices and limits.
//
// Free is a one-time allowance that never refills. Pro and Premium are paid every month or every year through Razorpay.
// Business is arranged by email.

export const CURRENCY = 'INR';

export const PLANS = [
  {
    key: 'free',
    name: 'Free',
    price: 0,
    priceLabel: '₹0',
    period: 'no time limit',
    yearlyLabel: null,
    blurb: 'Try Reachroute with real messages. The allowance is yours to keep, but it does not refill.',
    cta: { label: 'Start free', to: '/register' },
    limits: {
      included: '50 WhatsApp + 100 emails, once',
      whatsappPerDay: 'Within the 50 included',
      whatsappPerHour: '10',
      emailPerDay: 'Within the 100 included',
      whatsappUpload: '50 contacts',
      emailUpload: '50 contacts',
      activeCampaigns: '1',
      lists: '3 lists of up to 500 contacts',
      templates: '5',
      attachments: '5 MB on WhatsApp, 5 MB on email',
    },
    highlights: ['50 WhatsApp messages and 100 emails in total', 'Does not refill: choose a plan to keep sending', '1 campaign at a time', 'Every feature included'],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: 699,
    priceLabel: '₹699',
    period: 'a month',
    yearlyLabel: '₹6,990 a year (2 months free)',
    blurb: 'For a shop, a class or a freelancer who messages customers every week.',
    cta: { label: 'Choose Pro', to: '/billing?plan=pro' },
    limits: {
      included: '5,000 messages a month',
      whatsappPerDay: '200',
      whatsappPerHour: '40',
      emailPerDay: '400',
      whatsappUpload: '200 contacts',
      emailUpload: '500 contacts',
      activeCampaigns: '3',
      lists: '20 lists of up to 5,000 contacts',
      templates: '50',
      attachments: '16 MB on WhatsApp, 10 MB on email',
    },
    highlights: ['5,000 messages a month', '200 WhatsApp and 400 emails a day', '3 campaigns running at once', 'Cancel any time'],
  },
  {
    key: 'premium',
    name: 'Premium',
    price: 1499,
    priceLabel: '₹1,499',
    period: 'a month',
    yearlyLabel: '₹14,990 a year (2 months free)',
    blurb: 'For teams that run several campaigns a week across both channels.',
    cta: { label: 'Choose Premium', to: '/billing?plan=premium' },
    limits: {
      included: '20,000 messages a month',
      whatsappPerDay: '500',
      whatsappPerHour: '60',
      emailPerDay: '1,000',
      whatsappUpload: '500 contacts',
      emailUpload: '2,000 contacts',
      activeCampaigns: '10',
      lists: '100 lists of up to 20,000 contacts',
      templates: '200',
      attachments: '16 MB on WhatsApp, 20 MB on email',
    },
    highlights: ['20,000 messages a month', '500 WhatsApp and 1,000 emails a day', '10 campaigns running at once', 'Cancel any time'],
  },
  {
    key: 'business',
    name: 'Business',
    price: null,
    priceLabel: 'Custom',
    period: 'priced to your volume',
    yearlyLabel: null,
    blurb: 'Several numbers, higher volumes, or Instagram and Facebook when they arrive.',
    cta: { label: 'Talk to us', to: '/contact?topic=plans&plan=business' },
    limits: null,
    highlights: ['Limits set for your volume', 'Help with setup and sender reputation', 'First in line for Instagram and Facebook'],
  },
];

/** Rows of the comparison table on the Pricing page. */
export const COMPARE_ROWS = [
  { label: 'Messages included', key: 'included' },
  { label: 'WhatsApp messages per day', key: 'whatsappPerDay' },
  { label: 'WhatsApp messages per hour', key: 'whatsappPerHour' },
  { label: 'Emails per day', key: 'emailPerDay' },
  { label: 'Contacts per WhatsApp upload', key: 'whatsappUpload' },
  { label: 'Contacts per email upload', key: 'emailUpload' },
  { label: 'Campaigns running at once', key: 'activeCampaigns' },
  { label: 'Saved contact lists', key: 'lists' },
  { label: 'Saved message templates', key: 'templates' },
  { label: 'Attachment size', key: 'attachments' },
];

/** What every plan includes. */
export const INCLUDED_EVERYWHERE = [
  'Personalised messages with names and your own columns',
  'Scheduling and daily sending hours',
  'A/B tested email subject lines',
  'Reports for every campaign, downloadable as CSV',
  'Automatic unsubscribe link and STOP handling',
  'Contact lists with groups, search and templates',
  'Test email to yourself before you send',
  'Send again to the people who were not reached',
];
