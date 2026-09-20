# The dashboard's threat model

Dated 2026-09-20. One page about one surface: what the dashboard is, what it
holds, how a browser gets in, what defends it, and what is deliberately left
standing. The whole-system view is [`../threat-model.md`](../threat-model.md);
the wire contract is [`../protocol.md`](../protocol.md).

## 1. What it is

A read-mostly operator view of one server, plus five mutations: revoke a
device, run garbage collection, run a scrub, sign out, and sign out
everywhere. It holds no vault key and never sees plaintext, so it cannot read
a note, approve a device, or recover a vault. Those all happen on a paired
device.

## 2. Assets

| Asset | Where it lives | What it is worth |
| --- | --- | --- |
| The session | this process's memory, and a cookie in one browser | the whole dashboard, for its lifetime |
| A login link | this process's memory, for five minutes | one session |
| The setup/recovery token | `v1/setup-token` on the journal volume, mode 0600 | a session, for the life of the server |
| The device inventory | the journal | names, platforms, last-seen times, addresses, countries |
| The decision log | this process's memory | what the server has been asked to do lately |

## 3. Entry points

- `POST /v1/dashboard/login-link` — any ACTIVE device, authenticated as
  usual, mints a single-use link that lives five minutes and remembers which
  device minted it.
- `GET /login?token=…` — spends that link, or accepts the standing recovery
  token. Five failed attempts per source per minute, then `429`.
- Everything else — the session cookie, plus a double-submit CSRF header on
  every mutation.

## 4. Controls, one line each

- 256-bit tokens from the system CSPRNG for links, sessions and CSRF values;
  a fresh session id on every sign-in, so no value a client supplies can
  become a session.
- Links are single-use and expire in five minutes; spending one is atomic.
- Cookies are `__Host-obsync_session` and `__Host-obsync_csrf`: `Secure`,
  `Path=/`, no `Domain`. The prefix is the browser's own enforcement of all
  three, which is why the name is part of the control.
- The session cookie is `HttpOnly`; the CSRF cookie is deliberately readable,
  because the double-submit check needs it in a header.
- Every mutation compares header to cookie to the value minted with THIS
  session, all three in constant time.
- Mutations are POST-only, no CORS header is ever emitted, and no preflight
  can succeed.
- A session ends after 12 hours whatever it does, after 1 hour of silence, on
  sign-out, on sign-out-everywhere, and when the device that minted its link
  is revoked.
- Every response carries `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer`; page responses add the strict CSP plus
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`.
- The page has no inline script, no style attribute and no remote asset, and
  `dashboard/test/html.test.mjs` fails the build if one appears; every value
  the server sends is rendered with `textContent`.
- `X-Obsync-Seq` states the journal head to callers that proved a credential
  and to nobody else.
- The address and country shown for a device are the peer's, unless an edge
  is configured; forwarded headers from an untrusted peer are ignored.

## 5. Trust boundaries

1. **The TLS terminator** sees session cookies and sign-in links in clear.
   It is in the trust base for credentials and out of it for content
   (`../threat-model.md`, residual 1). `Secure` cookies do not change that;
   what they stop is a plaintext hop reaching the browser at all.
2. **The browser** must treat the origin as secure, which means an HTTPS
   address or `localhost`. A dashboard served over plain HTTP by IP address
   or LAN name is not supported: the browser will not keep a `__Host-`
   cookie, so sign-in appears to succeed and every page load is signed out.
   Put a terminator in front, or reach it over `localhost`.
3. **Forwarded headers** are trusted only in `OBSYNC_EDGE=cloudflare`, where
   direct reachability of the origin must be impossible; in `none` mode they
   are ignored unless the peer is inside `OBSYNC_TRUSTED_PROXY_CIDRS`.
4. **The journal volume** carries the recovery token. Its custody equals the
   dashboard's.

## 6. Accepted residuals

- The recovery token stands for the life of the server and is not spent by
  use. A session opened with it is flagged on the Overview page, its use is
  logged at `warn`, and rotation is three steps in
  [`../recovery.md`](../recovery.md).
- The login limiter remembers at most 1024 sources. Once that many distinct
  sources have failed within a refill window, a new source is served without
  being remembered, and the server logs it. A limiter that refused instead
  would be a way for a botnet to lock an operator out of the recovery login,
  and the limiter is not what makes a 256-bit token hard to guess.
- The decision log is not an audit log. It is two bounded rings in memory —
  1000 lines from credentialed requests, 200 from everything else — so
  unauthenticated traffic can push out only other unauthenticated traffic.
  Both are shown. Ship stdout for an audit trail; every line in these rings
  was written there first.
- Revocation is final. There is no un-revoke route and no CLI recovery; the
  last ACTIVE device cannot be revoked from either route, because nothing
  re-enrols one.
- A session cannot be ended from another device — only from a dashboard
  session, or by a restart.

## 7. Rotation and break-glass

- **Rotate the recovery token:** stop the server, delete `v1/setup-token`
  from the journal volume, start it. A new 64-hex token is minted at mode
  0600 and the old one stops working. Devices are unaffected.
- **Revoking a device** drops its wrapped secret, refuses its next request,
  and now also drops the dashboard sessions its links opened and any link it
  minted that nobody has spent. It does not touch other devices, and it
  cannot be undone.
- **The last-device refusal** protects the account itself: `POST /v1/setup`
  answers `409 already_set_up` forever, and a pairing can only be opened by a
  paired device, so an account with no active device can never sync again.
- **Sign out everywhere** ends every session in the process at once, for the
  browser left behind on a machine the operator no longer controls.
