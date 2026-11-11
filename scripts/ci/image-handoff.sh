#!/usr/bin/env bash
# image-handoff -- build the shipped image ONCE per architecture and hand the
# exact bytes to every job that exercises it.
#
# WHY. Fourteen jobs per pull request each ran the same `docker build`, and
# each re-ran clippy, the Rust suite and the plugin suite inside it: four
# minutes apiece, and fourteen chances for one load-sensitive test to fail a
# run that changed nothing. Now `pr-gate.yml`'s `container` (amd64) and
# `image-arm64` jobs build, prove and `save` the image; every other job
# `take`s it.
#
#   save TAG DIR        write DIR/image.tar and print TAG's image ID
#   take ID DIR TAG     load DIR/image.tar, refuse unless the one image in it
#                       IS ID, and tag it TAG
#   take '' DIR TAG     a standalone run (manual or scheduled) with nothing
#                       handed to it: build the image from this checkout
#
# The ID travels separately from the tarball, as the building job's output, so
# a consumer can never exercise an image other than the one that job proved:
# an artifact holding anything else is refused by ID before it is used.
set -euo pipefail

deny() {
  printf 'image-handoff: DENY %s\n' "$*" >&2
  exit 1
}

image_id() {
  local id
  id="$(docker image inspect --format '{{.Id}}' "$1")"
  [[ "${id}" =~ ^sha256:[0-9a-f]{64}$ ]] || deny "image $1 has no sha256 ID (read '${id}')"
  printf '%s\n' "${id}"
}

case "${1:-}" in
  save)
    [ "$#" -eq 3 ] || deny "usage: save TAG DIR"
    id="$(image_id "$2")"
    mkdir -p "$3"
    docker save --output "$3/image.tar" "$2"
    printf 'image-handoff: saved %s id=%s bytes=%s\n' "$2" "${id}" "$(wc -c < "$3/image.tar" | tr -d ' ')" >&2
    printf '%s\n' "${id}"
    ;;
  take)
    [ "$#" -eq 4 ] || deny "usage: take ID DIR TAG"
    want="$2" dir="$3" tag="$4"
    if [ -z "${want}" ]; then
      printf 'image-handoff: standalone run, nothing handed over; building %s from this checkout\n' "${tag}" >&2
      docker build --tag "${tag}" .
      exit 0
    fi
    [[ "${want}" =~ ^sha256:[0-9a-f]{64}$ ]] || deny "the handed-over ID is not sha256:<64 hex> (read '${want}')"
    loaded="$(docker load --input "${dir}/image.tar")"
    printf '%s\n' "${loaded}" >&2
    references="$(sed -n 's/^Loaded image: //p; s/^Loaded image ID: //p' <<<"${loaded}")"
    count="$(printf '%s' "${references}" | grep -c '')" || true
    [ "${count}" -eq 1 ] || deny "expected exactly one image in ${dir}/image.tar, loaded ${count}"
    got="$(image_id "${references}")"
    [ "${got}" = "${want}" ] || deny "loaded ${got}, which is not the image the building job proved (${want})"
    docker tag "${got}" "${tag}"
    printf 'image-handoff: took %s as %s\n' "${got}" "${tag}" >&2
    ;;
  *)
    deny "usage: save TAG DIR | take ID DIR TAG"
    ;;
esac
