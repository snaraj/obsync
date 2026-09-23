"""Render the obsync brand mark from `obsync-icon.blend`.

Run it against the master scene, from anywhere:

    blender -b brand/obsync-icon.blend --python brand/render.py

It writes every committed PNG beside the .blend: the six square icons on a
transparent film, and the social preview with the mark centred on the docs
background colour. Nothing here reaches the network, reads an environment
variable, or depends on the clock: the palette, the sizes, the sample count
and the seed are the constants below, so two runs of one Blender build
produce the same bytes.

The scene itself carries the palette already. Setting it here as well is the
point: the hex values are readable, they are applied before the first sample
is traced, and a scene edited by hand cannot drift away from them unnoticed.
"""

from __future__ import annotations

import os
import struct
from array import array

import bpy

# ---- the mark -------------------------------------------------------------

# sRGB hex, as the brand states them. The front/left ring is the lighter
# primary; the back/right ring is the darker secondary.
PRIMARY_HEX = "#A079FF"
SECONDARY_HEX = "#5B32A6"
# The social preview's background. This repository publishes no docs site,
# so it is a neutral near-white page colour rather than one read off a page.
SOCIAL_BACKGROUND_HEX = "#F4F4F6"

PRIMARY_MATERIAL = "obsync / primary"
SECONDARY_MATERIAL = "obsync / secondary"

# ---- the outputs ----------------------------------------------------------

ICON_SIZES = (1024, 512, 256, 128, 64, 48)
ICON_NAME = "obsync-icon-%d.png"
SOCIAL_NAME = "obsync-social-1280x640.png"
SOCIAL_WIDTH, SOCIAL_HEIGHT = 1280, 640
# The mark inside the social preview, and the icon render it is composed from.
SOCIAL_MARK = 512

# ---- determinism ----------------------------------------------------------

SAMPLES = 512
SEED = 0
ADAPTIVE_THRESHOLD = 0.01
MAX_BOUNCES = 12
# Maximum lossless deflate. No lossy step exists in this file.
PNG_COMPRESSION = 100
# The PNG chunks a committed icon keeps: the datastream itself, and the three
# that declare it sRGB. Blender writes several more -- the .blend's absolute
# path, the date, the per-layer render time -- and each is either a private
# particular this repository does not carry or a reason two identical runs
# would differ byte for byte.
KEEP_CHUNKS = frozenset(
    (b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"sRGB", b"gAMA", b"cHRM")
)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def srgb_to_linear(channel: float) -> float:
    """One sRGB channel, 0..1, as scene-linear Rec.709 -- IEC 61966-2-1."""
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def hex_to_linear(value: str) -> tuple[float, float, float]:
    """`#RRGGBB` as the three linear floats Blender stores in a colour."""
    digits = value.lstrip("#")
    if len(digits) != 6:
        raise ValueError(f"expected #RRGGBB, got {value!r}")
    return tuple(
        srgb_to_linear(int(digits[index : index + 2], 16) / 255.0)
        for index in (0, 2, 4)
    )


def paint(material_name: str, hex_value: str) -> None:
    """Set one material's Principled base colour from an sRGB hex."""
    material = bpy.data.materials.get(material_name)
    if material is None:
        raise KeyError(f"the scene has no material named {material_name!r}")
    shader = next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )
    if shader is None:
        raise KeyError(f"{material_name!r} has no Principled BSDF to paint")
    red, green, blue = hex_to_linear(hex_value)
    shader.inputs["Base Color"].default_value = (red, green, blue, 1.0)


def configure(scene: bpy.types.Scene) -> None:
    """Every setting the committed PNGs depend on, stated rather than inherited."""
    render = scene.render
    render.engine = "CYCLES"
    render.film_transparent = True
    render.resolution_percentage = 100
    render.use_overwrite = True
    # No stamp reaches the file. Blender's metadata would write the .blend's
    # absolute path into every PNG -- a private particular this repository
    # does not carry -- plus the date and the render time, which would make
    # two identical runs differ byte for byte.
    for flag in dir(render):
        if flag.startswith("use_stamp"):
            setattr(render, flag, False)
    render.stamp_note_text = ""
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.image_settings.compression = PNG_COMPRESSION

    # "Standard" is what makes the rendered ring the colour the hex names:
    # AgX and Filmic are film emulations and would grade the palette away.
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.view_settings.use_curve_mapping = False

    cycles = scene.cycles
    cycles.seed = SEED
    cycles.use_animated_seed = False
    cycles.samples = SAMPLES
    cycles.use_adaptive_sampling = True
    cycles.adaptive_threshold = ADAPTIVE_THRESHOLD
    cycles.max_bounces = MAX_BOUNCES
    cycles.use_denoising = True
    cycles.denoiser = "OPENIMAGEDENOISE"
    cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cycles.denoising_prefilter = "ACCURATE"
    cycles.time_limit = 0.0  # a time limit would make the sample count a race


