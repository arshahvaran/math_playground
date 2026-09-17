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

/**
 * The px value of a `min(0px, calc((<size> - <floor>) / 2))` hit-target
 * extension for a given visual key size. Written out rather than run through
 * px(), which sums: this is the one expression in the file that subtracts.
 */
function deficit(expression: string, keySize: string): number {
  const term = String.raw`var\(--[a-z0-9-]+\)`;
  const parts = new RegExp(
    String.raw`calc\(\s*\(\s*(${term})\s*-\s*(${term})\s*\)\s*/\s*2\s*\)`,
  ).exec(expression);
  if (!parts?.[1] || !parts[2]) throw new Error(`theme.test: not a deficit: ${expression}`);
  return Math.min(0, (px(keySize) - px(parts[2])) / 2);
}

const narrow = blocks(RULES, NARROW).join('\n');
const transport = rule(narrow, '.transport');

/** The token block, whose values several media queries deliberately restate. */
const root = blocks(RULES, ':root')[0] ?? '';

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

  /**
   * The three clearances above are all calc()s of --deck-h, which is only true
   * arithmetic while the deck IS --deck-h. It is a wrapping flex row, and a
   * second line does not make the deck taller — the deck's height is fixed, so
   * the second line is painted below it, outside the lit panel and over the
   * plate. Measured at 360 px: the six controls wanted exactly the 328 px of
   * content box they had, and the speed picker lost the tie by a sub-pixel and
   * sat 33 px under the deck's bottom edge.
   *
   * A row that cannot wrap cannot leave. Where the controls genuinely do not
   * fit — 320 px, or any width once the reader enlarges the text — it scrolls,
   * which keeps the height equal to the token at every text size instead of
   * only at the default one.
   */
  it('is one row that cannot wrap, so nothing is ever painted outside it', () => {
    expect(decl(transport, 'flex-wrap')).toBe('nowrap');
    expect(decl(transport, 'overflow-x')).toBe('auto');
    expect(decl(transport, 'height')).toBe('var(--deck-h)');
  });

  it('leaves the focus ring room inside the clip edge that scrolling creates', () => {
    // `overflow` clips at the padding box, so the deck's own inline padding is
    // now the only clearance the first and last control's outline has.
    expect(px(decl(transport, 'padding-inline'))).toBeGreaterThanOrEqual(ringPx);
  });
});

/**
 * The bench is `minmax(0, 1fr)` beside the rail, and the rail's width is rem
 * while the breakpoint that would stack the two is a media query. Those do not
 * measure the same thing: `rem` in a media query is the reader's DEFAULT font
 * size and `rem` in a declaration is the root's CURRENT one, so enlarging text
 * past the default grows the track without moving the breakpoint. Measured at
 * 1024 px and 200 % text, before the cap: rail 768 px of a 961 px bench, figure
 * 97 px, stage 65 px; at 224 % the figure reaches zero and the canvas backing
 * store rounds to one device pixel.
 *
 * A percentage is the one unit that cannot desync, because it is measured on
 * the bench itself.
 */
describe('the bench cannot starve the figure column', () => {
  const tracks = decl(rule(RULES, '.bench'), 'grid-template-columns');
  const share = Number(/,\s*(\d+(?:\.\d+)?)%\s*\)/.exec(tracks)?.[1] ?? NaN);

  it('caps the rail track as a fraction of the bench, not in rem alone', () => {
    expect(tracks).toMatch(/min\(\s*var\(--rail-w\)\s*,\s*\d+(?:\.\d+)?%\s*\)/);
  });

  it('leaves the figure the majority of the row at every text size', () => {
    expect(share).toBeLessThan(50);
  });

  it('does not bind at the default text size, so the desktop bench is unchanged', () => {
    // The tightest two-column case: the 1024 px viewport the breakpoint opens
    // at, less a 15 px classic scrollbar and the two gutters the bench pays.
    const bench = 1024 - 15 - 2 * px(decl(root, '--gutter'));
    expect((bench * share) / 100).toBeGreaterThanOrEqual(px(decl(root, '--rail-w')));
    // And again where --rail-w rises to --rail-w-wide, at 90rem.
    const wide = 90 * ROOT_FONT_PX - 15 - 2 * px('2.5rem');
    expect((wide * share) / 100).toBeGreaterThanOrEqual(px(token('--rail-w-wide')));
  });
});

