import { readFileSync } from 'node:fs';
import PostalMime from 'postal-mime';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildPlainMime, type PlainMimeOptions } from '../bscraft-plain-mime';
import { JMAPClient, SendUnconfirmedError } from '../jmap/client';

const text = 'Привет!\n\nЭто одно контрольное письмо с корпоративной почты BSCraft. Проверяем доставку с адреса i.bezgin@bscraft.ru на этот ящик Gmail.\n\nС уважением,\nИван Безгин\nBSCraft\ni.bezgin@bscraft.ru\n';
const base: PlainMimeOptions = {
  from: { email: 'i.bezgin@bscraft.ru', name: 'Ivan Bezgin' },
  to: [{ email: 'control@example.com' }],
  subject: 'BSCraft: контрольное письмо — 24 октября',
  date: new Date('2026-10-23T19:23:34Z'),
  messageId: 'fixture@bscraft.ru',
  text,
};

describe('plain corporate MIME', () => {
  it('matches the successful Python email.policy.SMTP fixture byte for byte', () => {
    const fixture = JSON.parse(readFileSync(`${process.cwd()}/lib/__tests__/fixtures/bscraft-plain-smtp.json`, 'utf8')).mime;
    expect(buildPlainMime(base)).toBe(fixture);
  });

  it.each(['\n', '\r\n', '\r'])('normalizes %j inside the decoded body, including its final newline', async newline => {
    const mime = buildPlainMime({ ...base, text: ['one', 'два', '', 'three'].join(newline) });
    const payload = mime.split('\r\n\r\n')[1];
    expect(Buffer.from(payload.replace(/\s/g, ''), 'base64').toString()).toBe('one\r\nдва\r\n\r\nthree\r\n');
    expect(mime).not.toMatch(/(?<!\r)\n/);
    expect(payload.split('\r\n').every(line => line.length <= 76)).toBe(true);
  });

  it('round-trips long Unicode headers, quoted names, threading and receipts', async () => {
    const subject = 'Рабочий проект 🚀 '.repeat(30).trim();
    const name = 'Иван Безгин '.repeat(8).trim();
    const mime = buildPlainMime({ ...base, subject, from: { ...base.from, name },
      to: [{ email: 'person@example.com', name: 'Doe, Jane' }],
      cc: [{ email: 'other@example.com', name: 'Алексей' }],
      replyTo: [{ email: 'reply@example.com' }],
      inReplyTo: ['<parent@example.com>'], references: ['root@example.com', 'parent@example.com'],
      requestReadReceipt: true,
    });
    // Use this realm's ArrayBuffer (jsdom and Node have separate constructors).
    const parsed = await PostalMime.parse(Uint8Array.from(mime, char => char.charCodeAt(0)).buffer);
    expect(parsed.subject).toBe(subject);
    expect(parsed.from?.name).toBe(name);
    expect(parsed.to?.[0].name).toBe('Doe, Jane');
    expect(parsed.cc?.[0].name).toBe('Алексей');
    expect(parsed.replyTo?.[0].address).toBe('reply@example.com');
    expect(mime).toContain('In-Reply-To: <parent@example.com>');
    expect(mime).toContain('References: <root@example.com> <parent@example.com>');
    expect(mime).toContain('Disposition-Notification-To: i.bezgin@bscraft.ru');
    expect(mime.split('\r\n').every(line => line.length <= 78)).toBe(true);
    expect([...mime.matchAll(/=\?utf-8\?b\?.*?\?=/g)].every(match => match[0].length <= 75)).toBe(true);
  });

  it.each([
    { subject: 'Hi\r\nBcc: attacker@example.com' },
    { from: { email: 'me@bscraft.ru\nBcc: bad@other.com' } },
    { from: { email: 'me@bscraft.ru', name: 'Name\r\nBcc: bad@other.com' } },
    { references: ['id@other.com\r\nBcc: bad@other.com'] },
  ])('rejects header injection: %j', override => {
    expect(() => buildPlainMime({ ...base, ...override })).toThrow();
  });
});

type Call = [string, Record<string, unknown>, string];
function flow({ submissionFails = false, importFails = false, missingSubmission = false, shared = false } = {}) {
  const client = new JMAPClient('https://mail.bscraft.ru', 'i.bezgin@bscraft.ru', 'unused');
  Object.assign(client, { accountId: 'me', accounts: shared ? { shared: { name: 'i.bezgin@bscraft.ru' } } : {} });
  const uploaded = vi.spyOn(client, 'uploadBlob').mockResolvedValue({ blobId: 'uploaded', size: 779, type: 'message/rfc822' });
  const calls: Call[] = [];
  vi.spyOn(client as unknown as { request: (calls: Call[]) => Promise<unknown> }, 'request').mockImplementation(async batch => {
    const methodResponses: unknown[] = [];
    for (const [method, args, id] of batch) {
      calls.push([method, args, id]);
      if (method === 'Mailbox/get') methodResponses.push([method, { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, id]);
      if (method === 'Identity/get') methodResponses.push([method, { list: [{ id: 'identity', email: 'i.bezgin@bscraft.ru' }] }, id]);
      if (method === 'Email/import') {
        const key = Object.keys(args.emails as object)[0];
        methodResponses.push([method, importFails ? { notCreated: { [key]: { type: 'overQuota' } } } : { created: { [key]: { id: 'outgoing' } } }, id]);
      }
      if (method === 'EmailSubmission/set' && !missingSubmission) methodResponses.push([method, submissionFails
        ? { notCreated: { '1': { type: 'forbiddenFrom' } } } : { created: { '1': { id: 'submission' } } }, id]);
      if (method === 'EmailSubmission/get') methodResponses.push([method, { list: [] }, id]);
      if (method === 'Email/set' && args.create) methodResponses.push([method, { created: {
        [Object.keys(args.create as object)[0]]: { id: 'outgoing' },
      } }, id]);
      if (method === 'Email/set' && args.destroy) methodResponses.push([method, { destroyed: args.destroy }, id]);
    }
    return { methodResponses };
  });
  return { client, calls, uploaded };
}
async function fileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(file);
  });
}
function send(client: JMAPClient) {
  return client.sendEmail(['to@example.com'], base.subject, text, ['cc@example.com'], ['hidden@example.com'],
    'identity', base.from.email, 'old-draft', base.from.name);
}
afterEach(() => vi.restoreAllMocks());

