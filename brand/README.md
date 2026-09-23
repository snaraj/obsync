# The obsync mark

Two interlocked rings: one vault, two devices, neither holding the other's
key. The lighter ring is in front and to the left, the darker one behind and
to the right; they pass through each other, so the mark reads the same at
1024 px and at 48 px.

## Palette

| Role | Ring | sRGB |
| --- | --- | --- |
| Primary | front, left | `#A079FF` |
| Secondary | back, right | `#5B32A6` |

The social preview sits the mark on `#F4F4F6`, a neutral page background:
this repository publishes no docs site to take one from. All three colours
are constants at the top of [`render.py`](render.py), and nothing else in
this directory states one.

## Files

`obsync-icon.blend` is the master. Everything else here is output.

- `obsync-icon-{1024,512,256,128,64,48}.png` — the mark on a transparent film.
- `obsync-social-1280x640.png` — the mark centred on that background.
- `render.py` — the script that writes all seven from the master.

## Re-rendering

One command, from the repository root, with Blender 5.2.1 LTS:

```sh
blender -b brand/obsync-icon.blend --python brand/render.py
```

It overwrites the seven PNGs in place and reaches nothing outside this
directory: no network, no environment variable, no clock. The palette, the
sizes, the sample count and the seed are constants, the view transform is
`Standard` so the rendered ring is the colour the hex names, and Blender's
own PNG metadata — which carries the rendering machine's file paths and the
date — is stripped from every file it writes. Two runs of this master under
5.2.1 produced the committed files byte for byte.

## Provenance

The artwork is the repository owner's own work, made in Blender, and is
covered by this repository's [LICENSE](../LICENSE) like everything else here.
It is not derived from any third-party asset, font, or icon set.
