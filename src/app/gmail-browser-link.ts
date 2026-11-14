/** Adapt external Gmail searches when opening them, without changing saved URLs or reading mail. */
export function gmailBrowserLink(value: string, userAgent = globalThis.navigator?.userAgent ?? ''): string {
  // Gmail tablets and browsers requesting the desktop site keep the existing desktop link.
  if (!/\bAndroid\b.*\bMobile\b|\biPhone\b|\biPod\b/i.test(userAgent)) return value;
  try {
    const link = new URL(value);
    const chooser = link.origin === 'https://accounts.google.com' && link.pathname === '/AccountChooser' && !link.username && !link.password;
    const target = chooser ? new URL(link.searchParams.get('continue') ?? '') : link;
    if (target.protocol !== 'https:' || target.hostname !== 'mail.google.com' || target.username || target.password || target.port || !target.pathname.startsWith('/mail/')) return value;
    const search = /^#search\/(.+)$/.exec(target.hash);
    if (!search) return value;
    // The mobile web client uses its own route. Let Gmail resolve the current build path.
    target.pathname = '/mail/mu/mp/'; target.hash = 'tl/search/' + search[1];
    if (!chooser) return target.href;
    link.searchParams.set('continue', target.href);
    return link.href;
  } catch {return value;}
}