describe('JMAP plain MIME submission', () => {
  it('keeps Bcc in the envelope only, files Sent after submission and then replaces the old draft', async () => {
    const { client, calls, uploaded } = flow();
    const result = await send(client);
    const raw = await fileText(uploaded.mock.calls[0][0]);
    expect(raw).not.toContain('hidden@example.com');
    expect(raw).not.toMatch(/^Bcc:/m);
    const submit = calls.find(([name]) => name === 'EmailSubmission/set')![1];
    expect(submit.create).toEqual({ '1': { emailId: expect.stringMatching(/^#send-/), identityId: 'identity', envelope: {
      mailFrom: { email: base.from.email }, rcptTo: [{ email: 'to@example.com' }, { email: 'cc@example.com' }, { email: 'hidden@example.com' }],
    } } });
    expect(submit.onSuccessUpdateEmail).toEqual({ '#1': { mailboxIds: { sent: true }, 'keywords/$draft': null } });
    expect(calls.at(-1)).toEqual(['Email/set', { accountId: 'me', destroy: ['old-draft'] }, '0']);
    expect(result.emailId).toBe('outgoing');
    expect(result.isSmime).toBeUndefined();
  });

  it.each([{ submissionFails: true }, { importFails: true }, { missingSubmission: true }])('retains the original draft on failure: %j', async options => {
    const { client, calls } = flow(options);
    await expect(send(client)).rejects.toThrow(options.missingSubmission ? SendUnconfirmedError : Error);
    expect(calls.filter(([name]) => name === 'Email/set').some(([, args]) => (args.destroy as string[]).includes('old-draft'))).toBe(false);
    if (options.submissionFails) expect(calls.at(-1)?.[1].destroy).toEqual(['outgoing']);
  });

  it('scopes upload, import and submission to the selected shared account', async () => {
    const { client, calls, uploaded } = flow({ shared: true });
    await send(client);
    expect(uploaded.mock.calls[0][1]).toBe('shared');
    expect(calls.find(([name]) => name === 'Email/import')![1].accountId).toBe('shared');
    expect(calls.find(([name]) => name === 'EmailSubmission/set')![1].accountId).toBe('shared');
  });

  it.each([
    { html: '<p>Rich text</p>', attachments: undefined, recipient: 'to@example.com' },
    { html: undefined, attachments: [{ blobId: 'file', name: 'file.pdf', type: 'application/pdf', size: 10 }], recipient: 'to@example.com' },
    { html: undefined, attachments: undefined, recipient: 'пользователь@example.com' },
  ])('retains the existing creation path for unsupported MIME: %j', async ({ html, attachments, recipient }) => {
    const { client, calls, uploaded } = flow();
    await client.sendEmail([recipient], 'Subject', 'body', undefined, undefined, 'identity', base.from.email,
      undefined, base.from.name, html, attachments);
    expect(uploaded).not.toHaveBeenCalled();
    expect(calls.some(([name]) => name === 'Email/import')).toBe(false);
    const created = Object.values(calls.find(([name]) => name === 'Email/set')![1].create as Record<string, Record<string, unknown>>)[0];
    if (attachments) expect(created.attachments).toEqual([{ blobId: 'file', name: 'file.pdf', type: 'application/pdf', disposition: 'attachment' }]);
    if (html) expect(created.bodyValues).toEqual({ text: { value: 'body' }, html: { value: html } });
  });

  it('preserves delivery/read receipts and required TLS in the explicit envelope', async () => {
    const { client, calls, uploaded } = flow();
    await client.sendEmail(['to@example.com'], 'Subject', 'body', undefined, undefined, 'identity', base.from.email,
      undefined, base.from.name, undefined, undefined, undefined, undefined, undefined, undefined,
      { requestDsn: true, requireTls: true, requestReadReceipt: true });
    const submit = calls.find(([name]) => name === 'EmailSubmission/set')![1].create as Record<string, { envelope: unknown }>;
    expect(submit['1'].envelope).toEqual({ mailFrom: { email: base.from.email, parameters: { RET: 'HDRS', REQUIRETLS: null } },
      rcptTo: [{ email: 'to@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } }],
    });
    expect(await fileText(uploaded.mock.calls[0][0])).toContain('Disposition-Notification-To: i.bezgin@bscraft.ru');
  });
});
