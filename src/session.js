// Who the visitor is, in a signed cookie. A stand-in for accounts: the demo lets anyone pick.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'tailgate_who';

export function sessions({ secret, people }) {
  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');

  function read(cookieHeader = '') {
    const raw = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [id, mac] = decodeURIComponent(raw).split('.');
    if (!id || !mac) return null;
    const expected = Buffer.from(sign(id));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return people[id] ?? null;
  }

  return {
    read,
    fromRequest: (request) => read(request.headers.get('cookie') ?? ''),
    cookie: (id) => `${COOKIE}=${encodeURIComponent(`${id}.${sign(id)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  };
}
