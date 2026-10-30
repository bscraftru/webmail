import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { bscraftJmapCredentials } from '../bscraft-jmap-credentials';

afterEach(() => vi.restoreAllMocks());

describe('owned JMAP credential policy', () => {
  it.each([
    'https://mail.bscraft.ru/.well-known/jmap',
    'https://mail.bscraft.ru/jmap/session',
    'https://mail.bscraft.ru/jmap/',
    'https://mail.bscraft.ru/jmap/eventsource/?types=Email',
    'https://mail.bscraft.ru/jmap/download/account/blob/name',
    'https://mail.bscraft.ru:443/jmap/upload/account/',
  ])('omits webmail cookies on %s', url => {
    expect(bscraftJmapCredentials(url)).toBe('omit');
    expect(bscraftJmapCredentials(url, 'include')).toBe('omit');
  });

  it.each([
    'https://mail.example.com/jmap/',
    'https://mail.bscraft.ru.evil.test/jmap/',
    'https://mail.bscraft.ru:8443/jmap/',
    'http://mail.bscraft.ru/jmap/',
    'https://mail.bscraft.ru/api/auth/token',
    'https://mail.bscraft.ru/jmap-other',
    '/api/dev-jmap',
  ])('preserves credential policies outside the direct owned protocol routes: %s', url => {
    expect(bscraftJmapCredentials(url)).toBeUndefined();
    expect(bscraftJmapCredentials(url, 'include')).toBe('include');
  });

  it.each(['https://mail.bscraft.ru', 'https://mail.example.com'])('retains bearer authentication during real client discovery and reads on %s', async origin => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('/.well-known/jmap')) return new Response(JSON.stringify({
        apiUrl: `${origin}/jmap/`, accounts: { a: { name: 'a' } },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
        capabilities: {}, downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}`,
      }));
      return new Response(JSON.stringify({ methodResponses: [['Mailbox/get', { list: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }] }, '0']] }));
    });
    const client = JMAPClient.withBearer(origin, 'synthetic-token', 'synthetic@example.test');
    try {
      await client.connect();
      expect(await client.getMailboxes()).toMatchObject([{ id: 'inbox' }]);
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [, init] of fetch.mock.calls) {
        expect(init?.credentials).toBe(origin === 'https://mail.bscraft.ru' ? 'omit' : undefined);
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
      }
    } finally {
      client.disconnect();
    }
  });
});
