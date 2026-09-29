# The dashboard's threat model

*For people running an obsync server, and for reviewers.*

Dated 2026-09-20. One page about one surface: what the dashboard is, what it
holds, how a browser gets in, what defends it, and what is deliberately left
standing. The whole-system view is [`../threat-model.md`](../threat-model.md);
the wire contract is [`../protocol.md`](../protocol.md).

## 1. What it is

A read-mostly operator view of one server, plus six mutations: revoke a
device, forget a revoked one (which archives it, and destroys nothing), run
garbage collection, run a scrub, sign out, and sign out everywhere. It holds no vault key and never sees plaintext, so it cannot read
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
  is revoked. Sign-out-everywhere also drops every login link that has been
  minted and never spent: an unspent link is the same key to the same
  dashboard, and the button exists for a machine the operator no longer
  controls.
- The account's last ACTIVE device cannot be revoked, and the count and the
  revocation happen under ONE hold of the store's index lock. Checking first
  and writing afterwards let two devices revoking each other at the same
  moment both succeed, which leaves an account nothing can ever sync again:
  `POST /v1/setup` answers `409 already_set_up` forever and only a paired
  device can open a pairing.
- Every response carries `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer`; page responses add the strict CSP plus
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`.
- The page has no inline script, no style attribute and no remote asset, and
  `dashboard/test/html.test.mjs` fails the build if one appears; every value
  the server sends is rendered with `textContent`.
- `X-Obsync-Seq` states the journal head to callers that proved a credential
  and to nobody else, and no unauthenticated body states it either:
  `/readyz` answers `{"ready":true}`, where up to 1.1.3 its body carried the
  head to anyone who asked (issue #235). "Proved" is positive evidence: the server records
  the fact where a credential VERIFIES -- a device signature with its
  timestamp and nonce, a session cookie that matched a live session, a login
  token, a setup token -- and the response header and the log ring key off
  that record alone. Neither the route nor the status can produce it. The
  route table is kept as a CROSS-CHECK: a success on a route that demands a
  credential with nothing recorded is a server bug, logged at error and
  treated as unproved.
- Every route that demands a credential authenticates BEFORE it validates a
  path segment, a query parameter or a body. A handler that validated first
  answered an anonymous caller `400`, which is a refusal with no credential
  behind it on a route where the log has no other way to judge one: those
  lines took credentialed ring space and carried the journal head with them.
- Every refused sign-in is a `warn` line carrying its decision, and it
  reaches the Logs page as well as stdout for as long as it is retained: a
  run of attempts is visible rather than merely rate-limited, and it cannot
  push the authenticated record off that page (the ring split below). A
  refusal is unauthenticated traffic, so it sits in the 200-line public ring
  and other unauthenticated traffic can displace it there; stdout keeps it
  either way.
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
- **The app that opens a sign-in link may log it** (issue #270). **Open
  dashboard** hands the link to the system browser through Obsidian, and
  Obsidian writes the whole address, token included, to its own console
  output (`Opening URL: …/login?token=…`, seen in the 2026-09-29 validation
  run, where that output was kept in a file). Wherever a host's output is
  kept, the token is kept with it, and the browser's history keeps the
  address too. What such a copy can open is bounded: the token opens one
  session, once, and only within **five minutes** of being minted. Spent --
  normally seconds after the click -- a copy opens nothing; never spent, it
  dies at five minutes, on sign-out-everywhere, or when the device that
  minted it is revoked. Five minutes and not seconds, because an edge may
  put its own sign-in in front of `GET /login` -- Cloudflare Access's
  one-time PIN by e-mail ([shape B](../cloudflare.md#shape-b-a-public-hostname-behind-access)),
  or a reverse proxy's login -- and the link has to survive it. The server
  test `a_sign_in_link_lives_five_minutes_and_opens_once` pins that lifetime
  to the second.
- **A revoked device's requests are NOT credentialed.** Revocation destroys
  the wrapped secret, so `403 device_revoked` has to be answered from the
  device record before any signature can be checked — there is nothing left
  to check one against. The refusal therefore proves nothing, carries no
  `X-Obsync-Seq`, and its line sits in the public ring, where a revoked
  device still hammering the server is visible but can be displaced by other
  unauthenticated traffic. Stdout keeps every one of those lines. A pending
  device is the other way round: it still holds its secret, so
  `403 device_pending` is answered only after its signature verifies and is
  credentialed.
- **A revoked device id can be told from an unknown one** by the status
  alone: `403 device_revoked` against `401 bad_signature`, for the reason
  above. A device id is not a secret the protocol protects, and the
  alternative is a refusal that does not say what happened.
- **Forgetting a device changes the LIST, not the device.** It archives the
  record (`POST /v1/admin/devices/{id}/archive`, issue #247): a revoked
  device only, under the session and the double-submit check like every other
  mutation, journaled before the answer. The record stays, so that device is
  still answered `403 device_revoked` rather than becoming indistinguishable
  from a stranger, and the versions it wrote keep an author. Deleting it
  instead would have removed evidence an operator may need, so the page says
  how many devices it is not listing.
- The decision log is not an audit log. It is two bounded rings in memory —
  1000 lines from credentialed requests, 200 from everything else — so
  unauthenticated traffic can push out only other unauthenticated traffic,
  including other unauthenticated traffic's own refusals. Both rings are
  shown. Ship stdout for an audit trail; every line in these rings was
  written there first.
- `POST /v1/setup` and `POST /v1/pairing/{id}/claim` remain PUBLIC routes,
  but a setup call whose token compares equal records the proof and is
  credentialed from that point: the account-creation line is no longer
  evictable. A pairing claim is not, because it parses a body before it
  compares anything.
- Revocation is final. There is no un-revoke route and no CLI recovery; the
  last ACTIVE device cannot be revoked from either route, because nothing
  re-enrols one.
- A session can be ended from another device, by revoking the device whose
  link opened it: revocation closes that device's sessions and drops its
  unspent links from either revoke route. What cannot be done from a device
  is ending a session that the RECOVERY token opened, because no device
  minted it; that one ends on sign-out, sign-out-everywhere, either limit, or
  a restart.

## 7. Rotation and break-glass

- **Rotate the recovery token:** stop the server, delete `v1/setup-token`
  from the journal volume, start it. A new 64-hex token is minted at mode
  0600 and the old one stops working. Devices are unaffected.
- **Revoking a device** drops its wrapped secret, refuses its next request,
  and now also drops the dashboard sessions its links opened and any link it
  minted that nobody has spent. It does not touch other devices, and it
  cannot be undone.
- **The last-device refusal** protects accounts without registered recovery.
  Once an authenticated client registers the vault-key verifier, the last device
  may be revoked: the setup token plus vault-key proof can enroll a new one.
  A legacy account that lost every credential before registration cannot do so.
- **Sign out everywhere** ends every session in the process at once and
  drops every unspent login link with them, for the browser left behind on a
  machine the operator no longer controls.
