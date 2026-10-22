import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { canonicalCalendarInvitation, canonicalEmail, canonicalIdentities, canonicalMailCalls, canonicalMailResponse, canonicalMailText, canonicalSearchSnippet, withLegacyMailSearch } from '../bscraft-mail-addresses';
import { getInvitationTrustAssessment } from '../calendar-invitation';

describe('corporate mail address presentation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the projection at the real JMAP client boundary', async () => {
    const original = { id: 'old-message', blobId: 'unchanged', from: [{ email: 'inbox@bslabs.tech' }], bodyValues: { text: { value: 'i.bezgin@bslabs.tech' } } };
    const client = new JMAPClient('https://mail.example.com', 'test', 'test');
    Object.assign(client, { apiUrl: 'https://mail.example.com/jmap', accountId: 'account-1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [['Email/get', { list: [original] }, '0']],
    }), { status: 200 }));
    const email = await client.getEmail('old-message');
    expect(email?.from?.[0].email).toBe('inbox@bscraft.ru');
    expect(email?.bodyValues?.text.value).toBe('i.bezgin@bscraft.ru');
    expect(email?.blobId).toBe('unchanged');
    expect(original.from[0].email).toBe('inbox@bslabs.tech');
  });

  it('updates only the exact owned domain including case variants', () => {
    expect(canonicalMailText('i.bezgin@BSLABS.TECH and a.selivanov@bslabs.tech')).toBe('i.bezgin@bscraft.ru and a.selivanov@bscraft.ru');
    for (const value of ['x@bslabs.tech.evil', 'x@bslabs.tech-extra', 'x@other.tech', 'https://bslabs.tech']) {
      expect(canonicalMailText(value)).toBe(value);
    }
  });

  it('canonicalizes addresses split by server search highlights without interpreting markup', () => {
    expect(canonicalSearchSnippet('<mark>inbox</mark><mark>@</mark><mark>bslabs</mark><mark>.</mark><mark>tech</mark> accepted'))
      .toBe('inbox@bscraft.ru accepted');
    expect(canonicalSearchSnippet('inbox@<mark>bslabs</mark>.<mark>tech</mark> &lt;script&gt;'))
      .toBe('inbox@bscraft.ru &lt;script&gt;');
    expect(canonicalSearchSnippet('x@<mark>bslabs.tech.evil</mark>')).toBe('x@<mark>bslabs.tech.evil</mark>');
    expect(canonicalSearchSnippet('<mark>ordinary</mark> search')).toBe('<mark>ordinary</mark> search');
  });

  it('projects parsed invitation addresses with stable IDs and unchanged authentication results', async () => {
    const original = { uid: 'original@bslabs.tech', organizerCalendarAddress: 'mailto:i.bezgin@bslabs.tech',
      participants: { organizer: { email: 'i.bezgin@bslabs.tech', roles: { owner: true }, sendTo: { imip: 'mailto:i.bezgin@bslabs.tech' } } } };
    const client = new JMAPClient('https://mail.example.com', 'test', 'test');
    Object.assign(client, { apiUrl: 'https://mail.example.com/jmap', accountId: 'account-1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [['CalendarEvent/parse', { parsed: { originalBlob: [original] } }, '0']],
    }), { status: 200 }));
    const [event] = await client.parseCalendarEvents('account-1', 'originalBlob');
    expect(event.uid).toBe(original.uid);
    expect(Object.keys(event.participants!)).toEqual(['organizer']);
    expect(event.organizerCalendarAddress).toBe('mailto:i.bezgin@bscraft.ru');
    expect(event.participants!.organizer.email).toBe('i.bezgin@bscraft.ru');
    expect(event.participants!.organizer.sendTo!.imip).toBe('mailto:i.bezgin@bscraft.ru');
    expect(original.participants.organizer.email).toBe('i.bezgin@bslabs.tech');
    const failed = { from: [{ email: 'i.bezgin@bscraft.ru' }], authenticationResults: { dmarc: { result: 'fail' as const } } };
    expect(getInvitationTrustAssessment(event, failed, 'request').reason).toBe('authentication_failed');
    expect(canonicalCalendarInvitation(event)).toEqual(event);
  });

  it('uses existing canonical sender IDs and preserves identities without a replacement', async () => {
    const old = { id: 'old', email: 'i.bezgin@bslabs.tech', name: 'Ivan' };
    const current = { id: 'current', email: 'i.bezgin@bscraft.ru', name: 'Ivan', textSignature: 'i.bezgin@bslabs.tech' };
    const other = { id: 'other', email: 'outside@example.net', name: 'External' };
    expect(canonicalIdentities([old, current, other])).toEqual([
      { ...current, textSignature: 'i.bezgin@bscraft.ru' }, other,
    ]);
    expect(canonicalIdentities([old])).toEqual([old]);
    const client = new JMAPClient('https://mail.example.com', 'test', 'test');
    Object.assign(client, { apiUrl: 'https://mail.example.com/jmap', accountId: 'account-1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [['Identity/get', { list: [old, current] }, '0']],
    }), { status: 200 }));
    expect((await client.getIdentities()).map(identity => [identity.id, identity.email]))
      .toEqual([['current', 'i.bezgin@bscraft.ru']]);
    expect(current.textSignature).toBe('i.bezgin@bslabs.tech');
  });

  it('projects all displayed headers and bodies while preserving original source identity', () => {
    const original = { id: 'message-1', blobId: 'original-mime', messageId: 'original@bslabs.tech',
      from: [{ name: 'Ivan', email: 'i.bezgin@bslabs.tech' }], to: [{ email: 'outside@example.net' }],
      cc: [{ email: 'inbox@bslabs.tech' }], bcc: [], replyTo: [{ email: 'website@bslabs.tech' }],
      subject: 'To inbox@bslabs.tech', preview: 'Reply to i.bezgin@bslabs.tech',
      bodyValues: { html: { value: '<a href="mailto:i.bezgin@bslabs.tech">i.bezgin@bslabs.tech</a>', isTruncated: false } },
      headers: [{ name: 'From', value: 'Ivan <i.bezgin@bslabs.tech>' }, { name: 'DKIM-Signature', value: 'd=bslabs.tech; signature-original' }],
      attachments: [{ blobId: 'original-attachment', name: 'original.eml' }],
    };
    const untouched = JSON.stringify(original);
    const shown = canonicalEmail(original);
    expect(shown.from[0].email).toBe('i.bezgin@bscraft.ru');
    expect(shown.to).toEqual(original.to);
    expect(shown.cc[0].email).toBe('inbox@bscraft.ru');
    expect(shown.replyTo[0].email).toBe('website@bscraft.ru');
    expect(shown.bodyValues.html.value).toContain('mailto:i.bezgin@bscraft.ru');
    expect(shown.headers[0].value).toContain('i.bezgin@bscraft.ru');
    expect(shown.headers[1]).toEqual(original.headers[1]);
    expect(shown.blobId).toBe(original.blobId);
    expect(shown.messageId).toBe(original.messageId);
    expect(shown.attachments).toBe(original.attachments);
    expect(JSON.stringify(original)).toBe(untouched);
    expect(canonicalEmail(shown)).toEqual(shown);
  });

  it('also normalizes a restored browser snapshot without clearing drafts or settings', () => {
    const cached = { id: 'cached', from: [{ email: 'inbox@bslabs.tech' }], headers: { From: ['inbox@bslabs.tech'], 'Message-ID': 'original@bslabs.tech' } };
    expect(canonicalEmail(cached).headers).toEqual({ From: ['inbox@bscraft.ru'], 'Message-ID': 'original@bslabs.tech' });
  });

  it('searches both domains and preserves exclusion semantics', () => {
    expect(withLegacyMailSearch({ operator: 'NOT', conditions: [{ to: 'i.bezgin@bscraft.ru' }] })).toEqual({
      operator: 'NOT', conditions: [{ operator: 'OR', conditions: [{ to: 'i.bezgin@bscraft.ru' }, { to: 'i.bezgin@bslabs.tech' }] }],
    });
    const filter = withLegacyMailSearch({ inMailbox: 'inbox', from: 'i.bezgin@bscraft.ru', to: 'inbox@bscraft.ru' });
    expect(filter.operator).toBe('AND');
    expect(filter.conditions).toHaveLength(3);
    expect(withLegacyMailSearch({ text: 'normal search' })).toEqual({ text: 'normal search' });
  });

  it('never rewrites send/update requests or attachment downloads', () => {
    const calls: Array<[string, Record<string, unknown>, string]> = [['Email/set', { create: { draft: { from: [{ email: 'i.bezgin@bslabs.tech' }] } } }, 'send']];
    expect(canonicalMailCalls(calls)).toEqual(calls);
    expect(canonicalMailCalls([['Email/query', { filter: { text: 'i.bezgin@bscraft.ru' } }, 'search']])[0][1].filter).toHaveProperty('operator', 'OR');
  });

  it('keeps non-mail JMAP responses and server state unchanged', () => {
    const response = { sessionState: 'original', methodResponses: [
      ['Email/get', { state: 'original-email-state', list: [{ id: '1', from: [{ email: 'inbox@bslabs.tech' }] }] }, 'mail'],
      ['Identity/get', { list: [{ email: 'inbox@bslabs.tech' }] }, 'identity'],
    ] as Array<[string, Record<string, unknown>, string]> };
    const shown = canonicalMailResponse(response);
    expect(shown.sessionState).toBe('original');
    expect(shown.methodResponses[0][1].state).toBe('original-email-state');
    expect(shown.methodResponses[1]).toEqual(response.methodResponses[1]);
    expect(response.methodResponses[0][1].list).toEqual([{ id: '1', from: [{ email: 'inbox@bslabs.tech' }] }]);
  });
});
