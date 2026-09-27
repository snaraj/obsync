#!/usr/bin/env bash
# obsidian-session -- start one Obsidian instance in a desktop session of its
# own, for the keyring case of scripts/ci/obsidian-e2e.sh.
#
# Each instance the driver starts is one DEVICE, so it gets what a person's
# GNOME login gives them: a D-Bus session bus of its own (never the caller's:
# a developer's session holds a keyring this must not write to), GNOME
# Keyring unlocked in it, its login keyring kept under the instance's own
# HOME, and a GNOME desktop named, which is what makes Chromium take the
# keyring. Two instances sharing one keyring are one person running two
# Obsidians at once, and each would make its own encryption key there.
#
# Started again on the same HOME, the login keyring is read back from disk and
# unlocked with the same password, as at a person's next login. Before
# Obsidian starts, the login keyring must be unlocked and the default
# collection, so a keyring that is not there cannot pass for one that is.
#
# usage: obsidian-session.sh <obsidian binary> [arguments...]
#   OBSYNC_E2E_KEYRING_PASSWORD  a file holding the keyring's password, for
#                                every instance of the run; never printed.
# Requires: dbus-run-session, dbus-send, gnome-keyring-daemon.
set -euo pipefail

deny() {
  printf 'obsidian-session: DENY %s\n' "$1" >&2
  exit 1
}

: "${OBSYNC_E2E_KEYRING_PASSWORD:?the keyring password file is not set}"
[ "$#" -ge 1 ] || deny 'no Obsidian binary to start'
if [ -z "${OBSYNC_E2E_SESSION_BUS:-}" ]; then
  exec dbus-run-session -- env OBSYNC_E2E_SESSION_BUS=1 "$0" "$@"
fi

# A runtime directory for this start alone: the daemon's control socket lives
# there, and one left by the last start must not answer for this one.
XDG_RUNTIME_DIR="$(mktemp -d "${HOME}/.runtime.XXXXXX")"
export XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP=GNOME
gnome-keyring-daemon --unlock --components=secrets <"${OBSYNC_E2E_KEYRING_PASSWORD}" >/dev/null \
  || deny 'GNOME Keyring would not start and unlock a login keyring'
secrets() {
  dbus-send --session --print-reply --dest=org.freedesktop.secrets "$@" 2>&1 || true
}
secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.SetAlias \
  string:default objpath:/org/freedesktop/secrets/collection/login >/dev/null
alias="$(secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default)"
locked="$(secrets /org/freedesktop/secrets/collection/login org.freedesktop.DBus.Properties.Get \
  string:org.freedesktop.Secret.Collection string:Locked)"
case "${alias}" in *'"/org/freedesktop/secrets/collection/login"'*) ;; *) deny "the default collection is not login: ${alias}" ;; esac
case "${locked}" in *'boolean false'*) ;; *) deny "the login keyring is not unlocked: ${locked}" ;; esac
printf 'obsidian-session: GNOME Keyring on a session bus of its own, login unlocked and the default, home=%s\n' "${HOME}" >&2
exec "$@"
