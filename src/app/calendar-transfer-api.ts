import { GoogleHttpError, writableCalendar } from './google-api.ts';
import { readGoogleEvent } from './google-data.ts';
import type { GoogleEvent } from './google-data';
import type { EventBody } from './calendar-transfer-data';

export type CalendarMutationRequest = (path: string, parameters: Record<string, string>, options?: RequestInit) => Promise<unknown>;
export class CalendarPublishedChanged extends Error {
  readonly event: GoogleEvent;
  constructor(event: GoogleEvent) { super('Google 活動已存在且有修改，Orbit 任務與 Google 活動各自保留。請自行查看活動內容。'); this.event = event; }
}
export class CalendarTransferApi {
  private readonly request: CalendarMutationRequest;
  constructor(request: CalendarMutationRequest) { this.request = request; }
  async get(calendarId: string, eventId: string): Promise<GoogleEvent> {
    const event = readGoogleEvent(await this.request('calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId), {}));
    if (!event || event.id !== eventId || event.status === 'cancelled') throw new Error('Google 活動已刪除或內容不完整，Orbit 任務仍保留。');
    if (event.contentComplete === false) throw new Error('Google 活動內容過長，無法完整確認。原有資料保留，請縮短內容後重試。');
    return event;
  }
  async publish(calendarId: string, body: EventBody, current: () => void): Promise<GoogleEvent> {
    current();
    const calendar = await this.request('users/me/calendarList/' + encodeURIComponent(calendarId), {}) as {id?: string; accessRole?: string};
    current();
    if (calendar?.id !== calendarId || !writableCalendar(calendar)) throw new Error('這個月曆目前沒有寫入權限，請重新載入並選擇可寫入月曆。');
    // Always check the durable event identity first, including retries after a lost response.
    try { const existing = await this.get(calendarId, body.id); current(); return this.confirm(existing, body); }
    catch (error) { if (!(error instanceof GoogleHttpError) || error.status !== 404) throw error; }
    current();
    try {
      const content: EventBody = {id: body.id, summary: body.summary, description: body.description, start: body.start, end: body.end, transparency: 'transparent', extendedProperties: {private: {orbitTransfer: body.id, orbitFormat: '1'}}};
      await this.request('calendars/' + encodeURIComponent(calendarId) + '/events', {sendUpdates: 'none'}, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(content)});
    } catch (error) { if (!(error instanceof GoogleHttpError) || error.status !== 409) throw error; }
    current();
    // Read back the full event; a POST response alone cannot justify deleting the local card.
    const event = await this.get(calendarId, body.id); current(); return this.confirm(event, body);
  }
  private confirm(event: GoogleEvent, body: EventBody): GoogleEvent {
    const sameMoment = (a: GoogleEvent['start'], b: EventBody['start']) => b.date ? a?.date === b.date : !!a?.dateTime && Date.parse(a.dateTime) === Date.parse(b.dateTime!);
    if (event.orbitTransfer !== body.id) throw new Error('Google 活動的來源標記無法確認，Orbit 任務仍保留。請到 Google 查看，不會覆寫或另建一份。');
    if (event.summary !== body.summary || event.description !== body.description || event.transparency !== 'transparent' || !sameMoment(event.start, body.start) || !sameMoment(event.end, body.end)) throw new CalendarPublishedChanged(event);
    return event;
  }
}
