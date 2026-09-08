/**
 * Element construction, and the one typographic decision every mono cell shares.
 *
 * `innerHTML` with interpolated data is banned project-wide: a fact, a caption
 * or a parameter label is data, and the moment it is parsed as markup the whole
 * page is one apostrophe away from a broken document. Everything the shell
 * renders is therefore built here, from `document.createElement`, with text
 * arriving as text nodes.
 *
 * Nothing in this module touches the DOM at import time, so it is safe to import
 * from a test running in a node environment.
 */

import type { Prose } from '../core/types';

/**
 * An attribute value. A function is an event listener and is bound with
 * `addEventListener` (see `h`); `true` writes a boolean attribute; `null`,
 * `undefined` and `false` write nothing at all.
 */
type AttrValue = string | number | boolean | EventListener | null | undefined;

export type Attrs = Readonly<Record<string, AttrValue>>;

/** `null`, `undefined` and `false` are skipped, so `cond && node` is an idiom. */
export type Child = Node | string | number | false | null | undefined;

/**
 * Build an HTML element.
 *
 * `h('button', { class: 'key', type: 'button', onclick: run }, 'Play')`
 *
 * Keys are written verbatim as attributes — `class`, `for`, `role`, `aria-*`,
 * `data-*` and the rest — except keys beginning with `on`, which are bound as
 * listeners for the lower-cased remainder of the name. Listeners are never
 * assigned as attributes: an `onclick` attribute is evaluated as source text,
 * which is exactly the hole this module exists to close.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an SVG element.
 *
 * SVG needs its own namespace — `createElement('path')` produces an unknown HTML
 * element that renders nothing — and the transport's glyphs are inline SVG
 * (DESIGN §5: solid `fill: currentColor` shapes, no icon library, no stroked
 * round-capped chevrons), so the alternative would have been `innerHTML`.
 */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: readonly Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (value === true) {
      el.setAttribute(key, '');
      continue;
    }
    el.setAttribute(key, String(value));
  }
}

function appendChildren(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
}

/** Remove every child. Detaching the nodes drops their listeners with them. */
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// Prose (DESIGN §2)
// ---------------------------------------------------------------------------

/**
 * Render a sentence, with its variables and Greek letters in `<var>`.
 *
 * §2 makes this a rule of the type system rather than of the copy: `n`, `p`,
 * `π`, `μ` and `σ` are Archivo italic 400 wherever the shell composes text, so
 * `N(n·p, n·p·(1−p))` cannot be mistaken for four English words. `<var>` is the
 * element for it, and `theme.css` styles nothing else that way.
 *
 * A plain string is one upright run — the common case, and no allocation beyond
 * the text node. `innerHTML` is not an option here for the reason the whole
 * module exists: a caption is data.
 */
export function prose(content: Prose): Node[] {
  if (typeof content === 'string') return [document.createTextNode(content)];
  return content.map((segment) =>
    typeof segment === 'string'
      ? document.createTextNode(segment)
      : (h('var', null, segment.v) as Node),
  );
}

/** Replace an element's children with rendered prose. */
export function setProse(el: Element, content: Prose): void {
  clear(el);
  el.append(...prose(content));
}

/**
 * The same sentence as flat text — for an `aria-label`, a `title`, or any
 * comparison. The markup carries no meaning a reader loses here: a `<var>` is
 * an italic, and a screen reader announces its contents either way.
 */
export function proseText(content: Prose | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((segment) => (typeof segment === 'string' ? segment : segment.v)).join('');
}

// ---------------------------------------------------------------------------
// The minus sign (DESIGN §2)
// ---------------------------------------------------------------------------

const HYPHEN = '-';
const MINUS = '−';

/** Re-measuring on every formatted number costs a style read; once a frame is plenty. */
const RETRY_MS = 250;

let decided: string | null = null;
let nextAttempt = 0;

/**
 * The minus sign for Martian Mono cells — U+2212 where the face carries it at
 * the digit advance, U+002D otherwise.
 *
 * The ledger, the hero and every fader window are one column of tabular figures.
 * A U+2212 the face does not ship falls back to another family mid-column and
 * measures differently, so a single row's error value would sit a fraction of a
 * character off every other row — worse than a hyphen. §2 therefore fixes the
 * sign once for the document.
 *
 * "Once" has to mean *once the face is loaded*, not once the first number is
 * formatted. Measured cold, the whole stack resolves to Consolas, where U+2212
 * exists and is metric-compatible — an answer that is right for the fallback and
 * wrong for the face arriving a moment later. So an undecidable measurement
 * yields a hyphen without committing to it, and the answer is settled and cached
 * on the first call after Martian Mono lands. In practice the ledger rewrites at
 * 10 Hz and picks the real sign up within a frame or two of the font.
 */
export function monoMinus(): string {
  if (decided !== null) return decided;
  const now = typeof performance === 'object' ? performance.now() : Date.now();
  if (now < nextAttempt) return HYPHEN;
  nextAttempt = now + RETRY_MS;
  const answer = decideMinus();
  if (answer !== null) decided = answer;
  return answer ?? HYPHEN;
}

/** `null` means "the face is not here yet, ask again"; a string is final. */
function decideMinus(): string | null {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return HYPHEN;
  try {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    if (!stack) return HYPHEN;
    const primary = (stack.split(',')[0] ?? '').trim();
    if (!primary) return HYPHEN;
    const fonts = document.fonts;
    // `check()` on the first family alone: asking the whole stack answers "yes"
    // for Consolas and tells us nothing about the webfont.
    if (fonts && typeof fonts.check === 'function' && !fonts.check(`500 16px ${primary}`)) return null;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return HYPHEN;
    // Measured against the full stack, because per-glyph fallback — a missing
    // U+2212 silently drawn from the next family — is exactly what is detected.
    ctx.font = `500 16px ${stack}`;
    return ctx.measureText(MINUS).width === ctx.measureText('0').width ? MINUS : HYPHEN;
  } catch {
    // A font shorthand the parser refuses, or a host with no canvas.
    return HYPHEN;
  }
}

/**
 * Re-sign a formatted number: `fmt()` emits U+002D, mono cells may want U+2212.
 * Every hyphen goes, exponent included — one cell, one sign.
 */
export function withMinus(text: string): string {
  const sign = monoMinus();
  return sign === HYPHEN ? text : text.replaceAll(HYPHEN, sign);
}
