/**
 * Turn a text and an optional file into the message(s) WhatsApp should get.
 *   picture, video, document: one message, the text is the caption
 *   sound: WhatsApp has no caption for sound, so the text follows as its own message
 * A caption can hold 1024 characters; a longer text goes as its own message after the file.
 */
export const CAPTION_MAX = 1024;

export function buildContents(text, media) {
  if (!media) return [{ text }];
  const { buffer, mime, name, kind } = media;
  const fits = Boolean(text) && text.length <= CAPTION_MAX;
  const caption = fits ? { caption: text } : {};
  let file;
  if (kind === 'image') file = { image: buffer, mimetype: mime, ...caption };
  else if (kind === 'video') file = { video: buffer, mimetype: mime, ...caption };
  else if (kind === 'audio') file = { audio: buffer, mimetype: mime, ptt: false };
  else file = { document: buffer, mimetype: mime, fileName: name, ...caption };
  const needsText = Boolean(text) && !('caption' in file);
  return needsText ? [file, { text }] : [file];
}
