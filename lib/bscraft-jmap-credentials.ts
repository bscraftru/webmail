/** The owned Stalwart routes authenticate through Authorization, not webmail cookies. */
export function bscraftJmapCredentials(url: string, original?: RequestCredentials): RequestCredentials | undefined {
  try {
    const target = new URL(url);
    if (target.origin === 'https://mail.bscraft.ru' &&
        (/^\/jmap(?:\/|$)/.test(target.pathname) || target.pathname === '/.well-known/jmap')) {
      return 'omit';
    }
  } catch { /* Relative/mock endpoints keep the normal credential policy. */ }
  return original;
}
