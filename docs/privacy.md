# Privacy

*For anyone deciding whether to trust obsync, and for anyone reading this site.*

Dated 2026-11-02.

obsync is software you run. The project runs no sync service, keeps no account
for you, and receives nothing from the plugin, the CLI or the server. What exists
about you is on your devices and on the server you sync to, and whoever runs
that server holds it.

## The plugin and the CLI

- **The plugin talks only to your server.** Every request goes to the
  **Server URL** you set. It sends no telemetry and no crash reports. The only
  plugin version it asks about is the one your server serves; Obsidian itself
  installs and updates the plugin from the project's GitHub Releases.
- **It opens a browser page only when you ask:** the setup guide on this site,
  or your server's dashboard.
- **The CLI in this release makes no network connection at all.** It saves the
  server addresses you give it and contacts none of them.

## The server you sync to

- **It cannot read your notes.** Their contents, your attachments, and file
  and folder names are encrypted on your device before anything is sent, and
  the server never receives the key.
- **It can see** the account name; each device's name, platform and plugin
  version; the address each device connects from, and its country when the
  server runs in the `cloudflare` edge mode; when each device signs in, checks
  in and writes; how many files there are, how large each version is, and when
  it changed. The [threat model](threat-model.md#visible-metadata-and-attribution)
  lists every field.
- **Every device paired to the account, and every dashboard session, can read
  the device list**, addresses included.
- **It keeps a device's record after the device is revoked.** Its name, its
  last address and its newest 256 activity events stay until the server is
  [purged](purge.md). The server's own log holds no addresses and no device
  names. [What the server keeps about a device](dashboard.md#what-the-server-keeps-about-a-device)
  lists each item, how long it stays and what removes it.
- **It sends nothing to the project or to anyone else.** It only answers
  requests.
- **Its dashboard loads nothing from anywhere else.** Signing in sets two
  cookies that belong to that sign-in and expire within 12 hours; the
  dashboard keeps nothing else in your browser.

If someone else runs the server you sync to, they hold all of this; ask them.
If you run it for other people, that dashboard section is what you can tell
them.

## This site

- **It is hosted on GitHub Pages.** Like any web host, GitHub receives your
  address and the pages you request, under its own privacy terms. obsync adds
  no analytics, no counters and no tracking.
- **Everything loads from this site.** Text renders in your system's fonts,
  and no script, stylesheet or font comes from anywhere else; the build
  refuses to publish a page that would load one. Links to the repository reach
  GitHub only when you follow them.
- **Search runs in your browser**, against an index this site serves, so
  typing a search sends nothing. Opening a result does: its link carries the
  words that matched, and the host receives them with that page's request.
- **The pages set no cookies.** The site's theme keeps two entries in your
  browser's storage for this site: the light or dark palette it is showing, in
  local storage, until you clear the site's data; and an empty placeholder in
  session storage for repository details the site never fetches, which the
  browser drops when you close the tab. Neither is sent anywhere.
