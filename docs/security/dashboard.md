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
  token, against a constant-time compare with no attempt limit in front of
  it (residual 2 below).
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
- Every refused sign-in is a `warn` line carrying its decision, and it
  reaches the Logs page as well as stdout: a run of attempts is visible
  rather than merely rate-limited, and it cannot push the authenticated
  record off that page (the ring split below).
- The address and country shown for a device are the peer's, unless an edge
  is configured; forwarded headers from an untrusted peer are ignored.

## 5. Trust boundaries

1. **The TLS terminator** sees session cookies and sign-in links in clear.
   It is in the trust base for credentials and out of it for content
   (`../threat-model.md`, residual 1). `Secure` cookies do not change that;
   what they stop is a plaintext hop reaching the browser at all.
2. **The browser** must treat the origin as secure, and the browsers do not
   agree on what that means over plain HTTP:

   | Address | Chrome, Firefox | Safari (WebKit) |
   | --- | --- | --- |
   | `https://…` | works | works |
   | `http://localhost`, `http://127.0.0.1` | works (loopback is trustworthy) | **does not**: WebKit sends no `Secure` cookie to a plaintext origin (`httpwg/http-extensions#2605`, `mdn/content#41366`) |
   | `http://<any other IP or LAN name>` | does not | does not |

   Where it does not work, the browser discards the `__Host-` cookies without
   telling anyone: sign-in appears to succeed and every page load afterwards
   is signed out. Nothing reaches the server to refuse, which is why there is
   no error to read. Put a terminator in front and use its name.
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
- **There is no attempt limit on `GET /login`, deliberately.** A limit keyed
  by request source is a lockout switch wherever that source is a proxy this
  deployment does not trust: with `OBSYNC_EDGE=none` and no
  `OBSYNC_TRUSTED_PROXY_CIDRS` — the shipped chart's default, and what any
  deployment behind its own ingress runs — every visitor shares one bucket,
  so a stranger's wrong tokens would answer the owner's own one-time link
  with a refusal, renewably. The token is 256 bits compared in constant time,
  so a limit buys nothing against guessing; the noise it would bound is
  already bounded by the ring split below. Refusals are logged instead.
- **A revoked device's requests still count as credentialed** until it stops
  making them: `403 device_revoked` is answered only after a valid signature,
  so those responses carry `X-Obsync-Seq` and those lines sit in the
  credentialed ring. That is deliberate — the device held the vault key
  minutes ago, and the alternative is losing the very lines that show a
  revoked device still trying.
- **`GET /readyz` still states the journal head in its BODY.** The header was
  taken off unauthenticated responses; the `seq` field of
  `{"ready":true,"seq":<n>}` is pinned by `../protocol.md` and read by the
  image and compose smokes, so the write-activity oracle is narrowed here and
  not closed. Whether readiness should state a sequence at all is a separate
  decision.
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
