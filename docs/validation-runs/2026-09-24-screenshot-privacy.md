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

This repair does not change product attribution, mandated commit identity,
or protected history. Earlier immutable revisions retain their historical
bytes; current evidence links must point to this repaired revision.
