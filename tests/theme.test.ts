import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The handheld deck, and the room the page has to leave for it.
 *
 * Below 600 px the transport leaves the flow and floats over the bottom of the
 * page on an opaque --surface-raised. A stylesheet cannot be asked whether a
 * focused control is visible, but it can be asked whether the page reserves
 * room for the deck, and that is the whole of the defect: the browser's "scroll
 * an element into view" — the step that runs when Tab moves focus — stops at
 * the scrollport edge unless scroll-padding says otherwise, so it will happily
 * leave a control, and its focus ring, under 64 px of deck. WCAG 2.4.11.
 *
 * What is checked is the arithmetic that has to hold across three rules written
 * far apart: the deck's own footprint, the root's scroll-padding, and the
 * body's end-of-page padding. Raising --deck-h or the deck's inset without
 * raising the other two fails here rather than on a phone.
 *
 * The last case pins --viz-aspect-narrow as READ. shell.ts writes it from
 * `Viz.aspectNarrow`; a custom property nothing consumes is inert, and the
 * failure mode is silent — a portrait experiment simply stays letterboxed.
 */

const CSS = readFileSync(fileURLToPath(new URL('../src/ui/theme.css', import.meta.url)), 'utf8');

/** Rules are read from a comment-free copy: every block here carries a note. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The handheld breakpoint, 599.9375 px. Written twice: tokens, then layout. */
const NARROW = '@media (max-width: 37.4375rem)';

/** The tokens are authored in rem against the default root size. */
const ROOT_FONT_PX = 16;

/** Bodies of every block with this header, brace-matched so nesting is kept. */
function blocks(source: string, header: string): string[] {
  const found: string[] = [];
  for (let from = 0; ; ) {
    const start = source.indexOf(header, from);
    if (start < 0) return found;
    const open = source.indexOf('{', start + header.length);
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    found.push(source.slice(open + 1, i));
    from = i + 1;
  }
}

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`theme.test: no rule for "${selector}"`);
  return match[1];
}

/** One declaration's value, comments stripped. */
function decl(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body);
  if (!match?.[1]) throw new Error(`theme.test: no "${property}" in ${body.trim()}`);
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** A token's value. Declared twice means the resolution below is a guess. */
function token(name: string): string {
  const hits = [...CSS.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))];
  if (hits.length !== 1) throw new Error(`theme.test: ${name} declared ${hits.length} times`);
  const value = hits[0]?.[1];
  if (value === undefined) throw new Error(`theme.test: ${name} has no value`);
  return value.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/**
 * A `calc()` sum of lengths and tokens, in px. The home indicator resolves to
 * its 0 px fallback: that is the desktop and Android case, and it is the LOWER
 * bound of the notched one, since every measurement here adds the same inset.
 */
function px(expression: string): number {
  let flat = expression.replace(/env\(\s*safe-area-inset-bottom\s*,\s*0px\s*\)/g, '0px');
  for (let pass = 0; flat.includes('var(') && pass < 4; pass++) {
    flat = flat.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => token(name));
  }
  flat = flat.replace(/calc\(|\)/g, '');
  let total = 0;
  for (const term of flat.split('+')) {
    const match = /^\s*(-?\d*\.?\d+)(px|rem)?\s*$/.exec(term);
    if (!match?.[1]) throw new Error(`theme.test: cannot resolve "${term}" of "${expression}"`);
    total += Number(match[1]) * (match[2] === 'rem' ? ROOT_FONT_PX : 1);
  }
  return total;
}

const narrow = blocks(RULES, NARROW).join('\n');
const transport = rule(narrow, '.transport');

/** How far up the viewport the deck reaches: its height plus its own inset. */
const deckPx = px(decl(transport, 'height')) + px(decl(transport, 'bottom'));

/** The ring is drawn OUTSIDE the control, so it needs clearance of its own. */
const ringPx = px(token('--focus-offset')) + px(token('--focus-ring').split(/\s+/)[0] ?? '0');

describe('handheld transport deck', () => {
  it('floats over the page, which is what makes the two clearances load-bearing', () => {
    expect(transport).toMatch(/position:\s*fixed/);
    expect(deckPx).toBeGreaterThan(0);
  });

  it('reserves scroll-padding, so focus is never scrolled to under the deck', () => {
    const pad = px(decl(rule(narrow, 'html'), 'scroll-padding-bottom'));
    expect(pad).toBeGreaterThanOrEqual(deckPx + ringPx);
  });

  it('ends the page above the deck, so the LAST control can still clear it', () => {
    const pad = px(decl(rule(narrow, 'body'), 'padding-bottom'));
    expect(pad).toBeGreaterThanOrEqual(deckPx + ringPx);
  });

  it('carries the home indicator through every one of the three', () => {
    const inset = /env\(\s*safe-area-inset-bottom/;
    expect(decl(transport, 'bottom')).toMatch(inset);
    expect(decl(rule(narrow, 'html'), 'scroll-padding-bottom')).toMatch(inset);
    expect(decl(rule(narrow, 'body'), 'padding-bottom')).toMatch(inset);
  });
});

describe('narrow aspect', () => {
  it('reads --viz-aspect-narrow, falling back to the registered --viz-aspect', () => {
    expect(decl(rule(narrow, '.stage'), '--stage-aspect')).toBe(
      'var(--viz-aspect-narrow, var(--viz-aspect))',
    );
    // Unregistered on purpose: a registered property has an initial value, and
    // the var() above would then never reach its fallback.
    expect(RULES).not.toMatch(/@property\s+--viz-aspect-narrow/);
  });
});
