#!/usr/bin/env python3
"""Merge JetBrains Mono + Apple Symbols into a local monospace font."""

from __future__ import annotations

import argparse
import unicodedata
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

DEFAULT_JB = Path("/tmp/JetBrainsMono-Regular.ttf")
DEFAULT_APPLE = Path("/System/Library/Fonts/Apple Symbols.ttf")
DEFAULT_OUT = Path.home() / "Library/Fonts/TypehereMono-Regular.ttf"

COMBINING_CATEGORIES = frozenset({"Mn", "Me", "Mc"})
SKIP_CATEGORIES = frozenset({"Cs", "Cc", "Cf", "Co", "Cn"})
MAX_FILL = 0.9


def glyph_bounds(glyph_set, glyph_name, transform=(1, 0, 0, 1, 0, 0)):
    pen = BoundsPen(glyph_set)
    glyph_set[glyph_name].draw(TransformPen(pen, transform))
    return pen.bounds


def draw_decomposed_glyph(donor_set, donor_glyph_name, base_glyph_set, transform):
    recording = DecomposingRecordingPen(donor_set, skipMissingComponents=True)
    donor_set[donor_glyph_name].draw(recording)
    pen = TTGlyphPen(base_glyph_set)
    recording.replay(TransformPen(pen, transform))
    return pen.glyph()


def set_name(font: TTFont, family: str, style: str) -> None:
    names = font["name"]
    entries = {
        1: family,
        2: style,
        4: f"{family} {style}",
        6: f"{family.replace(' ', '')}-{style.replace(' ', '')}",
        16: family,
        17: style,
    }
    for name_id, value in entries.items():
        names.setName(value, name_id, 3, 1, 0x409)


def add_cmap_entry(font: TTFont, codepoint: int, glyph_name: str) -> None:
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[codepoint] = glyph_name


def unique_glyph_name(font: TTFont, base_name: str) -> str:
    if base_name not in font.getGlyphSet():
        return base_name
    index = 1
    while f"{base_name}.apple{index}" in font.getGlyphSet():
        index += 1
    return f"{base_name}.apple{index}"


def reference_y_center(font: TTFont) -> float:
    cmap = font.getBestCmap()
    glyph_name = cmap.get(ord("X")) or cmap.get(ord("O")) or next(iter(cmap.values()))
    bounds = glyph_bounds(font.getGlyphSet(), glyph_name)
    if not bounds:
        return 0.0
    return (bounds[1] + bounds[3]) / 2


