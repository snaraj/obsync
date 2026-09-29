#!/usr/bin/env bash
# install-keyring -- GNOME Keyring, from pinned packages, for the keyring case
# of the Linux desktop leg (.github/workflows/desktop-matrix.yml).
#
# WHY. The docs (#217) say what obsync's keys do on Linux with a keyring and
# without one. The runner as it comes is the case without; this installs the
# other, so both are driven through the real Obsidian by
# scripts/ci/obsidian-e2e.sh.
#
# THE PINS. Ubuntu 24.04 (noble) amd64 packages from Ubuntu's snapshot archive
# at one instant, so each URL names the same bytes for as long as the archive
# stands; each SHA-256 is the one that instant's signed index gives. They are
# what `apt-get install --no-install-recommends gnome-keyring libsecret-1-0`
# adds to a host that already runs a desktop app (Chromium opens libsecret
# itself, so it is named as well as the keyring). A package the runner already
# has installed is left alone and named: dpkg then refuses the set if one it
# keeps does not fit the rest, and that refusal means the pins move, never a
# forced install. Every file is verified before any is installed, and all go
# to one `dpkg -i`, which orders them.
#
# Requires: curl, sha256sum, dpkg, sudo. amd64 only: the leg runs there.
set -euo pipefail

readonly SNAPSHOT='https://snapshot.ubuntu.com/ubuntu/20260926T000000Z'
readonly PINS='
pool/main/g/gcr4/libgck-2-2_4.2.0-5_amd64.deb 3598c9a6bbf5960ffb97639f964567541970abb1d7a765001524b76c50de7639
pool/main/g/gcr4/libgcr-4-4_4.2.0-5_amd64.deb a4e29eba33714269df708316f02e1a52d59e801a8def898b2408c9fe64c85107
pool/main/l/lzo2/liblzo2-2_2.10-2build4_amd64.deb e0d13be155013138b8db4cfe68212b866080af661c78302c2eab0d2f9d0d454e
pool/main/c/cairo/libcairo-script-interpreter2_1.18.0-3build1_amd64.deb e104466e7d816672a711db42746af528d210197231f12e3c712c06ac9a79b214
pool/main/g/graphene/libgraphene-1.0-0_1.10.8-3build2_amd64.deb 5276c4173bff30bd2a368cce30639227089512aad85fc4af87c284456bafe8ff
pool/main/libg/libglvnd/libgles2_1.7.0-1build1_amd64.deb 9dec2d79a2eebb80522f7cce77995f7a8ded22f0e3916f13353d066c62f97fac
pool/main/g/gtk4/libgtk-4-common_4.14.5+ds-0ubuntu0.10_all.deb c4a62cbed476b05663f0ed03145234dad431d25ce329863c56cc80074c0bb2ed
pool/main/g/gtk4/libgtk-4-1_4.14.5+ds-0ubuntu0.10_amd64.deb 2361861e33d34a26f3d6c4906935fd9e6241eb44ff30564cb493b5671111a24f
pool/main/libs/libsecret/libsecret-common_0.21.4-1build3_all.deb 41866e9026e451fd25a4cbe887fa56c43219f9f3eda88d1831452ba6d6b8bb5b
pool/main/libs/libsecret/libsecret-1-0_0.21.4-1build3_amd64.deb 7d7263ffc92c33042328f99c93433a846e8d9e549876dab18ba18606e6541ecd
pool/main/g/gcr4/gcr4_4.2.0-5_amd64.deb d19b647b69a17a93e5446b3b7a35e930a398d71d8c9a1390846c66e6a6700259
pool/main/g/gcr/libgck-1-0_3.41.2-1build3_amd64.deb bceace92f5cbbf55ab2c963a426f73335c887f0c1c45c7b0b7d7610b36d9afde
pool/main/g/gcr/libgcr-base-3-1_3.41.2-1build3_amd64.deb b702e0ef02517caf5a3e35b9b663dfc22935315dc2e7dc507e78435963ff2e24
pool/main/g/gcr/libgcr-ui-3-1_3.41.2-1build3_amd64.deb e48fd6e74dddbb1a522abd4b9f2a40b10bc73c93c7279809817dd71377a6d090
pool/main/g/gcr/gcr_3.41.2-1build3_amd64.deb 5c239a7ec1a732c649ab4c043cd55a5c7a2c673df4e486a8317e42a25cc9f928
pool/main/p/p11-kit/p11-kit-modules_0.25.3-4ubuntu2.2_amd64.deb 02a6d3b652fdfdc2b003464121e29027b2459cb4131c72d85de1d97582d5aaa7
pool/main/p/p11-kit/p11-kit_0.25.3-4ubuntu2.2_amd64.deb 78f36f206d13cc5846e573e0036145ffa5288d90d77097749849811d9df8cfdc
pool/main/p/pinentry/pinentry-gnome3_1.2.1-3ubuntu5_amd64.deb cb9fdd783296e76d6869a3443d6b6cd5e1b48420dd122e3d7f9a9e77911c5797
pool/main/g/gnome-keyring/gnome-keyring_46.1-2ubuntu0.2_amd64.deb 86629a081c91dd8004655f5f48d8a5bfb75dde8c4e69ef7401b15568c2eacafb
'

deny() {
  printf 'install-keyring: DENY %s\n' "$1" >&2
  exit 1
}

for tool in curl sha256sum dpkg dpkg-query sudo; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed"
done
[ "$(dpkg --print-architecture)" = amd64 ] || deny "the pins are amd64 packages, not $(dpkg --print-architecture)"
started="$(date +%s)"
printf 'install-keyring: START snapshot=%s pins=%d\n' "${SNAPSHOT}" "$(printf '%s' "${PINS}" | grep -c .)"

work="$(mktemp -d "${TMPDIR:-/tmp}/install-keyring.XXXXXX")"
trap 'rm -rf -- "${work}"' EXIT
kept=''
while read -r path sha; do
  [ -n "${path}" ] || continue
  file="${path##*/}"
  name="${file%%_*}"
  status="$(dpkg-query -W -f='${db:Status-Abbrev}${Version}' "${name}" 2>/dev/null || true)"
  if [ "${status#ii }" != "${status}" ]; then
    kept="${kept} ${name}=${status#ii }"
    continue
  fi
  curl --proto '=https' --tlsv1.2 -sSfL -o "${work}/${file}" "${SNAPSHOT}/${path}" \
    || deny "could not download ${path}"
  printf '%s  %s\n' "${sha}" "${work}/${file}" | sha256sum -c - >/dev/null \
    || deny "${file} does not match its pinned SHA-256"
done <<<"${PINS}"

shopt -s nullglob
set -- "${work}"/*.deb
if [ "$#" -gt 0 ]; then
  # shellcheck disable=SC2024 # the log is this run's, written as this user
  sudo dpkg -i "$@" >"${work}/dpkg.log" 2>&1 \
    || { tail -n 40 "${work}/dpkg.log" >&2; deny 'dpkg refused the pinned set'; }
fi
for tool in gnome-keyring-daemon dbus-run-session dbus-send; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not on PATH after the install"
done
ldconfig -p | grep -q 'libsecret-1\.so\.0 ' || deny 'libsecret-1.so.0 is not in the linker cache after the install'
printf 'install-keyring: SUMMARY installed=%d kept=[%s ] duration=%ds decision=pass\n' \
  "$#" "${kept}" "$(($(date +%s) - started))"
