#!/usr/bin/env python3
"""Overlay Berkeley Mono Trial ASCII onto Typehere Mono symbol coverage.

Berkeley Trial ships ASCII 32-126 only. This script keeps the merged Apple/JetBrains
symbol glyphs from an existing Typehere Mono build and replaces ASCII with Berkeley
Trial outlines and metrics.

Local preview only — Berkeley Trial is not licensed for redistribution.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from merge_typehere_mono import (  # noqa: E402
    add_cmap_entry,
    import_glyph,
    merge_fonts,
    normalize_existing_metrics,
    reference_y_center,
    set_name,
    sync_glyph_order,
)

DEFAULT_BERKELEY = Path.home() / (
    "Downloads/berkeley-mono/2605231KV334Q57Z/TX-02-Z2XX0Q57/BerkeleyMonoTrial-Regular.otf"
)
DEFAULT_SYMBOLS = Path(__file__).resolve().parents[1] / "public/TypehereMono-Regular.ttf"
DEFAULT_JB = Path("/tmp/JetBrainsMono-Regular.ttf")
DEFAULT_APPLE = Path("/System/Library/Fonts/Apple Symbols.ttf")
DEFAULT_OUT = Path.home() / "Library/Fonts/TypehereMono-Regular.ttf"
DEFAULT_PUBLIC = Path(__file__).resolve().parents[1] / "public/TypehereMono-Regular.ttf"


def resolve_symbols_font(
    symbols_path: Path,
    jetbrains_path: Path,
    apple_path: Path,
    rebuild: bool,
) -> TTFont:
    if rebuild or not symbols_path.exists():
        temp = symbols_path.with_suffix(".rebuild.ttf")
        merge_fonts(jetbrains_path, apple_path, temp)
        return TTFont(temp)
    return TTFont(symbols_path)


def merge_berkeley_trial(
    berkeley_path: Path,
    symbols_path: Path,
    output_path: Path,
    *,
    jetbrains_path: Path = DEFAULT_JB,
    apple_path: Path = Path("/System/Library/Fonts/Apple Symbols.ttf"),
    rebuild_symbols: bool = False,
    family_name: str = "Typehere Mono",
    public_path: Path | None = None,
) -> dict[str, int]:
    if not berkeley_path.exists():
        raise FileNotFoundError(f"Missing Berkeley Mono Trial: {berkeley_path}")

    base = resolve_symbols_font(symbols_path, jetbrains_path, apple_path, rebuild_symbols)
    berkeley = TTFont(berkeley_path)

    berkeley_cmap = berkeley.getBestCmap()
    if not berkeley_cmap:
        raise RuntimeError("Berkeley Mono Trial has no cmap entries")

    reference_cp = ord("X") if ord("X") in berkeley_cmap else min(berkeley_cmap)
    cell_width = berkeley["hmtx"][berkeley_cmap[reference_cp]][0]
    upm_scale = base["head"].unitsPerEm / berkeley["head"].unitsPerEm
    y_center = reference_y_center(berkeley)

    replaced = 0
    skipped = 0
    for codepoint, donor_glyph_name in sorted(berkeley_cmap.items()):
        new_name = import_glyph(
            base,
            berkeley,
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
        replaced += 1

    normalize_existing_metrics(base, cell_width)
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
        "replaced_ascii": replaced,
        "skipped_ascii": skipped,
        "total_glyphs": len(base.getGlyphOrder()),
        "total_codepoints": len(base.getBestCmap()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--berkeley", type=Path, default=DEFAULT_BERKELEY)
    parser.add_argument("--symbols", type=Path, default=DEFAULT_SYMBOLS)
    parser.add_argument("--jetbrains", type=Path, default=DEFAULT_JB)
    parser.add_argument("--apple", type=Path, default=DEFAULT_APPLE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--public", type=Path, default=DEFAULT_PUBLIC)
    parser.add_argument("--no-public", action="store_true")
    parser.add_argument("--rebuild-symbols", action="store_true")
    parser.add_argument("--family-name", default="Typehere Mono")
    args = parser.parse_args()

    public_path = None if args.no_public else args.public
    stats = merge_berkeley_trial(
        args.berkeley,
        args.symbols,
        args.output,
        jetbrains_path=args.jetbrains,
        apple_path=args.apple,
        rebuild_symbols=args.rebuild_symbols,
        family_name=args.family_name,
        public_path=public_path,
    )

    print(f"Wrote {args.output}")
    if public_path is not None:
        print(f"Copied to {public_path}")
    print(f"Family name: {args.family_name}")
    print(f"Cell width: {stats['cell_width']}")
    print(f"Replaced ASCII glyphs: {stats['replaced_ascii']}")
    print(f"Skipped ASCII codepoints: {stats['skipped_ascii']}")
    print(f"Total glyphs: {stats['total_glyphs']}")
    print(f"Total mapped codepoints: {stats['total_codepoints']}")


if __name__ == "__main__":
    main()