/**
 * The title and the blurb shared a baseline row from `min-width: 64rem` of
 * VIEWPORT — a question only the figure column and this tab's title can answer.
 * The title's track was `auto` and the blurb's was `minmax(0, 1fr)`, which is
 * allowed to reach zero, so a long title took the whole column: measured on
 * Diffusion-Limited Aggregation the blurb's track was 0 px at 1024, 51 px at
 * 1100 and 135 px at 1200, and one word per line made the head 565 / 539 /
 * 227 px tall with the plate below the fold at every one of them.
 *
 * A wrapping flex line cannot starve anything, because an item whose basis will
 * not fit moves to the next line and is full width there.
 */
describe('the figure head', () => {
  const head = rule(RULES, '.figure__head');

  it('breaks the line instead of starving a track', () => {
    expect(decl(head, 'display')).toBe('flex');
    expect(decl(head, 'flex-wrap')).toBe('wrap');
    expect(decl(rule(RULES, '.figure__blurb'), 'flex')).toBe('1 1 var(--blurb-min)');
    expect(decl(root, '--blurb-min')).toMatch(/^\d+(?:\.\d+)?ch$/);
  });

  it('is never laid out by a viewport breakpoint again', () => {
    for (const body of blocks(RULES, '@media')) {
      expect(body).not.toMatch(/\.figure__head\s*\{[^{}]*(?:display|grid-template-columns)\s*:/);
    }
  });

  /**
   * `anywhere` and not `break-word`: the two break identically at layout time,
   * but only `anywhere` lowers the MIN-CONTENT size, and a flex item's
   * automatic minimum is its min-content size. With break-word the title still
   * floored its own flex line at the width of "Aggregation" — 363 px at 200 %
   * text against a 288 px column — and took the whole document sideways with
   * it, deck included. Measured: the first version of this line did nothing.
   */
  it('lets a long word break before it widens the document', () => {
    expect(decl(rule(RULES, '.figure__title'), 'overflow-wrap')).toBe('anywhere');
  });
});

/**
 * A transparent ::after is how a 30 px key buys a 44 px target. A CONSTANT one
 * is 14 px of invisible box in both axes around a key that, on a coarse pointer
 * and on a handheld, is already 44 px — where the overhang is at once useless
 * and expensive, because an absolutely positioned box contributes to the
 * document's scrollable overflow and the page then scrolls sideways.
 */
describe('hit-target extensions', () => {
  it('reaches 44 px from the ink and stops there', () => {
    const extend = decl(root, '--hit-extend');
    const mouse = px('1.875rem'); // --key-s at rest
    expect(mouse - 2 * deficit(extend, '1.875rem')).toBe(px(token('--key-h-touch')));
    // The two blocks that raise --key-s to the touch size take it to nothing.
    expect(deficit(extend, '2.75rem')).toBe(0);
  });

  it('does the same for the 32 px key, in the block axis only', () => {
    const small = rule(RULES, '.key--small::after');
    expect(px('2rem') - 2 * deficit(decl(root, '--hit-extend-small'), '2rem')).toBe(
      px(token('--key-h-touch')),
    );
    expect(decl(small, 'inset-block')).toBe('var(--hit-extend-small)');
    // Nothing reaches out on the axis the page edge is on; the floor for a key
    // that is ever narrower than its target lives on the ::after, so it cannot
    // overrule the width .share__key reserves for its two labels.
    expect(decl(small, 'inset-inline')).toBe('0');
    expect(decl(small, 'min-width')).toBe('var(--key-h-touch)');
  });

  it('never writes a constant overhang anywhere in the file', () => {
    expect(RULES).not.toMatch(/inset(?:-block|-inline)?:\s*-/);
  });
});

/**
 * Everything here is one defect: a box sized in rem inside a row sized by the
 * viewport. At 200 % text on a 360 px phone the wordmark measured 375 px, the
 * ledger's value column 352 px in a 328 px row, and the fader's end numeral
 * hung 44 px into a 32 px gutter. Any one of them widens the DOCUMENT, and on a
 * mobile viewport a document wider than the screen widens the LAYOUT VIEWPORT,
 * which is what stretched the fixed transport deck to 568 px inside a 360 px
 * screen — the deck was the symptom, never the cause.
 */
describe('nothing outruns the phone it is on', () => {
  it('caps the ledger value column against the row rather than in rem alone', () => {
    expect(decl(rule(narrow, '.readout'), 'grid-template-columns')).toMatch(
      /min\(\s*11rem\s*,\s*calc\(\s*100%\s*-\s*\d+ch\s*\)\s*\)/,
    );
  });

  it('lets the masthead wrap rather than push the wordmark off the screen', () => {
    expect(rule(RULES, '.masthead__wordmark')).not.toMatch(/white-space:\s*nowrap/);
    expect(decl(rule(RULES, '.masthead'), 'flex-wrap')).toBe('wrap');
  });

  it('caps the fader end numerals at the gutter they hang into', () => {
    expect(decl(rule(RULES, '.control__max'), 'transform')).toBe(
      'translateX(min(50%, var(--gutter)))',
    );
    expect(decl(rule(RULES, '.control__min'), 'transform')).toBe(
      'translateX(max(-50%, calc(-1 * var(--gutter))))',
    );
  });

  /**
   * The cap above bounds how far a numeral is MOVED, which is not the same as
   * bounding where it ENDS UP: one wider than the slot left for it already
   * overflows the scale row before any transform applies, and the translate
   * then carries that overshoot off the page. Measured on the Lorenz gap fader
   * at 320 px with 200 % text — "0.001" is 67 px in a 26 px slot, right edge at
   * 329 px inside a 320 px viewport, 9 px of sideways document.
   *
   * `clip` is what closes it rather than a wider cap, because clipped overflow
   * never contributes to the scrollable area at all. No label, at any length or
   * text size, can widen the document through this row — and the clip margin
   * keeps the deliberate one gutter of hang.
   */
  it('lets the end numerals hang into the gutter without widening the document', () => {
    const scale = rule(RULES, '.control__scale');
    expect(decl(scale, 'overflow')).toBe('clip');
    expect(decl(scale, 'overflow-clip-margin')).toBe('var(--gutter)');
    // `hidden` would also stop the overflow, and would make the row a scroll
    // container — which reintroduces the sideways scroll one level down.
    expect(decl(scale, 'overflow')).not.toBe('hidden');
  });
});

/**
 * A container query whose named container is not on the element's ancestor
 * chain matches nothing, silently. This one named the rail, and the shell has
 * moved the control form in and out of the rail; while it was out, a 204 px
 * label column and a 211 px stepper were still being asked to share a 288 px
 * row on a 320 px phone at 150 % text, and the stepper's own tracks hung 132 px
 * past the screen. The row is what the question is about, so the row is the
 * container — and it answers wherever the shell puts it.
 */
describe('the control rows restack by their own width', () => {
  it('names the container the rows themselves carry', () => {
    expect(decl(rule(RULES, '.controls'), 'container-name')).toBe('controls');
    expect(decl(rule(RULES, '.controls'), 'container-type')).toBe('inline-size');
  });

  it('queries no container an ancestor might not be', () => {
    expect(RULES).toMatch(/@container\s+controls\s+\(max-width/);
    expect(RULES).not.toMatch(/@container\s+rail\b/);
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
