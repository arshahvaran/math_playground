import { onMediaChange } from '../core/canvas';
import type { Viz, VizGroup } from '../core/types';
import { h, svg, type Attrs } from './dom';
import { createPressGuard, isPrimaryPress } from './transport';

/**
 * The bench.
 *
 * Everything on the page that is not a visualization: the masthead with its
 * scheme toggle, the tab strip, the figure/rail lattice the components mount
 * into, and a one-line footer.
 *
 * It is deliberately sparse. A visitor with no statistics should be able to
 * read every word on the page, so the chrome is the wordmark, the tabs, the
 * title and its one-sentence blurb, the plate, the readouts, the controls and a
 * footer line. The author, the affiliation, the figure number and the parameter
 * caption all went; the tab strip is the navigation, and it is genuinely
 * navigable at every width — see `syncStrip()`.
 *
 * The shell is built once and reused for every route. It knows the registry —
 * titles, groups — and nothing else about any visualization: no branch here
 * reads an `id`. Adding a tab is a registry line, and adding a *group* is one
 * more entry in the group union, because the run label is derived from the
 * group name rather than looked up in a table only this file knows about.
 *
 * State classes the CSS already derives are never written here: the active tab
 * is `aria-selected` alone (there is no `.tab--active`), and the transport's
 * running rule is `data-running` alone.
 */

// ---------------------------------------------------------------------------
// Fixed content
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/arshahvaran/math_playground';
const LICENCE_URL = 'https://creativecommons.org/licenses/by-nc/4.0/';
const AUTHOR = 'Ali Reza Shahvaran';

/** Namespaced so a sibling project on the same Pages origin cannot collide. */
const SCHEME_KEY = 'mp:scheme';

/**
 * The two-column breakpoint, mirroring theme.css §15. Below it the bench is a
 * single stack and the rail's keys are painted between the plate and the
 * readouts, so the DOM has to be restacked to match — see `restack()`. The
 * number lives in both files because a media query cannot be read back out of a
 * stylesheet; theme.css is the one that decides.
 */
const BENCH_STACK_QUERY = '(max-width: 63.9375rem)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// ---------------------------------------------------------------------------
// Tab strip motion
// ---------------------------------------------------------------------------

/**
 * How much of the visible strip one press of an arrow travels.
 *
 * Less than a whole page on purpose: a tab that was at the leading edge is
 * still on screen after the press, so the reader can see where the strip moved
 * to rather than being handed an entirely new set of labels.
 */
const ARROW_PAGE = 0.7;

/** How long an arrow must be held before the single page turns into a pan. */
const ARROW_HOLD_DELAY_MS = 280;

/** Pixels per repeat while an arrow is held, and the period between repeats. */
const ARROW_HOLD_STEP = 14;
const ARROW_HOLD_MS = 50;

/**
 * Pointer travel, in CSS px, past which a press on the strip is a pan rather
 * than a tab activation.
 *
 * A grab has to be allowed a little slop — a mouse moves one or two pixels
 * between press and release on almost every click — and a tab that changed the
 * route because the hand twitched is the worst possible answer here: the route
 * change coerces every parameter back to its default and throws the run away.
 */
const DRAG_SLOP = 6;

/** Clearance between a tab and the edge of the scrollport when it is revealed. */
const REVEAL_PAD = 12;

/** Sub-pixel scroll offsets are what a browser hands back; nothing is exact. */
const SCROLL_EPSILON = 1;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ShellRegions {
  /** The canvas host inside the plate. `createStage()` fills it. */
  stage: HTMLElement;
  /** `form.controls` — one `.control` row per `ParamSpec`. */
  controls: HTMLElement;
  /** `div.transport` — the shell owns `data-running`, the component owns the keys. */
  transport: HTMLElement;
  readouts: HTMLElement;
  story: HTMLElement;
  facts: HTMLElement;
  title: HTMLElement;
  blurb: HTMLElement;
}

