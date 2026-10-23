/** Raw MIME for plain-text submission; HTML and attachments use their existing path. */
export interface PlainMimeAddress {
  email: string;
  name?: string;
}

export interface PlainMimeOptions {
  from: PlainMimeAddress;
  to: PlainMimeAddress[];
  cc?: PlainMimeAddress[];
  replyTo?: PlainMimeAddress[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo?: string[];
  references?: string[];
  requestReadReceipt?: boolean;
}

function safeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid control character in mail header');
  return value;
}

function base64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RFC 2047 encoded-words, split on UTF-8 character and word boundaries. */
function textHeader(name: string, value: string): string {
  safeHeader(value);
  const lines: string[] = [];
  let line = `${name}: `;
  let rest = value;
  if (/[^\x20-\x7e]/.test(rest)) {
    const firstUnicode = rest.search(/[^\x20-\x7e]/);
    const prefixEnd = rest.lastIndexOf(' ', firstUnicode) + 1;
    const prefix = rest.slice(0, prefixEnd);
    if (line.length + prefix.length < 60) {
      line += prefix;
      rest = rest.slice(prefixEnd);
    }
    while (rest) {
      const available = Math.min(75, 78 - line.length);
      const maxBytes = Math.floor((available - 12) / 4) * 3;
      let bytes = 0;
      let end = 0;
      for (const char of rest) {
        const size = new TextEncoder().encode(char).length;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += char.length;
      }
      if (!end) {
        lines.push(line.trimEnd());
        line = ' ';
        continue;
      }
      if (end < rest.length) {
        const boundary = rest.lastIndexOf(' ', end);
        if (boundary > 0) end = boundary;
      }
      line += `=?utf-8?b?${base64(rest.slice(0, end))}?=`;
      rest = rest.slice(end);
      if (rest) { lines.push(line); line = ' '; }
    }
  } else {
    for (const token of rest.split(/( +)/)) {
      if (line.length + token.length > 78 && line.length > 1) {
        lines.push(line.trimEnd());
        line = ' ';
      }
      line += token;
    }
  }
  lines.push(line);
  if (lines.some(item => item.length > 998)) throw new Error('Mail header exceeds line limit');
  return lines.join('\r\n');
}

function address(value: PlainMimeAddress): string {
  const email = safeHeader(value.email);
  // eslint-disable-next-line no-control-regex
  if (!/^[^\s<>\x00-\x20\x7f-\uffff]+@[^\s<>\x00-\x20\x7f-\uffff]+$/.test(email)) {
    throw new Error('Invalid plain-text mail address');
  }
  if (!value.name) return email;
  const name = safeHeader(value.name);
  if (/[^\x20-\x7e]/.test(name)) {
    return `${textHeader('Name', name).slice(6).replace(/\r\n /g, ' ')} <${email}>`;
  }
  const rendered = /[()<>[\]:;@\\,."]/.test(name)
    ? `"${name.replace(/["\\]/g, '\\$&')}"`
    : name;
  return `${rendered} <${email}>`;
}

function idsHeader(name: string, ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  const values = ids.map(id => {
    const bare = safeHeader(id.replace(/^<|>$/g, ''));
    if (!/^[^\s<>]+@[^\s<>]+$/.test(bare)) throw new Error('Invalid mail message identifier');
    return `<${bare}>`;
  });
  return [textHeader(name, values.join(' '))];
}

export function buildPlainMime(options: PlainMimeOptions): string {
  const date = options.date.toUTCString().replace(/GMT$/, '+0000');
  if (date === 'Invalid Date') throw new Error('Invalid mail date');
  // Match SMTP text serialization: CRLF inside the decoded body, final newline,
  // UTF-8/base64 with 76-column transfer lines, and no empty Cc/Bcc headers.
  const body = options.text.replace(/\r\n|\r|\n/g, '\r\n');
  const normalized = body.endsWith('\r\n') ? body : body + '\r\n';
  const headers = [
    textHeader('From', address(options.from)),
    ...(options.to.length ? [textHeader('To', options.to.map(address).join(', '))] : []),
    ...(options.cc?.length ? [textHeader('Cc', options.cc.map(address).join(', '))] : []),
    textHeader('Subject', options.subject),
    `Date: ${date}`,
    ...idsHeader('Message-ID', [options.messageId]),
    ...(options.replyTo?.length ? [textHeader('Reply-To', options.replyTo.map(address).join(', '))] : []),
    ...idsHeader('In-Reply-To', options.inReplyTo),
    ...idsHeader('References', options.references),
    ...(options.requestReadReceipt ? [`Disposition-Notification-To: ${address({ email: options.from.email })}`] : []),
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    'MIME-Version: 1.0',
  ];
  // Bcc is deliberately absent from MIME; recipients belong in the envelope.
  const encoded = base64(normalized).match(/.{1,76}/g)?.join('\r\n') ?? '';
  return headers.join('\r\n') + '\r\n\r\n' + encoded + '\r\n';
}