def import_glyph(
    base: TTFont,
    donor: TTFont,
    codepoint: int,
    donor_glyph_name: str,
    cell_width: int,
    upm_scale: float,
    y_center: float,
    *,
    preserve_donor_metrics: bool = False,
    replace_glyph_name: str | None = None,
) -> str | None:
    category = unicodedata.category(chr(codepoint))
    if category in SKIP_CATEGORIES:
        return None

    donor_set = donor.getGlyphSet()
    if donor_glyph_name not in donor_set:
        return None

    if replace_glyph_name and replace_glyph_name in base.getGlyphSet():
        # Keep the existing glyph slot so JetBrains GSUB/calt rules still match.
        new_name = replace_glyph_name
    else:
        new_name = unique_glyph_name(
            base,
            f"uni{codepoint:04X}" if codepoint >= 0x100 else donor_glyph_name,
        )
    base_glyph_set = base.getGlyphSet()

    if category in COMBINING_CATEGORIES:
        scale = upm_scale
        bounds = glyph_bounds(donor_set, donor_glyph_name, (scale, 0, 0, scale, 0, 0))
        if not bounds:
            return None
        xmin, _, _, _ = bounds
        tx = -xmin
        ty = y_center - ((bounds[1] + bounds[3]) / 2)
        glyph = draw_decomposed_glyph(
            donor_set,
            donor_glyph_name,
            base_glyph_set,
            (scale, 0, 0, scale, tx, ty),
        )
        if glyph.numberOfContours == 0 and not glyph.isComposite():
            return None
        base["glyf"][new_name] = glyph
        base["hmtx"][new_name] = (0, 0)
        return new_name

    scale = upm_scale
    bounds = glyph_bounds(donor_set, donor_glyph_name, (scale, 0, 0, scale, 0, 0))
    if not bounds:
        return None

    xmin, ymin, xmax, ymax = bounds
    if preserve_donor_metrics:
        donor_advance, donor_lsb = donor["hmtx"][donor_glyph_name]
        advance = round(donor_advance * upm_scale)
        lsb = round(donor_lsb * upm_scale)
        tx = lsb - xmin
        ty = 0
    else:
        width = xmax - xmin
        max_width = cell_width * MAX_FILL
        if width > max_width:
            scale *= max_width / width

        bounds = glyph_bounds(donor_set, donor_glyph_name, (scale, 0, 0, scale, 0, 0))
        xmin, ymin, xmax, ymax = bounds
        advance = cell_width
        lsb = 0
        tx = (cell_width - (xmax - xmin)) / 2 - xmin
        ty = y_center - ((ymin + ymax) / 2)

    glyph = draw_decomposed_glyph(
        donor_set,
        donor_glyph_name,
        base_glyph_set,
        (scale, 0, 0, scale, tx, ty),
    )
    if glyph.numberOfContours == 0 and not glyph.isComposite():
        return None
    base["glyf"][new_name] = glyph
    base["hmtx"][new_name] = (advance, lsb)
    return new_name


def sync_glyph_order(font: TTFont) -> None:
    glyf_names = set(font["glyf"].glyphs.keys())
    order: list[str] = []
    seen: set[str] = set()
    for name in font.getGlyphOrder():
        if name in glyf_names and name not in seen:
            order.append(name)
            seen.add(name)
    for name in font["glyf"].glyphs:
        if name not in seen:
            order.append(name)
            seen.add(name)
    font.setGlyphOrder(order)


def sanitize_glyph_flags(font: TTFont) -> int:
    """Clear reserved bits in TrueType glyph flags (OTS rejects bit 6/7)."""
    fixed = 0
    for glyph_name in font.getGlyphOrder():
        glyph = font["glyf"][glyph_name]
        if glyph.numberOfContours <= 0 or not hasattr(glyph, "flags"):
            continue
        new_flags = bytearray()
        changed = False
        for flag in glyph.flags:
            cleaned = flag & 0x3F
            if cleaned != flag:
                changed = True
            new_flags.append(cleaned)
        if changed:
            glyph.flags = new_flags
            fixed += 1
    return fixed


def normalize_existing_metrics(font: TTFont, cell_width: int) -> None:
    """Ensure monospace advance width without disturbing native sidebearings.

    Zeroing lsb (as the old version did) shifts JetBrains glyphs left in
    renderers that honor hmtx, causing wide glyphs like ``>`` and ``→`` to
    overlap the next character.
    """
    for glyph_name in font.getGlyphOrder():
        advance, lsb = font["hmtx"][glyph_name]
        if advance == 0:
            continue
        if advance != cell_width:
            font["hmtx"][glyph_name] = (cell_width, lsb)


def translate_glyph_outline(font: TTFont, glyph_name: str, tx: float, ty: float = 0) -> None:
    glyph_set = font.getGlyphSet()
    recording = DecomposingRecordingPen(glyph_set)
    glyph_set[glyph_name].draw(recording)
    pen = TTGlyphPen(glyph_set)
    recording.replay(TransformPen(pen, (1, 0, 0, 1, tx, ty)))
    font["glyf"][glyph_name] = pen.glyph()