export interface ShellHandle {
  regions: ShellRegions;
  /** Move the ball and the roving tabindex, and give the plate its shape. */
  setActiveTab(id: string): void;
  /**
   * Put the focus on the selected tab. For a route change that destroyed the
   * element the reader was in — otherwise the focus falls to `<body>`.
   */
  focusActiveTab(): void;
  /** Publish the current permalink: `data-permalink`, which print renders. */
  setPermalink(hash: string): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * An inline glyph: solid fills at 16 px, not a 1.5 px round-capped stroke —
 * that spec is the icon library's house style rebuilt by hand. The path data
 * is literal, never interpolated.
 */
function glyph(...paths: readonly Attrs[]): SVGSVGElement {
  return svg(
    'svg',
    { class: 'key__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    ...paths.map((attrs) => svg('path', attrs)),
  );
}

/**
 * The site mark: a plotter bed holding a peg lattice, the vermilion stream
 * entering it and the bell curve it leaves behind. The same figure as
 * `public/icon.svg`, which is what a reader already sees on the browser tab —
 * the geometry is duplicated because a favicon is fetched as a document and
 * cannot read a custom property, while this copy is drawn from the scheme's own
 * tokens and so inverts with the page.
 *
 * It is `aria-hidden`: the two words beside it already name the site, and a
 * second accessible name on the same link is one the reader has to disambiguate
 * for nothing.
 *
 * Simplified from the favicon it was taken from. That one carried three balls
 * and a four-hump scallop at 55 % opacity, which at 32 px is nine dots and a
 * smear; this is five pegs, one stream and one bell, and every mark in it is
 * opaque.
 */
function siteMark(): SVGSVGElement {
  const peg = (cx: number, cy: number): SVGCircleElement =>
    svg('circle', { class: 'masthead__mark-peg', cx, cy, r: 1.5 });

  return svg(
    'svg',
    { class: 'masthead__mark', viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' },
    // Inset by half the ring's width, so the ring is drawn inside the viewBox
    // rather than sliced in half by its edge.
    svg('rect', {
      class: 'masthead__mark-bed',
      x: 0.5,
      y: 0.5,
      width: 31,
      height: 31,
      rx: 6.5,
    }),
    peg(8, 11.5),
    peg(16, 11.5),
    peg(24, 11.5),
    peg(12, 17.5),
    peg(20, 17.5),
    // The floor the pile lands on. Without it the bell is a curve floating
    // between two pegs and a dot, and at 32 px that composition reads as a
    // face — two eyes, a nose and a mouth. A baseline under it makes it a
    // chart again, and it is the Galton board's own floor besides.
    svg('path', { class: 'masthead__mark-floor', d: 'M4.5 28h23', 'stroke-width': 1.4 }),
    // The stream entering on the centre line, the ball one bounce off it, and
    // the distribution the two of them add up to.
    svg('path', { class: 'masthead__mark-ink', d: 'M16 4v4.5', 'stroke-width': 2.4 }),
    svg('circle', { class: 'masthead__mark-ball', cx: 13.5, cy: 14.6, r: 1.5 }),
    svg('path', {
      class: 'masthead__mark-ink',
      d: 'M5 28C10 28 11 21 16 21s6 7 11 7',
      'stroke-width': 1.8,
    }),
  );
}

/** localStorage throws outright in some privacy modes; a missing preference is not an error. */
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preference is session-only. Nothing else depends on it persisting. */
  }
}

/**
 * "randomness" → "Randomness". The group no longer appears anywhere on screen —
 * the run labels that used to sit between the tabs are gone — but it is still
 * how the registry's pedagogical order is expressed, so each tab carries it in
 * its accessible name. Deriving the label from the group name is what keeps a
 * new group to a single entry in the union.
 */
function groupLabel(group: VizGroup): string {
  const words = group.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A permalink is absolute, so it survives being pasted anywhere. */
function absolutize(hash: string): string {
  const fragment = hash.startsWith('#') ? hash : `#${hash}`;
  if (typeof location === 'undefined') return fragment;
  const base = location.href.split('#')[0] ?? '';
  return `${base}${fragment}`;
}

/** A finite number, or `null`. Geometry a host does not implement reads as neither. */
function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// createShell
// ---------------------------------------------------------------------------

export function createShell(
  root: HTMLElement,
  vizList: readonly Viz[],
  onSelect: (id: string) => void,
  /**
   * The scheme on the page has changed. Optional because the shell is complete
   * without it — the page restyles itself either way; what needs telling is
   * whoever is holding a canvas, whose pens CSS cannot reach.
   */
  onSchemeChange?: () => void,
): ShellHandle {
  const cleanups: Array<() => void> = [];

  /** Bind a listener and register its removal, so `destroy()` cannot miss one. */
  function on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void {
    el.addEventListener(type, handler as EventListener);
    cleanups.push(() => el.removeEventListener(type, handler as EventListener));
  }

  /** The same, for a listener that has to outlive the element it started on. */
  function onGlobal(target: EventTarget | undefined, type: string, handler: EventListener): void {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }

  // -- masthead -------------------------------------------------------------

  const defaultId = vizList[0]?.id ?? '';

  const themeToggle = h('button', {
    class: 'key key--icon theme-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': 'Dark scheme',
    title: 'Dark scheme',
  });
  // A half-inked plate: the square is the bed, one half is filled.
  themeToggle.append(
    glyph(
      { d: 'M2 2h12v12H2z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' },
      { d: 'M8 2h6v12H8z' },
    ),
  );

  // The mark and the words are one link, not two elements side by side: the
  // lockup is what a reader aims at, and a logo beside a link that goes to the
  // same place is two targets for one destination. The words keep their own
  // element so the hover underline can belong to them alone.
  const wordmark = h(
    'a',
    { class: 'masthead__wordmark', href: `#/${defaultId}` },
    siteMark(),
    h('span', { class: 'masthead__name' }, 'Math Playground'),
  );

  const masthead = h('header', { class: 'masthead' }, wordmark, themeToggle);

  // -- selection ------------------------------------------------------------

  /** The visualization on screen, as `setActiveTab()` last reported it. */
  let activeViz: Viz | null = null;

  /** Its index in the registry, and the fallback the roving tabindex walks from. */
  let activeIndex = -1;

  /**
   * Ask for a visualization. Every path into the app — a tab, the wordmark —
   * comes through here.
   *
   * Re-selecting the visualization already on screen is a **no-op**. It is a
   * no-op in every tab widget, and here it would be the most destructive control
   * on the page: the shell answers a selection with `router.navigate(id)`, which
   * builds a bare `#/<id>` from an empty parameter map, and a route with no
   * query coerces every parameter back to its default — the run, the reader's
   * rows and bias and seed, and the permalink they were about to share, all
   * gone. The roving tabindex puts the *selected* tab first in the tab order, so
   * Enter on it is the natural gesture after tabbing into the strip.
   */
  function select(id: string): void {
    if (id === activeViz?.id) return;
    onSelect(id);
  }

  // The wordmark is a link so it reads and behaves as one, but a plain click on
  // it is the same selection as the first tab — including the no-op when that
  // visualization is already on screen. A modified click is left to the browser:
  // opening the link in a new tab is a request for the default route.
  on(wordmark, 'click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    select(defaultId);
  });

  // -- tab strip ------------------------------------------------------------

  const strip = h('div', {
    class: 'tabs__strip',
    role: 'tablist',
    'aria-label': 'Visualization tabs',
    'data-fade': 'none',
  });

  const tabs: HTMLButtonElement[] = [];

  // Flat, in registry order. The run labels that used to be interleaved here
  // ("Randomness", "Chaos") are gone: a chip that names a group is a word the
  // reader has to parse before reaching the only thing the strip is for, and it
  // was taking a quarter of the row on a phone. The grouping survives where it
  // is load-bearing — the order, and each tab's accessible name.
  for (const [index, viz] of vizList.entries()) {
    const tab = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${viz.id}`,
        'aria-controls': 'panel-viz',
        'aria-selected': 'false',
        'aria-label': `${viz.title}, ${groupLabel(viz.group)}`,
        'aria-setsize': String(vizList.length),
        'aria-posinset': String(index + 1),
        tabindex: '-1',
      },
      h('span', { class: 'tab__label' }, viz.title),
    );
    on(tab, 'click', () => {
      // The press that panned the strip must not also change the route.
      if (panned) return;
      select(viz.id);
    });
    tabs.push(tab);
    strip.append(tab);
  }

  const prevKey = arrowKey('prev', 'Scroll tabs left', 'M10.5 1.5 4 8l6.5 6.5z');
  const nextKey = arrowKey('next', 'Scroll tabs right', 'M5.5 1.5 12 8l-6.5 6.5z');

  function arrowKey(side: 'prev' | 'next', name: string, path: string): HTMLButtonElement {
    const key = h(
      'button',
      {
        class: `key key--icon tabs__arrow tabs__arrow--${side}`,
        type: 'button',
        'aria-label': name,
        title: name,
      },
      glyph({ d: path }),
    );
    // Nothing to scroll until the strip has been measured.
    key.hidden = true;
    return key;
  }

  const tabsNav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Visualizations' },
    prevKey,
    strip,
    nextKey,
  );

  // -- figure column --------------------------------------------------------

  const title = h('h1', { class: 'figure__title' });
  const blurb = h('p', { class: 'figure__blurb' });

  const stageHost = h('div', { class: 'stage' });
  const plate = h('div', { class: 'plate' }, stageHost);

  // The Share key is gone — the address bar already holds the permalink, and a
  // button that copies it was one more control to explain on every tab. The
  // link survives as an attribute so a printed page still names the run it
  // shows (theme.css §16c renders it; nothing paints it on screen).
  const permalink = h('div', { class: 'permalink', 'aria-hidden': 'true' });

  const readouts = h('section', { class: 'readouts', 'aria-label': 'Readouts' });
  const story = h('section', { class: 'story' });
  const fact = h('section', { class: 'fact' });

  const figure = h(
    'div',
    { class: 'figure' },
    h('header', { class: 'figure__head' }, title, blurb),
    plate,
    permalink,
    readouts,
    story,
    fact,
  );

  // -- rail -----------------------------------------------------------------

  const transport = h('div', {
    class: 'transport',
    role: 'group',
    'aria-label': 'Transport',
    'data-running': 'false',
  });
  const controls = h('form', { class: 'controls', 'aria-label': 'Controls' });
  // A generated panel has no submit control; Enter in a number field would
  // otherwise reload the page and lose the run.
  on(controls, 'submit', (event) => event.preventDefault());

  const railPanel = h('div', { class: 'rail__panel' }, transport, controls);
  // Above the breakpoint the rail holds the fact card and the footer line under
  // the panel; `restack()` puts them there. The rail was 444 px of content
  // beside a 1,300 px figure — 850 px of empty right-hand column, and a reader
  // scrolling the plate past it to reach the facts underneath.
  const rail = h('div', { class: 'rail' }, railPanel);

  // The tab widget's panel is the whole bench: the plate, the readouts and the
  // controls are all the selected visualization. Carrying `role="tabpanel"`
  // costs the `main` landmark, which is the cheaper of the two losses — a tab
  // that controls nothing is a broken widget, and the panel is still a named,
  // navigable region.
  const bench = h(
    'main',
    { class: 'bench', id: 'panel-viz', role: 'tabpanel' },
    figure,
    rail,
  );

  // -- footer ---------------------------------------------------------------

  // One quiet line. The two links are the only ones on the page besides the
  // fact sources that open a new tab: they leave the app.
  //
  // `role="contentinfo"` is stated rather than inherited. A <footer> maps to the
  // contentinfo landmark only while it is scoped to <body>, and above the
  // breakpoint this one lives in the rail, inside <main class="bench"> — where
  // HTML-AAM makes it a generic div and the landmark simply disappears. Stating
  // the role once, at construction, is what keeps the landmark the same at every
  // width: one that exists at 1,024 px and not at 1,023 is worse for a reader
  // who zooms than one that is honestly absent.
  //
  // The cost is named precisely: axe's `landmark-contentinfo-is-top-level` does
  // NOT fire here, because the <main> above it carries `role="tabpanel"` and so
  // is not a main landmark — what a conformance run flags is `aria-allowed-role`,
  // for a role stated on a <footer> that is not scoped to <body>. That flag is
  // accepted, and it is the same kind of trade the bench already makes by
  // carrying `role="tabpanel"` over its own `main`.
  const footer = h(
    'footer',
    { class: 'footer', role: 'contentinfo' },
    h('a', { class: 'footer__source', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source'),
    h('a', { href: LICENCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'CC BY-NC 4.0'),
    h('span', { class: 'footer__author' }, AUTHOR),
  );

  const page = h('div', { class: 'page' }, masthead, tabsNav, bench, footer);
  root.append(page);

  // -- scheme ---------------------------------------------------------------

  /**
   * The scheme the page opens in follows the reader's OS, and the masthead
   * toggle wins over it in both directions. Both values are written explicitly
   * so there is one source of truth for the attribute.
   *
   * Every scheme change in the app passes through here, which is why this is
   * where the canvas is told. A `<canvas>` keeps the pens it was painted with,
   * so CSS reaching the plate is not the same as the apparatus on it following.
   *
   * A *change*, though, and the scheme the page opens in is not one: there is
   * no plate yet when this first runs, and the first route reads the theme for
   * itself. Reporting it would also fire the callback from inside
   * `createShell()`, before the caller's own module bindings exist.
   */
  let schemeSettled = false;

  function applyScheme(dark: boolean): void {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggle.setAttribute('aria-pressed', String(dark));
    if (schemeSettled) onSchemeChange?.();
  }

  /**
   * The key's state is derived from the scheme actually on the plate, never
   * assumed.
   *
   * With no stored preference the effective scheme came from `color-scheme:
   * light dark` and the OS, while the button was built with a hard-coded
   * `aria-pressed="false"` and the click handler read the *next* state off that
   * attribute. On a dark OS the button therefore announced the dark scheme as
   * off while the page was dark, and the first press asked for the scheme
   * already showing — a dead key. Writing `data-theme` explicitly at startup, in
   * both directions, leaves one source of truth for the attribute and makes the
   * no-op press unrepresentable.
   */
  const darkQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const storedScheme = readStore(SCHEME_KEY);
  const chosen = storedScheme === 'dark' || storedScheme === 'light';
  applyScheme(chosen ? storedScheme === 'dark' : (darkQuery?.matches ?? false));
  schemeSettled = true;

  if (!chosen && darkQuery) {
    // Until the reader picks a scheme, the OS is still in charge and the page
    // has to follow it. The subscription is dropped on the first press.
    const unwatch = onMediaChange(darkQuery, () => applyScheme(darkQuery.matches));
    cleanups.push(unwatch);
    on(themeToggle, 'click', unwatch);
  }

  on(themeToggle, 'click', () => {
    const dark = themeToggle.getAttribute('aria-pressed') !== 'true';
    applyScheme(dark);
    writeStore(SCHEME_KEY, dark ? 'dark' : 'light');
  });

  const motionQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null;

  // -- the strip as a scrollport --------------------------------------------

  /**
   * The strip's scroll geometry, or `null` where the host does not implement
   * one. Everything below is written against that `null`: a document with no
   * layout — the test harness, a server render — simply has no arrows and no
   * fade rather than a thrown `undefined - undefined`.
   */
  function scrollport(): { left: number; max: number; width: number } | null {
    const width = finite(strip.clientWidth);
    const full = finite(strip.scrollWidth);
    const left = finite(strip.scrollLeft);
    if (width === null || full === null || left === null) return null;
    return { left, max: Math.max(0, full - width), width };
  }

  /**
   * Show each arrow only while there is something to scroll on its side, and
   * fade only the edge the strip actually runs past.
   *
   * The arrows take room in the row rather than floating over the tabs, which
   * makes this monotone and therefore stable: revealing one can only ever
   * *increase* the overflow, so there is no width at which showing an arrow
   * removes the reason for it and the pair flickers.
   *
   * It runs to a fixed point rather than once, because an arrow appearing or
   * leaving is itself a change of the width the next answer depends on. The
   * case that needs it is the webfont landing: the strip is measured in the
   * fallback face, overflows by a few pixels and takes an arrow, the real face
   * arrives narrower, and the strip then fitted exactly — with an arrow beside
   * it pointing at nothing and the last label under a fade. Two passes are
   * enough by the monotonicity above, and the second costs one layout read.
   */
  /**
   * Recompute the arrows and the edge fades.
   *
   * `assumeLeft` is the position the strip is *going* to be at. A smooth scroll
   * reports its old `scrollLeft` until the animation ends, so syncing from the
   * live value right after asking for one shows the arrow state of the place
   * the reader just left.
   */
  function syncStrip(assumeLeft?: number): void {
    for (let pass = 0; pass < 2; pass++) if (!syncStripOnce(assumeLeft)) return;
  }

  /** One pass. `true` when it moved an arrow, i.e. when the width just changed. */
  function syncStripOnce(assumeLeft?: number): boolean {
    const port = scrollport();
    const left = port === null ? 0 : (assumeLeft ?? port.left);
    const fits = port === null || port.max <= SCROLL_EPSILON;
    const atStart = fits || left <= SCROLL_EPSILON;
    const atEnd = fits || left >= port.max - SCROLL_EPSILON;
    const moved = setHidden(prevKey, atStart) || setHidden(nextKey, atEnd);
    strip.dataset['fade'] = fits ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both';
    return moved;
  }

  /**
   * Hide or show an arrow, carrying the focus if it is on the one leaving.
   *
   * A control that vanishes under the reader's own keypress takes the focus to
   * `<body>` with it, and the next Tab restarts from the masthead — the same
   * failure the transport and the story row refuse `disabled` to avoid. The
   * gesture was "move along the strip", so the focus goes to the key that can
   * still do that, and to the selected tab when neither can.
   */
  function setHidden(key: HTMLButtonElement, hidden: boolean): boolean {
    if (key.hidden === hidden) return false;
    const held = typeof document !== 'undefined' && document.activeElement === key;
    key.hidden = hidden;
    if (hidden && held) {
      const other = key === prevKey ? nextKey : prevKey;
      if (!other.hidden && typeof other.focus === 'function') other.focus();
      else tabs[activeIndex]?.focus();
    }
    return true;
  }

  function reduced(): boolean {
    return motionQuery?.matches ?? false;
  }

  /** Move the strip to `left`, eased unless the reader has asked for less motion. */
  function scrollTo(left: number, smooth: boolean): void {
    const port = scrollport();
    if (port === null) return;
    const target = Math.max(0, Math.min(port.max, left));
    if (typeof strip.scrollTo === 'function') {
      // `instant`, never `auto`: `auto` means "consult scroll-behavior", and the
      // strip's own scroll-behavior is `smooth`. So the value that reads like
      // "no animation" is the one that asks for the animation, and every scroll
      // this function was asked to make immediate — the held pan, a drag, a
      // reduced-motion press — was eased instead. Measured: a 14 px pan step at
      // 50 ms against a ~300 ms ease never resolves, so the strip did not move
      // at all.
      strip.scrollTo({ left: target, behavior: smooth && !reduced() ? 'smooth' : 'instant' });
    } else {
      strip.scrollLeft = target;
    }
    // `scroll` is delivered asynchronously, and not at all for a move that
    // changes nothing, so the arrows are recomputed here as well as from the
    // listener below. A smooth scroll reaches its own end through that listener.
    // The sync reasons from `target` rather than the live `scrollLeft`, which
    // an in-flight smooth scroll still reports as the old position.
    syncStrip(target);
  }

  function scrollByPx(delta: number, smooth: boolean): void {
    const port = scrollport();
    if (port === null) return;
    scrollTo(port.left + delta, smooth);
  }

  /** One press of an arrow: most of a screenful, eased. */
  function pageBy(direction: 1 | -1): void {
    const port = scrollport();
    if (port === null) return;
    scrollByPx(direction * Math.max(REVEAL_PAD * 4, port.width * ARROW_PAGE), true);
  }

  /**
   * An arrow: one page per press, and a continuous pan while it is held.
   *
   * The hold answers on `pointerdown` and the browser then synthesises a
   * `click` at the end of that press, which must not turn a page a second time
   * — the same bit the transport's Fast-forward key keeps, and the same guard,
   * because the trap is the same: a press that ends somewhere the click cannot
   * follow leaves the bit armed and swallows the next *bare* click, which is how
   * assistive technology presses a button.
   */
  function bindArrow(key: HTMLButtonElement, direction: 1 | -1): void {
    const guard = createPressGuard();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = (clickFollows: boolean): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      guard.end(clickFollows);
    };

    const pan = (): void => {
      // Direct, not eased: a held key is a continuous movement, and stacking a
      // 200 ms ease on a 50 ms repeat is a scroll that never catches up.
      scrollByPx(direction * ARROW_HOLD_STEP, false);
      timer = setTimeout(pan, ARROW_HOLD_MS);
    };

    const begin = (): void => {
      if (timer !== null) return;
      guard.arm();
      pageBy(direction);
      timer = setTimeout(pan, ARROW_HOLD_DELAY_MS);
    };

    on(key, 'pointerdown', (event) => {
      if (!isPrimaryPress(event)) return;
      begin();
    });
    on(key, 'pointerleave', () => stop(false));
    on(key, 'contextmenu', () => stop(false));
    on(key, 'blur', () => stop(false));
    on(key, 'keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      // Swallowing the default swallows the synthesised click with it, so a held
      // key cannot turn two pages at once.
      event.preventDefault();
      begin();
    });
    on(key, 'keyup', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      stop(false);
    });
    on(key, 'click', () => {
      // Only a click with no press behind it — assistive technology activating
      // the key directly — still needs its page.
      if (guard.swallows()) return;
      pageBy(direction);
    });
    // A press does not have to end on the key it started on.
    onGlobal(typeof document === 'undefined' ? undefined : document, 'pointerup', (event) => {
      const target = event.target;
      stop(event.type !== 'pointercancel' && target instanceof Node && key.contains(target));
    });
    onGlobal(typeof document === 'undefined' ? undefined : document, 'pointercancel', () => stop(false));
  }

  bindArrow(prevKey, -1);
  bindArrow(nextKey, 1);

  // -- dragging the strip ---------------------------------------------------

  /** Where the press began, and where the strip was when it did. */
  let dragFrom = 0;
  let dragScroll = 0;
  let dragging = false;
  /** Has this press moved far enough to be a pan rather than a click? */
  let panned = false;

  on(strip, 'pointerdown', (event) => {
    if (!isPrimaryPress(event)) return;
    // Touch and pen already pan this strip natively through `overflow-x`, with
    // momentum and rubber-banding a scripted pan cannot reproduce, so the two
    // gestures are left to the platform and only the mouse is driven here.
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
    const port = scrollport();
    if (port === null || port.max <= SCROLL_EPSILON) return;
    dragging = true;
    panned = false;
    dragFrom = event.clientX;
    dragScroll = port.left;
  });

  on(strip, 'pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragFrom;
    if (!panned) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      panned = true;
      strip.dataset['panning'] = 'true';
      // The pointer will leave the strip long before the drag does; capture is
      // what keeps the moves arriving.
      if (typeof strip.setPointerCapture === 'function') {
        try {
          strip.setPointerCapture(event.pointerId);
        } catch {
          /* A host that refuses capture still pans while the pointer is over the strip. */
        }
      }
    }
    // Direct manipulation: the strip is under the reader's finger and must not
    // ease away from it. Selection is suppressed so the labels do not highlight.
    event.preventDefault();
    strip.scrollLeft = dragScroll - dx;
    syncStrip();
  });

  function endDrag(): void {
    if (!dragging) return;
    dragging = false;
    delete strip.dataset['panning'];
    if (!panned) return;
    // The `click` a mouse press synthesises arrives in this same task, and the
    // tab's handler reads this flag to refuse it. Clearing it a task later is
    // what lets the very next press activate a tab normally.
    setTimeout(() => {
      panned = false;
    }, 0);
  }

  on(strip, 'pointerup', endDrag);
  on(strip, 'pointercancel', endDrag);
  on(strip, 'lostpointercapture', endDrag);
  onGlobal(typeof document === 'undefined' ? undefined : document, 'pointerup', endDrag);

  on(strip, 'scroll', () => syncStrip());
  onGlobal(typeof window === 'undefined' ? undefined : window, 'resize', () => syncStrip());

  // The strip's width also moves when nothing resizes: the webfont lands and
  // every label re-measures. A ResizeObserver catches that; where there is none
  // the resize listener and the route change still cover the common cases.
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => syncStrip());
    observer.observe(strip);
    cleanups.push(() => observer.disconnect());
  }

  // Belt and braces for the same reflow. A ResizeObserver is delivered as part
  // of the rendering steps, so a document that is handed no frames — a
  // background tab, an embedded view that throttles them — never hears about
  // the font swap at all; this promise is not on that path. It may also never
  // settle, which costs nothing: the continuation holds the shell, and the
  // shell outlives the page.
  const fontsReady = document.fonts?.ready;
  if (fontsReady) void fontsReady.then(() => syncStrip(), () => undefined);

  syncStrip();

  // -- tab keyboard model ---------------------------------------------------

  /**
   * Where the arrow keys are walking from: the platform's own focus, and only
   * as a fallback the selected tab.
   *
   * Keeping a second cursor and writing it from `setActiveTab()` was correct
   * when the route changed *because* a tab was activated, and wrong for every
   * other route change — Back, Forward, a pasted link, the unknown-id fallback
   * — where the focus is still wherever the reader left it. The two cursors then
   * disagreed and one arrow press teleported the focus ring six tabs backwards.
   * Derived, there is only one cursor and no route change can move it.
   */
  function cursorIndex(): number {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const here = active === null ? -1 : tabs.findIndex((tab) => tab === active);
    return here >= 0 ? here : Math.max(activeIndex, 0);
  }

  /** Roving tabindex: exactly one tab is in the tab order at any moment. */
  function focusTab(index: number): void {
    const count = tabs.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    for (const [i, tab] of tabs.entries()) tab.tabIndex = i === next ? 0 : -1;
    tabs[next]?.focus();
    revealTab(next);
  }

  on(strip, 'keydown', (event) => {
    let target: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        target = cursorIndex() - 1;
        break;
      case 'ArrowRight':
        target = cursorIndex() + 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = tabs.length - 1;
        break;
      default:
        // Enter and Space are the button's own activation keys and already
        // fire click; binding them here would double-activate.
        return;
    }
    // Without this the strip scrolls under the arrow key as well as moving focus.
    event.preventDefault();
    focusTab(target);
  });

  /**
   * Bring a tab inside the scrollport, with a little clearance, and move it no
   * further than it has to go.
   *
   * `smooth` is false for the FIRST reveal of a page's life, which is the one
   * that is not a movement: a permalink to the ninth tab opens with the strip
   * already where it belongs rather than sliding there from a position the
   * reader never saw. Every later reveal is a move between two states they did
   * see, and eases.
   *
   * `scrollIntoView` is the fallback rather than the mechanism: it is the only
   * thing a host with no measurable geometry can do, and it cannot be given the
   * clearance that keeps a tab from sitting flush against the fade.
   */
  function revealTab(index: number, smooth = true): void {
    const tab = tabs[index];
    if (!tab) return;
    const port = scrollport();
    const left = finite(tab.offsetLeft);
    const width = finite(tab.offsetWidth);
    if (port !== null && left !== null && width !== null && port.max > SCROLL_EPSILON) {
      // The window of scroll offsets that leave the tab fully on screen. When
      // the tab is wider than the port the two cross and the leading edge wins,
      // which is the edge the label starts at.
      const atLeast = left + width + REVEAL_PAD - port.width;
      const atMost = left - REVEAL_PAD;
      const wanted = port.left < atLeast ? atLeast : port.left > atMost ? atMost : port.left;
      scrollTo(wanted, smooth);
      return;
    }
    if (typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    syncStrip();
  }

  // -- aspect ---------------------------------------------------------------

  /**
   * `--viz-aspect` is a unitless number (width / height) and is registered, so
   * a malformed value falls back to the initial 1.6 instead of collapsing the
   * stage. `--viz-aspect-narrow` is deliberately unregistered so the stage's
   * `var(…, …)` fallback works, and is only set when a visualization asks for
   * a portrait shape on a phone.
   *
   * Both come off the `Viz` contract, so a visualization that declares neither
   * gets the registered default and the compiler catches a misspelt field.
   */
  function applyAspect(viz: Viz): void {
    setAspect('--viz-aspect', viz.aspect);
    setAspect('--viz-aspect-narrow', viz.aspectNarrow);
  }

  function setAspect(prop: string, value: number | undefined): void {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      plate.style.setProperty(prop, String(value));
    } else {
      plate.style.removeProperty(prop);
    }
  }

  // -- bench order ----------------------------------------------------------

  /**
   * Put the rail's contents where the layout paints them.
   *
   * Below the breakpoint the figure and the rail are `display: contents` and the
   * bench is one column, with the transport between the plate and the readouts
   * and the controls between the readouts and the "Try:" row. CSS `order` moves
   * the paint and *not* the tab sequence, and a mismatch between the two is
   * WCAG 2.4.3: with the rail last in the DOM, Tab off the plate skips the
   * transport and every control, lands on the chips a page further down, and
   * comes back up to Play stops later. So the stack is restacked in the DOM
   * as well.
   *
   * Above it, four things move the other way: the transport and the controls
   * into the panel, and the fact card and the footer line under it, into the
   * 850 px of column the panel leaves empty.
   *
   * The footer has to come back out again. Below the breakpoint the rail is
   * `display: contents`, so a footer left inside it is a flex item of the bench
   * with no `order` — that is, order 0, ahead of the figure's head at 1 — and
   * the licence line paints above the title of the page. theme.css §15 gives it
   * `order: 9` as well, because `restack(stackQuery?.matches ?? false)` leaves
   * the desktop arrangement in place on a browser with no matchMedia at all.
   *
   * Re-parenting an element blurs it, so the focus is carried across the move —
   * which is the whole point of the exercise. The fact card's sources and the
   * footer's two links are focusable and now move too, so they are held as well.
   */
  function restack(stacked: boolean): void {
    const active = document.activeElement;
    const held =
      active !== null &&
      (transport.contains(active) ||
        controls.contains(active) ||
        fact.contains(active) ||
        footer.contains(active));
    if (stacked) {
      figure.insertBefore(transport, readouts);
      figure.insertBefore(controls, story);
      figure.append(fact);
      page.append(footer);
    } else {
      railPanel.append(transport, controls);
      rail.append(fact, footer);
    }
    if (held && active instanceof HTMLElement) active.focus();
  }

  const stackQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia(BENCH_STACK_QUERY) : null;
  restack(stackQuery?.matches ?? false);
  if (stackQuery) {
    // Through the helper: a MediaQueryList without `addEventListener` — an
    // extension's matchMedia wrapper, a polyfill — threw here, in the last few
    // statements of createShell(), and the shell never returned. The page then
    // rendered the masthead and fifteen inert tabs and nothing else.
    cleanups.push(onMediaChange(stackQuery, () => restack(stackQuery.matches)));
  }

  let permalinkHref = '';

  return {
    regions: {
      stage: stageHost,
      controls,
      transport,
      readouts,
      story,
      facts: fact,
      title,
      blurb,
    },

    setActiveTab(id) {
      const index = vizList.findIndex((v) => v.id === id);
      if (index < 0) return;
      const viz = vizList[index];
      if (!viz) return;

      const opening = activeIndex < 0;
      activeIndex = index;
      activeViz = viz;

      for (const [i, tab] of tabs.entries()) {
        const selected = i === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }

      bench.setAttribute('aria-labelledby', `tab-${id}`);
      applyAspect(viz);
      revealTab(index, !opening);
    },

    focusActiveTab() {
      const tab = tabs[activeIndex];
      if (tab && typeof tab.focus === 'function') tab.focus();
    },

    setPermalink(hash) {
      const next = absolutize(hash);
      if (next === permalinkHref) return;
      permalinkHref = next;
      permalink.setAttribute('data-permalink', permalinkHref);
    },

    destroy() {
      for (const off of cleanups) off();
      cleanups.length = 0;
      page.remove();
    },
  };
}
