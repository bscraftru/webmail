/** Presentation of the owned domain migration; stored MIME, IDs and blobs stay original. */
const LEGACY_EMAIL_DOMAIN = /@bslabs\.tech(?=$|[^a-z0-9.-])/gi;
const CANONICAL_EMAIL_DOMAIN = /@bscraft\.ru(?=$|[^a-z0-9.-])/gi;
const ADDRESS_FIELDS = ['from', 'to', 'cc', 'bcc', 'replyTo', 'sender'];
const ADDRESS_HEADERS = /^(?:from|sender|to|cc|bcc|reply-to|resent-from|resent-to|resent-cc|resent-bcc)$/i;

type RecordValue = Record<string, unknown>;
type MethodCall = [string, RecordValue, string];
type Response = { methodResponses: Array<[string, RecordValue, string]> };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalMailText(value: string): string {
  return value.replace(LEGACY_EMAIL_DOMAIN, '@bscraft.ru');
}

/** Server highlight markers may split an address into several text segments. */
export function canonicalSearchSnippet(value: string): string {
  const plain = value.replace(/<\/?mark>/g, '');
  const canonical = canonicalMailText(plain);
  return canonical === plain ? value : canonical;
}

/** Canonical mail invitation presentation; source ICS and participant IDs stay original. */
export function canonicalCalendarInvitation<T>(value: T): T {
  if (!isRecord(value)) return value;
  const event: RecordValue = { ...value };
  for (const field of ['title', 'description', 'organizerCalendarAddress']) {
    if (typeof event[field] === 'string') event[field] = canonicalMailText(event[field]);
  }
  const addresses = (map: RecordValue) => Object.fromEntries(Object.entries(map).map(([key, address]) =>
    [key, typeof address === 'string' ? canonicalMailText(address) : address]));
  if (isRecord(event.replyTo)) event.replyTo = addresses(event.replyTo);
  if (isRecord(event.participants)) {
    event.participants = Object.fromEntries(Object.entries(event.participants).map(([id, participant]) => {
      if (!isRecord(participant)) return [id, participant];
      const shown = { ...participant };
      for (const field of ['name', 'email', 'calendarAddress']) {
        if (typeof shown[field] === 'string') shown[field] = canonicalMailText(shown[field]);
      }
      if (isRecord(shown.sendTo)) shown.sendTo = addresses(shown.sendTo);
      return [id, shown];
    }));
  }
  return event as T;
}

/** Prefer the server's existing canonical identities, keeping their real IDs. */
export function canonicalIdentities(values: unknown[]): unknown[] {
  const emails = new Set(values.flatMap(value => isRecord(value) && typeof value.email === 'string'
    ? [value.email.toLowerCase()] : []));
  return values.filter(value => {
    if (!isRecord(value) || typeof value.email !== 'string') return true;
    const canonical = canonicalMailText(value.email);
    return canonical === value.email || !emails.has(canonical.toLowerCase());
  }).map(value => {
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, text]) => [key,
      ['name', 'textSignature', 'htmlSignature'].includes(key) && typeof text === 'string'
        ? canonicalMailText(text) : text,
    ]));
  });
}

export function canonicalEmail<T>(value: T): T {
  if (!isRecord(value)) return value;
  const email: RecordValue = { ...value };
  for (const field of ADDRESS_FIELDS) {
    if (!Array.isArray(email[field])) continue;
    email[field] = email[field].map((address: unknown) => isRecord(address) ? {
      ...address,
      ...(typeof address.email === 'string' ? { email: canonicalMailText(address.email) } : {}),
      ...(typeof address.name === 'string' ? { name: canonicalMailText(address.name) } : {}),
    } : address);
  }
  for (const field of ['subject', 'preview']) {
    if (typeof email[field] === 'string') email[field] = canonicalMailText(email[field]);
  }
  if (isRecord(email.bodyValues)) {
    email.bodyValues = Object.fromEntries(Object.entries(email.bodyValues).map(([id, body]) => [id,
      isRecord(body) && typeof body.value === 'string' ? { ...body, value: canonicalMailText(body.value) } : body,
    ]));
  }
  if (Array.isArray(email.headers)) {
    email.headers = email.headers.map((header: unknown) =>
      isRecord(header) && typeof header.name === 'string' && ADDRESS_HEADERS.test(header.name) && typeof header.value === 'string'
        ? { ...header, value: canonicalMailText(header.value) } : header);
  } else if (isRecord(email.headers)) {
    email.headers = Object.fromEntries(Object.entries(email.headers).map(([name, header]) => [name,
      ADDRESS_HEADERS.test(name) ? (Array.isArray(header)
        ? header.map(value => typeof value === 'string' ? canonicalMailText(value) : value)
        : typeof header === 'string' ? canonicalMailText(header) : header) : header,
    ]));
  }
  return email as T;
}

/** Expand each address condition, so AND/NOT filters also retain their meaning. */
export function withLegacyMailSearch(filter: RecordValue): RecordValue {
  if (Array.isArray(filter.conditions)) {
    return { ...filter, conditions: filter.conditions.map(condition => isRecord(condition) ? withLegacyMailSearch(condition) : condition) };
  }
  let changed = false;
  const conditions = Object.entries(filter).map(([key, value]) => {
    let legacy: unknown = value;
    if (['text', 'from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key) && typeof value === 'string') {
      legacy = value.replace(CANONICAL_EMAIL_DOMAIN, '@bslabs.tech');
    } else if (key === 'header' && Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') {
      const text = value[1].replace(CANONICAL_EMAIL_DOMAIN, '@bslabs.tech');
      if (text !== value[1]) legacy = [value[0], text];
    }
    if (legacy === value) return { [key]: value };
    changed = true;
    return { operator: 'OR', conditions: [{ [key]: value }, { [key]: legacy }] };
  });
  if (!changed) return filter;
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

export function canonicalMailCalls(calls: MethodCall[]): MethodCall[] {
  return calls.map(([name, args, id]) =>
    (name === 'Email/query' || name === 'SearchSnippet/get') && isRecord(args.filter)
      ? [name, { ...args, filter: withLegacyMailSearch(args.filter) }, id] : [name, args, id]);
}

export function canonicalMailResponse<T extends Response>(response: T): T {
  if (!Array.isArray(response.methodResponses)) return response;
  return { ...response, methodResponses: response.methodResponses.map(([name, result, id]) => {
    if (!Array.isArray(result.list)) return [name, result, id];
    if (name === 'Identity/get') return [name, { ...result, list: canonicalIdentities(result.list) }, id];
    if (name === 'Email/get') return [name, { ...result, list: result.list.map(canonicalEmail) }, id];
    if (name === 'SearchSnippet/get') return [name, { ...result, list: result.list.map(snippet => {
      if (!isRecord(snippet)) return snippet;
      return { ...snippet,
        ...(typeof snippet.subject === 'string' ? { subject: canonicalSearchSnippet(snippet.subject) } : {}),
        ...(typeof snippet.preview === 'string' ? { preview: canonicalSearchSnippet(snippet.preview) } : {}),
      };
    }) }, id];
    return [name, result, id];
  }) } as T;
}