def center_glyph_horizontally(font: TTFont, glyph_name: str, cell_width: int) -> bool:
    """Center a glyph outline in a monospace cell and sync hmtx lsb."""
    glyph_set = font.getGlyphSet()
    if glyph_name not in glyph_set:
        return False

    bounds = glyph_bounds(glyph_set, glyph_name)
    if not bounds:
        return False

    xmin, _, xmax, _ = bounds
    width = xmax - xmin
    target_lsb = round((cell_width - width) / 2)
    tx = target_lsb - xmin

    if abs(tx) >= 0.5:
        translate_glyph_outline(font, glyph_name, tx)

    font["hmtx"][glyph_name] = (cell_width, target_lsb)
    return True


def center_non_ascii_glyphs(
    font: TTFont,
    cell_width: int,
    *,
    ascii_range: tuple[int, int] = (32, 127),
    only_codepoints: set[int] | frozenset[int] | None = None,
) -> int:
    """Horizontally center non-ASCII glyphs in the monospace cell.

    Berkeley ASCII (32-126) keeps native sidebearings from the overlay step.
    JetBrains-native glyphs keep their sidebearings unless listed in
    ``only_codepoints`` (typically Apple Symbols fill-ins).
    """
    cmap = font.getBestCmap()
    centered = 0
    lo, hi = ascii_range
    for codepoint, glyph_name in sorted(cmap.items()):
        if lo <= codepoint < hi:
            continue
        if only_codepoints is not None and codepoint not in only_codepoints:
            continue
        if center_glyph_horizontally(font, glyph_name, cell_width):
            centered += 1
    return centered


def merge_fonts(
    jetbrains_path: Path,
    apple_path: Path,
    output_path: Path | None = None,
    family_name: str = "Typehere Mono",
) -> tuple[TTFont, dict[str, int | set[int]]]:
    if not jetbrains_path.exists():
        raise FileNotFoundError(f"Missing JetBrains Mono: {jetbrains_path}")
    if not apple_path.exists():
        raise FileNotFoundError(f"Missing Apple Symbols: {apple_path}")

    base = TTFont(jetbrains_path)
    donor = TTFont(apple_path)

    base_cmap = base.getBestCmap()
    donor_cmap = donor.getBestCmap()

    cell_width = base["hmtx"][base_cmap[ord("X")]][0]
    upm_scale = base["head"].unitsPerEm / donor["head"].unitsPerEm
    y_center = reference_y_center(base)

    normalize_existing_metrics(base, cell_width)

    imported = 0
    skipped = 0
    apple_codepoints: set[int] = set()
    for codepoint, donor_glyph_name in sorted(donor_cmap.items()):
        if codepoint > 0xFFFF:
            skipped += 1
            continue
        if codepoint in base_cmap:
            skipped += 1
            continue

        new_name = import_glyph(
            base,
            donor,
            codepoint,
            donor_glyph_name,
            cell_width,
            upm_scale,
            y_center,
        )
        if not new_name:
            skipped += 1
            continue

        add_cmap_entry(base, codepoint, new_name)
        apple_codepoints.add(codepoint)
        imported += 1

    sync_glyph_order(base)
    set_name(base, family_name, "Regular")

    if "DSIG" in base:
        del base["DSIG"]

    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        base.save(output_path)

    return base, {
        "cell_width": cell_width,
        "imported": imported,
        "skipped": skipped,
        "apple_codepoints": apple_codepoints,
        "total_glyphs": len(base.getGlyphOrder()),
        "total_codepoints": len(base.getBestCmap()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jetbrains", type=Path, default=DEFAULT_JB)
    parser.add_argument("--apple", type=Path, default=DEFAULT_APPLE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--family-name", default="Typehere Mono")
    args = parser.parse_args()

    _, stats = merge_fonts(args.jetbrains, args.apple, args.output, args.family_name)

    print(f"Wrote {args.output}")
    print(f"Family name: {args.family_name}")
    print(f"Cell width: {stats['cell_width']}")
    print(f"Imported glyphs: {stats['imported']}")
    print(f"Skipped donor codepoints: {stats['skipped']}")
    print(f"Total glyphs: {stats['total_glyphs']}")
    print(f"Total mapped codepoints: {stats['total_codepoints']}")


if __name__ == "__main__":
    main()
