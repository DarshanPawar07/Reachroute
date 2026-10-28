// The longer explanations on each channel page: why the channel matters, the process, and what Reachroute does at each step.
// WhatsApp and email describe what works today. Instagram and Facebook describe what is PLANNED and say so. Keep that true.

export const CHANNEL_EXTRA = {
  whatsapp: {
    whyTitle: 'Why bulk WhatsApp messaging matters',
    whyIntro:
      'For many businesses, WhatsApp is where customers already spend their day. A message there is often seen faster than an email waiting in a crowded inbox, and it feels like a message from a person.',
    why: [
      { title: 'Reach people where they already are', text: 'Most of your customers, students and members already use WhatsApp every day. You do not need them to install anything or sign up for anything.' },
      { title: 'Good for news that cannot wait', text: 'Fee reminders, timetable changes, delivery updates, event details and limited offers lose value when they are read a day late.' },
      { title: 'Doing it by hand does not scale', text: 'Pasting the same message into 200 chats takes hours and invites mistakes. WhatsApp’s own broadcast lists only reach people who saved your number first.' },
      { title: 'Doing it carelessly has a cost', text: 'WhatsApp restricts numbers that send too much, too fast, or to people who did not ask. How you send matters as much as what you send.' },
    ],
    processTitle: 'The process of sending bulk WhatsApp messages',
    processIntro: 'Whatever tool you use, a good campaign goes through the same steps. Here is what each step needs and what Reachroute does for you.',
    process: [
      {
        title: 'Get your list ready',
        need: 'Gather the numbers of people who agreed to hear from you, with country codes, and remove duplicates and numbers that are not on WhatsApp.',
        we: 'Upload a CSV, Excel or JSON file, or pick a saved list. Reachroute checks the numbers, removes duplicates and tells you which ones are invalid. Numbers that are not on WhatsApp are skipped when sending.',
      },
      {
        title: 'Connect your number',
        need: 'The messages must come from a number your customers recognise, which you control.',
        we: 'Scan a QR code from WhatsApp on your phone, the same way you link WhatsApp Web. Messages go out from your own number, and you can disconnect at any time.',
      },
      {
        title: 'Write the message once',
        need: 'A message that names the person and says something useful gets answered. One that looks copied gets ignored or reported.',
        we: 'Add each person’s name and any column from your file, such as {{city}}, and vary the wording with options like {Hi|Hello|Hey}. Attach an image, PDF or video if it helps.',
      },
      {
        title: 'Send at a pace WhatsApp accepts',
        need: 'Sending hundreds of messages in a minute is the fastest way to get a number restricted.',
        we: 'Messages go out one at a time with random pauses, within hourly and daily limits. A new number is held to a small daily amount for its first two weeks. You can start now or schedule it for the hours you choose.',
      },
      {
        title: 'Check that it arrived',
        need: '“Sent” only means WhatsApp accepted the message. What matters is whether the other phone received it.',
        we: 'Every person is marked Sent, Delivered or Read where WhatsApp confirms it. If messages stop reaching phones, the campaign pauses and tells you instead of carrying on.',
      },
      {
        title: 'Handle replies and fix what failed',
        need: 'People answer, some ask you to stop, and some messages fail.',
        we: 'Replies show up inside Reachroute, and anyone who replies STOP is never messaged again. Send again to the people who were not reached, or download the whole report as a spreadsheet.',
      },
    ],
    plansTitle: 'Plans for bulk WhatsApp messaging',
    planRows: [
      ['Messages included', 'included'],
      ['Messages a day', 'whatsappPerDay'],
      ['Messages an hour', 'whatsappPerHour'],
      ['Contacts per upload', 'whatsappUpload'],
      ['Campaigns running at once', 'activeCampaigns'],
      ['Saved contact lists', 'lists'],
    ],
  },

  email: {
    whyTitle: 'Why bulk email still matters',
    whyIntro:
      'Email is the channel people give to every business, and the one that can carry a full message, a link and an attachment. For updates people chose to receive, it is cheap, it is permanent, and it works on every device.',
    why: [
      { title: 'Room to say it properly', text: 'Prices, schedules, invoices and newsletters need more space than a chat message. Email holds the full text, links and files.' },
      { title: 'People expect it from businesses', text: 'Receipts, confirmations and updates arrive by email. A message from you there looks normal, not intrusive.' },
      { title: 'A mail merge by hand is slow and risky', text: 'Copying addresses into the Bcc field exposes mistakes and offers no report. A proper tool personalises each email and tells you who got it.' },
      { title: 'Rules and reputation apply', text: 'People must be able to unsubscribe, and providers judge you by bounces and complaints. Sending carelessly sends you to spam.' },
    ],
    processTitle: 'The process of sending bulk email',
    processIntro: 'The steps are the same on any tool. Here is what each one needs and what Reachroute does.',
    process: [
      {
        title: 'Collect addresses with permission',
        need: 'Email only people who agreed to hear from you. Remove addresses that are mistyped or repeated.',
        we: 'Upload a CSV or Excel file, or pick a saved list. Reachroute checks every address, removes duplicates and lists the ones that are invalid. You confirm consent for every campaign.',
      },
      {
        title: 'Connect a sending account',
        need: 'Emails should come from an address you own, or providers will treat them as forged.',
        we: 'Connect any provider that offers SMTP: Gmail, Outlook, Zoho, Brevo or Amazon SES. We email a code to the sending address to prove you own it, and your saved password is encrypted.',
      },
      {
        title: 'Write a subject and a body',
        need: 'A clear subject gets the email opened, and the person’s name makes it feel written for them.',
        we: 'Use {{name}} and any column from your file in the subject and the body, in plain text or basic HTML. Add up to five attachments. Compare two subject lines with an A/B test.',
      },
      {
        title: 'Test it on yourself',
        need: 'Mistakes in a bulk email go to everyone.',
        we: 'Send one test email to your own inbox. It looks exactly like the real one and does not use up your daily limit.',
      },
      {
        title: 'Send at a steady pace',
        need: 'Large bursts look like spam to email providers.',
        we: 'Emails go out one at a time within your daily limit. Start now, or schedule it and choose the hours and days it may send.',
      },
      {
        title: 'Read the report and clean your list',
        need: 'Bounces, unsubscribes and failures should shape your next campaign.',
        we: 'Every email carries an unsubscribe link we add for you. People who unsubscribe are never emailed again, addresses that bounce are stopped, and you can send again to the failures or download a CSV.',
      },
    ],
    plansTitle: 'Plans for bulk email',
    planRows: [
      ['Messages included', 'included'],
      ['Emails a day', 'emailPerDay'],
      ['Contacts per upload', 'emailUpload'],
      ['Campaigns running at once', 'activeCampaigns'],
      ['Saved contact lists', 'lists'],
      ['Saved message templates', 'templates'],
    ],
  },

  instagram: {
    whyTitle: 'Why Instagram messaging matters',
    whyIntro:
      'For many shops, creators and service businesses, Instagram is the first place a customer says hello: a direct message asking about a price, a size or a booking. Answering well and following up is where many sales are won or lost.',
    why: [
      { title: 'Customers start conversations there', text: 'People send questions in direct messages and reply to stories. Slow or forgotten replies cost enquiries.' },
      { title: 'Follow-up is hard by hand', text: 'Once the messages pile up, keeping track of who still needs an answer or an update turns into a full-time job.' },
      { title: 'Meta controls who a business can message', text: 'Instagram limits when a business may write first, and it restricts accounts that break the rules. Bulk messaging to strangers is not allowed, and tools that promise it put your account at risk.' },
    ],
    processTitle: 'How we plan Instagram messaging to work',
    processIntro: 'This channel is not built yet. This is the process we are aiming for, and it may change as we learn what Meta allows.',
    process: [
      { title: 'Connect your business account', need: 'Business accounts connect through Meta’s official login.', we: 'You would connect through Meta’s own sign-in. Reachroute would never ask for your Instagram password.' },
      { title: 'Choose who to message', need: 'Only people who have already messaged you, within the window Meta allows.', we: 'You would pick from people who recently contacted your account, using the same list tools you use for WhatsApp and email.' },
      { title: 'Write it once', need: 'The same message, with a personal touch.', we: 'Use the templates and name personalisation you already have.' },
      { title: 'Send inside the rules', need: 'Respect Meta’s time limits and rate limits.', we: 'Messages would go out at a safe pace, and anything outside what Meta allows would be blocked before it can put your account at risk.' },
      { title: 'See what happened', need: 'Know who got it and who answered.', we: 'Results would appear in the same report as your other campaigns.' },
    ],
    plansTitle: 'Plans for Instagram messaging',
    planRows: [],
  },

  facebook: {
    whyTitle: 'Why Facebook Messenger matters',
    whyIntro:
      'Many local businesses and service providers still get most of their enquiries through their Facebook Page. Messenger is where customers ask about timings, prices and orders, and where a quick, personal reply can win the job.',
    why: [
      { title: 'Enquiries arrive in Messenger', text: 'Customers write to your Page the way they would call a shop. Replying quickly and keeping track matters.' },
      { title: 'Updates for people who already know you', text: 'Appointment changes, order status and event details are useful to people who messaged your Page.' },
      { title: 'Meta sets the rules', text: 'Messenger limits when a Page may write first and what it may send. Tools that ignore those rules put your Page at risk, so we are building around them.' },
    ],
    processTitle: 'How we plan Facebook Messenger to work',
    processIntro: 'This channel is not built yet. This is the process we are aiming for, and it may change as we learn what Meta allows.',
    process: [
      { title: 'Connect your Page', need: 'A Facebook Page you manage.', we: 'You would connect through Meta’s own sign-in. Reachroute would never ask for your Facebook password.' },
      { title: 'Choose who to message', need: 'Only people who have already messaged your Page, within what Meta allows.', we: 'Pick from people who contacted your Page, using the same list tools you use for WhatsApp and email.' },
      { title: 'Write it once', need: 'A message that suits each person.', we: 'Use the templates and name personalisation you already have.' },
      { title: 'Send inside the rules', need: 'Respect Meta’s time limits and rate limits.', we: 'Messages would go out at a safe pace and anything outside the rules would be blocked before it can put your Page at risk.' },
      { title: 'See what happened', need: 'Know who got it and who answered.', we: 'Results would appear in the same report as your other campaigns.' },
    ],
    plansTitle: 'Plans for Facebook Messenger',
    planRows: [],
  },
};
