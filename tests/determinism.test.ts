import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Math.random ban.
 *
 * Permalinks and every convergence test rest on one property: a run is a pure
 * function of (seed, parameters). One stray `Math.random()` in a visualization
 * breaks it silently, so this is enforced by the suite rather than by review.
 *
 * Two levels of strictness. Under src/viz/ the string may not appear at all —
 * not even in a comment — matching the `grep -rn "Math.random" src/viz/` line
 * of the Definition of Done. Under src/ as a whole, comments are stripped and
 * the remaining uses must be exactly one: `randomSeed()` in core/rng.ts, which
 * exists to seed the seeded stream for the "randomize" button.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const VIZ = join(SRC, 'viz');

const BANNED = 'Math.random';

/** Every source file under `dir`, depth-first, sorted. A missing directory yields none. */
function sourceFilesUnder(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Repo-relative, forward slashes on every platform, so failure messages match the grep. */
function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

/**
 * Blank out `//` and `/* *\/` comments while preserving line numbers, so a
 * doc comment that *mentions* the ban is not counted as breaking it. Good
 * enough for this codebase: no string literal here contains a comment marker.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

/** `file:line` for every line of `text` containing the banned string. */
function occurrences(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(BANNED)) hits.push(`${rel(file)}:${i + 1}`);
  });
  return hits;
}

describe('Math.random ban', () => {
  it('never appears under src/viz/, not even in a comment', () => {
    const hits = sourceFilesUnder(VIZ).flatMap((file) => occurrences(file, readFileSync(file, 'utf8')));
    expect(
      hits,
      `Math.random is banned in src/viz/ — draw from ctx.rng instead. Found at:\n  ${hits.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is used exactly once under src/, by randomSeed() in core/rng.ts', () => {
    const uses = sourceFilesUnder(SRC).flatMap((file) =>
      occurrences(file, stripComments(readFileSync(file, 'utf8'))),
    );
    const message = `Only core/rng.ts may call Math.random, and only once. Found at:\n  ${uses.join('\n  ')}`;
    expect(uses, message).toHaveLength(1);
    expect(uses[0], message).toMatch(/^src\/core\/rng\.ts:\d+$/);
  });
});