def strip_metadata(path: str) -> None:
    """Rewrite one PNG keeping only `KEEP_CHUNKS`, in the order it had them."""
    with open(path, "rb") as source:
        data = source.read()
    if data[:8] != PNG_MAGIC:
        raise ValueError(f"{path} is not a PNG datastream")
    kept = [PNG_MAGIC]
    offset = 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        end = offset + 12 + length
        if data[offset + 4 : offset + 8] in KEEP_CHUNKS:
            kept.append(data[offset:end])
        offset = end
    with open(path, "wb") as target:
        target.write(b"".join(kept))


def render_to(scene: bpy.types.Scene, size: int, path: str) -> None:
    """Render one transparent square at `size` and write it to `path`."""
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    strip_metadata(path)


def compose_social(scene: bpy.types.Scene, mark_path: str, path: str) -> None:
    """The mark, centred on the background colour, as one opaque PNG.

    The composite is done on linear values with the mark's own alpha, so no
    edge pixel picks up a halo from the transparent film it was rendered on.
    """
    mark = bpy.data.images.load(mark_path)
    try:
        mark.alpha_mode = "STRAIGHT"
        width, height = mark.size
        pixels = array("f", bytes(4 * 4 * width * height))
        mark.pixels.foreach_get(pixels)
    finally:
        bpy.data.images.remove(mark)

    # A byte image hands back exactly what the file holds, unmanaged, so the
    # mark arrives sRGB-encoded with straight alpha. 8-bit input has 256
    # possible channel values; decoding them once is the whole conversion.
    decode = [srgb_to_linear(step / 255.0) for step in range(256)]
    background = hex_to_linear(SOCIAL_BACKGROUND_HEX)
    canvas = array("f", bytes(4 * 4 * SOCIAL_WIDTH * SOCIAL_HEIGHT))
    for index in range(0, len(canvas), 4):
        canvas[index] = background[0]
        canvas[index + 1] = background[1]
        canvas[index + 2] = background[2]
        canvas[index + 3] = 1.0

    left = (SOCIAL_WIDTH - width) // 2
    bottom = (SOCIAL_HEIGHT - height) // 2
    for row in range(height):
        source = row * width * 4
        target = ((bottom + row) * SOCIAL_WIDTH + left) * 4
        for _ in range(width):
            alpha = pixels[source + 3]
            if alpha > 0.0:
                rest = 1.0 - alpha
                for channel in range(3):
                    over = decode[int(pixels[source + channel] * 255.0 + 0.5)]
                    canvas[target + channel] = over * alpha + background[channel] * rest
            source += 4
            target += 4

    social = bpy.data.images.new(
        "obsync social", SOCIAL_WIDTH, SOCIAL_HEIGHT, alpha=False, float_buffer=True
    )
    try:
        social.pixels.foreach_set(canvas)
        scene.render.image_settings.color_mode = "RGB"
        social.save_render(filepath=path, scene=scene)
        strip_metadata(path)
    finally:
        scene.render.image_settings.color_mode = "RGBA"
        bpy.data.images.remove(social)


def main() -> None:
    scene = bpy.context.scene
    paint(PRIMARY_MATERIAL, PRIMARY_HEX)
    paint(SECONDARY_MATERIAL, SECONDARY_HEX)
    configure(scene)

    here = bpy.path.abspath("//") if bpy.data.filepath else os.getcwd()
    for size in ICON_SIZES:
        render_to(scene, size, os.path.join(here, ICON_NAME % size))
    mark = os.path.join(here, ICON_NAME % SOCIAL_MARK)
    compose_social(scene, mark, os.path.join(here, SOCIAL_NAME))


if __name__ == "__main__":
    main()
