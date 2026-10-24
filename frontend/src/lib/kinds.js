// The two features share the same campaign screens; this file holds what differs between them.
export const KINDS = {
  whatsapp: {
    label: 'WhatsApp',
    base: '/whatsapp',
    api: '/api/whatsapp/campaigns',
    contactKey: 'phone',
    contactLabel: 'Phone',
    columnsHint: 'name, phone',
    maxHint: 'Up to 100 contacts per upload',
  },
  email: {
    label: 'Email',
    base: '/email',
    api: '/api/email/campaigns',
    contactKey: 'email',
    contactLabel: 'Email',
    columnsHint: 'name, email',
    maxHint: 'Up to 500 contacts per upload',
  },
};

export const fmtSize = (bytes) => {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

export const fmtDate = (value) => (value ? new Date(value).toLocaleString() : '');
