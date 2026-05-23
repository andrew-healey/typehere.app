#!/usr/bin/env python3
"""Overlay Berkeley Mono Trial ASCII onto a JetBrains + Apple Symbols stack.

Three explicit layers (bottom to top):
  1. JetBrains Mono — primary non-ASCII coverage and native metrics (e.g. →)
  2. Apple Symbols — fill codepoints JetBrains lacks
  3. Berkeley Trial — ASCII 32-126 overlay with native Berkeley metrics

Local preview only — Berkeley Trial is not licensed for redistribution.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

from fontTools.ttLib import TTFont

SCRIPT_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "merge_typehere_mono",
    SCRIPT_DIR / "merge-typehere-mono.py",
)
_merge = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_merge)

add_cmap_entry = _merge.add_cmap_entry
center_non_ascii_glyphs = _merge.center_non_ascii_glyphs
import_glyph = _merge.import_glyph
merge_fonts = _merge.merge_fonts
reference_y_center = _merge.reference_y_center
sanitize_glyph_flags = _merge.sanitize_glyph_flags
set_name = _merge.set_name
sync_glyph_order = _merge.sync_glyph_order

DEFAULT_BERKELEY = Path.home() / (
    "Downloads/berkeley-mono/2605231KV334Q57Z/TX-02-Z2XX0Q57/BerkeleyMonoTrial-Regular.otf"
)
DEFAULT_JB = Path("/tmp/JetBrainsMono-Regular.ttf")
DEFAULT_APPLE = Path("/System/Library/Fonts/Apple Symbols.ttf")
DEFAULT_SYMBOLS_CACHE = (
    Path(__file__).resolve().parents[1] / "public/TypehereMono-Regular-old.ttf"
)
DEFAULT_OUT = Path.home() / "Library/Fonts/TypehereMono-Regular.ttf"
DEFAULT_PUBLIC = Path(__file__).resolve().parents[1] / "public/TypehereMono-Regular.ttf"

# After Berkeley overlay: exchange outlines at these codepoints (cmap only).
GLYPH_SWAPS: tuple[tuple[int, int], ...] = (
    (0x002F, 0x005C),  # / ↔ \
    (0x002A, 0x0023),  # * ↔ #
)


def swap_cmap_codepoints(font: TTFont, codepoint_a: int, codepoint_b: int) -> bool:
    cmap = font.getBestCmap()
    if codepoint_a not in cmap or codepoint_b not in cmap:
        return False
    glyph_a = cmap[codepoint_a]
    glyph_b = cmap[codepoint_b]
    add_cmap_entry(font, codepoint_a, glyph_b)
    add_cmap_entry(font, codepoint_b, glyph_a)
    return True


def apply_glyph_swaps(font: TTFont) -> list[tuple[int, int]]:
    swapped: list[tuple[int, int]] = []
    for codepoint_a, codepoint_b in GLYPH_SWAPS:
        if swap_cmap_codepoints(font, codepoint_a, codepoint_b):
            swapped.append((codepoint_a, codepoint_b))
    return swapped


def apple_codepoints_from_cache(
    cache_path: Path,
    jetbrains_path: Path,
) -> set[int]:
    """Infer Apple fill-in codepoints by diffing a cached stack against JetBrains."""
    cached = TTFont(cache_path)
    jetbrains = TTFont(jetbrains_path)
    cached_cmap = cached.getBestCmap()
    jetbrains_cmap = jetbrains.getBestCmap()
    return {cp for cp in cached_cmap if cp not in jetbrains_cmap}


def build_symbols_stack(
    jetbrains_path: Path,
    apple_path: Path,
    *,
    cache_path: Path | None = None,
    use_cache: bool = False,
    family_name: str = "Typehere Mono",
) -> tuple[TTFont, set[int], dict[str, int | set[int]]]:
    """Layer 1 (JetBrains) + layer 2 (Apple fill-ins)."""
    if use_cache and cache_path is not None and cache_path.exists():
        base = TTFont(cache_path)
        apple_codepoints = apple_codepoints_from_cache(cache_path, jetbrains_path)
        cell_width = base["hmtx"][base.getBestCmap()[ord("X")]][0]
        return base, apple_codepoints, {
            "cell_width": cell_width,
            "imported": len(apple_codepoints),
            "skipped": 0,
            "apple_codepoints": apple_codepoints,
            "total_glyphs": len(base.getGlyphOrder()),
            "total_codepoints": len(base.getBestCmap()),
            "from_cache": True,
        }

    base, stats = merge_fonts(
        jetbrains_path,
        apple_path,
        output_path=cache_path,
        family_name=family_name,
    )
    stats["from_cache"] = False
    return base, stats["apple_codepoints"], stats


def merge_berkeley_trial(
    berkeley_path: Path,
    output_path: Path,
    *,
    jetbrains_path: Path = DEFAULT_JB,
    apple_path: Path = DEFAULT_APPLE,
    symbols_cache: Path | None = DEFAULT_SYMBOLS_CACHE,
    use_cache: bool = False,
    family_name: str = "Typehere Mono",
    public_path: Path | None = None,
) -> dict[str, int | list[tuple[int, int]] | bool]:
    if not berkeley_path.exists():
        raise FileNotFoundError(f"Missing Berkeley Mono Trial: {berkeley_path}")

    base, apple_codepoints, stack_stats = build_symbols_stack(
        jetbrains_path,
        apple_path,
        cache_path=symbols_cache,
        use_cache=use_cache,
        family_name=family_name,
    )
    berkeley = TTFont(berkeley_path)

    berkeley_cmap = berkeley.getBestCmap()
    if not berkeley_cmap:
        raise RuntimeError("Berkeley Mono Trial has no cmap entries")

    reference_cp = ord("X") if ord("X") in berkeley_cmap else min(berkeley_cmap)
    cell_width = berkeley["hmtx"][berkeley_cmap[reference_cp]][0]
    upm_scale = base["head"].unitsPerEm / berkeley["head"].unitsPerEm
    y_center = reference_y_center(berkeley)

    base_cmap = base.getBestCmap()
    replaced = 0
    skipped = 0
    for codepoint, donor_glyph_name in sorted(berkeley_cmap.items()):
        existing_glyph = base_cmap.get(codepoint)
        new_name = import_glyph(
            base,
            berkeley,
            codepoint,
            donor_glyph_name,
            cell_width,
            upm_scale,
            y_center,
            preserve_donor_metrics=True,
            replace_glyph_name=existing_glyph,
        )
        if not new_name:
            skipped += 1
            continue

        if new_name != existing_glyph:
            add_cmap_entry(base, codepoint, new_name)
        replaced += 1

    swapped_codepoints = apply_glyph_swaps(base)

    centered_symbols = center_non_ascii_glyphs(
        base,
        cell_width,
        only_codepoints=apple_codepoints,
    )

    sanitized_flags = sanitize_glyph_flags(base)
    sync_glyph_order(base)
    set_name(base, family_name, "Regular")

    if "DSIG" in base:
        del base["DSIG"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(output_path)

    if public_path is not None:
        public_path.parent.mkdir(parents=True, exist_ok=True)
        base.save(public_path)

    return {
        "cell_width": cell_width,
        "stack_from_cache": bool(stack_stats.get("from_cache")),
        "apple_imported": len(apple_codepoints),
        "replaced_ascii": replaced,
        "skipped_ascii": skipped,
        "swapped_codepoints": swapped_codepoints,
        "centered_symbols": centered_symbols,
        "sanitized_flags": sanitized_flags,
        "total_glyphs": len(base.getGlyphOrder()),
        "total_codepoints": len(base.getBestCmap()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--berkeley", type=Path, default=DEFAULT_BERKELEY)
    parser.add_argument("--jetbrains", type=Path, default=DEFAULT_JB)
    parser.add_argument("--apple", type=Path, default=DEFAULT_APPLE)
    parser.add_argument(
        "--symbols-cache",
        type=Path,
        default=DEFAULT_SYMBOLS_CACHE,
        help="Optional cache path for the JetBrains + Apple layer (written on rebuild)",
    )
    parser.add_argument(
        "--use-cache",
        action="store_true",
        help="Reuse --symbols-cache instead of rebuilding JetBrains + Apple",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--public", type=Path, default=DEFAULT_PUBLIC)
    parser.add_argument("--no-public", action="store_true")
    parser.add_argument("--family-name", default="Typehere Mono")
    args = parser.parse_args()

    public_path = None if args.no_public else args.public
    stats = merge_berkeley_trial(
        args.berkeley,
        args.output,
        jetbrains_path=args.jetbrains,
        apple_path=args.apple,
        symbols_cache=args.symbols_cache,
        use_cache=args.use_cache,
        family_name=args.family_name,
        public_path=public_path,
    )

    print(f"Wrote {args.output}")
    if public_path is not None:
        print(f"Copied to {public_path}")
    print(f"Family name: {args.family_name}")
    print(f"Stack source: {'cache' if stats['stack_from_cache'] else 'JetBrains + Apple rebuild'}")
    print(f"Apple fill-in codepoints: {stats['apple_imported']}")
    print(f"Cell width: {stats['cell_width']}")
    print(f"Replaced ASCII glyphs: {stats['replaced_ascii']}")
    print(f"Skipped ASCII codepoints: {stats['skipped_ascii']}")
    if stats["swapped_codepoints"]:
        pairs = ", ".join(
            f"U+{a:04X}↔U+{b:04X}" for a, b in stats["swapped_codepoints"]
        )
        print(f"Swapped cmap codepoints: {pairs}")
    print(f"Centered Apple symbol glyphs: {stats['centered_symbols']}")
    print(f"Sanitized glyph flags: {stats['sanitized_flags']}")
    print(f"Total glyphs: {stats['total_glyphs']}")
    print(f"Total mapped codepoints: {stats['total_codepoints']}")


if __name__ == "__main__":
    main()
