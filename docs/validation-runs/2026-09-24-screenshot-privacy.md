# Screenshot privacy repair, 2026-09-24

This author repair addresses the screenshot findings in the
[privacy handoff](https://github.com/snaraj/obsync/pull/133#issuecomment-5826036362).
It preserves the captures and their original device/version scope; it is not
new device acceptance or an independent privacy verdict.

39 committed PNGs were re-exported with only `IHDR`, `IDAT` and `IEND`
chunks. The export removes ICC profiles, EXIF, XMP and text metadata rather
than relying on a visible mask to hide embedded values. A scan of all
61 committed documentation PNGs found none of those metadata chunks.
Two older quickstart captures received the same metadata-only treatment.

12 captures have small solid masks flattened into their pixels:

- Author-name fields in plugin search, plugin details and installed-plugin
  screenshots.
- Connection-address and pairing-material fields that previously used
  pixelation.
- Unrelated installed profiles and trust settings, retaining the onboarding
  certificate and its off/on state.

The exporter verified PNG CRCs, decoded and re-encoded the image grid, and
compared every visible pixel outside the mask rectangles with its original.
All those pixels are unchanged. Every masked pixel is opaque; hidden RGB
values under fully transparent pixels were discarded. The exported masks
were visually inspected, including the surrounding labels and controls.
No screenshot was generated or reconstructed.

The 104 capture and 100 onboarding contract tests pass. Both Gitleaks scans
pass. The strict site build and output-origin checks pass in the pinned Linux
container using the existing hash-pinned documentation dependencies.

Relevant checks are the existing capture and onboarding contract suites:

```sh
python3 -I -B -m unittest discover -s scripts/ci -p 'test_capture_contract.py'
python3 -I -B -m unittest discover -s scripts/ci -p 'test_onboarding_contract.py'
```

The initial repair did not change product attribution, mandated commit
identity, or protected history. Earlier immutable revisions retain their historical
bytes; current evidence links must point to this repaired revision.

## Remaining inventory repair, 2026-09-25

The [replacement-head review](https://github.com/snaraj/obsync/pull/133#issuecomment-5828038509)
identified three older captures outside the original named set. Their
observed UI and device/version scope remain unchanged:

- `docs/captures/01-install-from-directory.png`: four author-name fields
  now have opaque masks.
- `docs/captures/03-recovery-phrase.png`: both columns of recovery material
  now have opaque masks in place of pixelation; word numbers and verification
  controls remain visible.
- `docs/assets/pair-new-device.png`: the pairing-material field now has an
  opaque mask in place of pixelation; instructions and controls remain visible.

Each export contains only `IHDR`, `IDAT` and `IEND`. CRC/decode checks pass,
every visible pixel outside the masks is unchanged, and the complete masked
exports were visually inspected. Indexed-color captures were expanded to RGB
without changing their displayed colors. No sensitive content was recovered.

The manifest's author and the documentation site's author now name the
project's contributors. Required license attribution and commit identity
remain intact. The predecessor PR's replacement-device link points to the
sanitized successor record where that evidence exists, retaining its exact
1.1.2 desktop / 1.1.3 phone scope.

The complete local gate and both secret scans pass after the follow-up.
Strict MkDocs and output-origin checks pass with the pinned offline Linux
container. The complete PNG inventory remains free of ICC, EXIF, XMP and text
metadata. The JavaScript bundle is unchanged; the distributed manifest carries
only the project-attribution change. This is author evidence, not a new native
acceptance or independent verdict.
