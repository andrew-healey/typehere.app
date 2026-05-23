#!/usr/bin/env node
/**
 * Merge two typehere export files without losing notes from either side.
 *
 * Export files are LZ-compressed (same format as Cmd-K / menu "export notes").
 *
 * Usage:
 *   pnpm node scripts/merge-notes-export.mjs local.json prod.json > merged.json
 *   pnpm node scripts/merge-notes-export.mjs local.json prod.json -o merged.json
 *
 * Then import merged.json on http://localhost:5173 via Cmd-K → import notes.
 * (Built-in import replaces the whole notes database, so export local first as backup.)
 */

import { readFileSync, writeFileSync } from "node:fs";
import LZString from "lz-string";

function usage() {
  console.error(`Usage: merge-notes-export.mjs <local-export.json> <prod-export.json> [-o out.json]`);
  process.exit(1);
}

function loadNotes(path) {
  const raw = readFileSync(path, "utf8").trim();
  const json =
    raw.startsWith("[") || raw.startsWith("{")
      ? raw
      : LZString.decompressFromEncodedURIComponent(raw);
  if (!json) {
    throw new Error(`Could not decompress ${path} (expected typehere export format)`);
  }
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} did not contain a notes array`);
  }
  return parsed;
}

function mergeNotes(localNotes, prodNotes) {
  const byId = new Map(localNotes.map((note) => [note.id, note]));

  for (const note of prodNotes) {
    if (!byId.has(note.id)) {
      byId.set(note.id, note);
      continue;
    }

    const existing = byId.get(note.id);
    const sameContent =
      existing.content === note.content &&
      existing.updatedAt === note.updatedAt &&
      existing.workspace === note.workspace;

    if (sameContent) continue;

    const imported = {
      ...note,
      id: Math.random().toString(36).slice(2),
    };
    byId.set(imported.id, imported);
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const outIndex = args.indexOf("-o");
const outPath = outIndex === -1 ? null : args[outIndex + 1];
const inputs = outIndex === -1 ? args : args.filter((_, i) => i !== outIndex && i !== outIndex + 1);

if (inputs.length !== 2) usage();

const merged = mergeNotes(loadNotes(inputs[0]), loadNotes(inputs[1]));
const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(merged));

if (outPath) {
  writeFileSync(outPath, compressed, "utf8");
  console.error(`Wrote ${merged.length} notes to ${outPath}`);
} else {
  process.stdout.write(compressed);
}
