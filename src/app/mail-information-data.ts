import {createDocumentSource} from './document-data.ts';
import {gmailMessageLink, type MailPreview} from './gmail-data.ts';
import type {DocumentSource} from './models.ts';

/** Only source metadata: no body, attachments or session credentials. */
export function mailInformationSource(mail: MailPreview, email: string, accountId: string): DocumentSource {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(mail.id) || !accountId.trim() || accountId.length > 300 || typeof mail.subject !== 'string' || typeof mail.from !== 'string') throw new Error('郵件來源資訊不完整，請重新選擇。');
  return createDocumentSource({provider: 'gmail', sourceScope: accountId, fileId: mail.id, name: mail.subject.trim().slice(0, 300) || '（無主旨）', url: gmailMessageLink(mail, email), ...(mail.from.trim() ? {location: mail.from.trim().slice(0, 1500)} : {}), mimeType: 'message/rfc822'});
}
