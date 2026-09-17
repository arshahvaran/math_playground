import { onMediaChange } from '../core/canvas';
import type { Viz, VizGroup } from '../core/types';
import { h, svg, type Attrs } from './dom';

/**
 * The bench.
 *
 * Everything on the page that is not a visualization: the masthead with its
 * scheme toggle, the tab strip, the figure/rail lattice the components mount
 * into, the Share key under the plate, and a one-line footer.
 *
 * It is deliberately sparse. A visitor with no statistics should be able to
 * read every word on the page, so the chrome is the wordmark, the tabs, the
 * title and its one-sentence blurb, the plate, the readouts, the controls and a
 * footer line. The author, the affiliation, the figure number, the parameter
 * caption and the navigation arrows all went; the tab strip is the navigation,
 * and on a narrow screen it scrolls.
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

/** How long the Share key shows its confirmation before returning to its label. */
const COPY_FEEDBACK_MS = 2000;

/**
 * The two-column breakpoint, mirroring theme.css §15. Below it the bench is a
 * single stack and the rail's keys are painted between the Share row and the
 * readouts, so the DOM has to be restacked to match — see `restack()`. The
 * number lives in both files because a media query cannot be read back out of a
 * stylesheet; theme.css is the one that decides.
 */
const BENCH_STACK_QUERY = '(max-width: 63.9375rem)';

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
  /** Publish the current permalink: what Share copies, and `data-permalink` for print. */
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
 * "randomness" → "Randomness". Deriving the run label from the group name is
 * what keeps a new group to a single entry in the union: a lookup table here
 * would make it a shell change as well.
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

// ---------------------------------------------------------------------------
// createShell
// ---------------------------------------------------------------------------

export function createShell(
  root: HTMLElement,
  vizList: readonly Viz[],
  onSelect: (id: string) => void,
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

  const wordmark = h(
    'a',
    { class: 'masthead__wordmark', href: `#/${defaultId}` },
    'Math Playground',
  );

  const masthead = h('header', { class: 'masthead' }, wordmark, themeToggle);

  // -- selection ------------------------------------------------------------

  /** The visualization on screen, as `setActiveTab()` last reported it. */
  let activeViz: Viz | null = null;

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
  });

  const tabs: HTMLButtonElement[] = [];

  // Runs are maximal spans of consecutive registry entries sharing a group.
  // Consecutive, never sorted: the registry order is pedagogical, and a run
  // built by bucketing would silently reorder it.
  let run: HTMLElement | null = null;
  let runGroup: VizGroup | null = null;
  for (const [index, viz] of vizList.entries()) {
    if (run === null || viz.group !== runGroup) {
      runGroup = viz.group;
      run = h(
        'div',
        { class: 'tabs__group', role: 'presentation' },
        // The label is decoration in ARIA terms: a tablist may own nothing but
        // tabs. The group reaches assistive technology through each tab's own
        // aria-label instead.
        h('span', { class: 'tabs__group-label', 'aria-hidden': 'true' }, groupLabel(viz.group)),
      );
      strip.append(run);
    }
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
    on(tab, 'click', () => select(viz.id));
    tabs.push(tab);
    run.append(tab);
  }

  const tabsNav = h('nav', { class: 'tabs', 'aria-label': 'Visualizations' }, strip);

  // -- figure column --------------------------------------------------------

  const title = h('h1', { class: 'figure__title' });
  const blurb = h('p', { class: 'figure__blurb' });

  const stageHost = h('div', { class: 'stage' });
  const plate = h('div', { class: 'plate' }, stageHost);

  // Share: one small key that puts the permalink on the clipboard. The row
  // carries `data-permalink` so a printed page still names the run it shows.
  const shareText = document.createTextNode('Share');
  const shareKey = h(
    'button',
    { class: 'key key--small share__key', type: 'button' },
    // A tray with an arrow rising out of it.
    glyph({ d: 'M2 8h2.5v4h7V8H14v6H2z' }, { d: 'M8 1l4 4H9.5v5h-3V5H4z' }),
    h('span', { class: 'share__text' }, shareText),
  );
  const share = h('div', { class: 'share' }, shareKey);

  const readouts = h('section', { class: 'readouts', 'aria-label': 'Readouts' });
  const story = h('section', { class: 'story' });
  const fact = h('section', { class: 'fact' });

  const figure = h(
    'div',
    { class: 'figure' },
    h('header', { class: 'figure__head' }, title, blurb),
    plate,
    share,
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
  const footer = h(
    'footer',
    { class: 'footer' },
    h('a', { class: 'footer__source', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source'),
    h('a', { href: LICENCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'CC BY-NC 4.0'),
    h('span', { class: 'footer__author' }, AUTHOR),
  );

  const page = h('div', { class: 'page' }, masthead, tabsNav, bench, footer);
  root.append(page);

  // -- scheme ---------------------------------------------------------------

  /**
   * The light faceplate is the identity, so the dark scheme is never selected
   * from `prefers-color-scheme` — this toggle is the only path into it, which
   * is why it is not optional. Both values are written explicitly so the
   * toggle wins in either direction.
   */
  function applyScheme(dark: boolean): void {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggle.setAttribute('aria-pressed', String(dark));
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

  // -- tab keyboard model ---------------------------------------------------

  let activeIndex = -1;

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

  // -- share ----------------------------------------------------------------

  let permalink = '';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Back to the key's own label, with any pending restore cancelled. */
  function restoreShare(): void {
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = null;
    shareText.data = 'Share';
    delete shareKey.dataset['state'];
  }

  function flashShare(message: string, done: boolean): void {
    if (copyTimer !== null) clearTimeout(copyTimer);
    shareText.data = message;
    if (done) shareKey.dataset['state'] = 'done';
    else delete shareKey.dataset['state'];
    copyTimer = setTimeout(restoreShare, COPY_FEEDBACK_MS);
  }

  on(shareKey, 'click', () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      flashShare('Copy unavailable', false);
      return;
    }
    /**
     * The link is the token. A clipboard write settles a few milliseconds
     * later — longer behind a permission chip, a DLP extension, or a busy main
     * thread — and by then the reader may have clicked a tab or moved a control,
     * both of which rewrite the permalink. Without this guard the continuation
     * printed "Link copied" beside a link that is not the one on the clipboard:
     * `restoreShare()` cancels the 2 s timer on a route change but cannot cancel
     * a promise. Comparing the string the write was issued for against the one
     * the page now advertises needs no extra state and covers every way the
     * permalink can move, including ones added later.
     */
    const issued = permalink;
    // Insecure origins and denied permissions both reject rather than throw.
    void clipboard.writeText(issued).then(
      () => {
        if (issued !== permalink) return;
        flashShare('Link copied', true);
      },
      () => {
        if (issued !== permalink) return;
        flashShare('Copy failed', false);
      },
    );
  });

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
   * Put the rail's keys where the layout paints them.
   *
   * Below the breakpoint the figure and the rail are `display: contents` and the
   * bench is one column, with the transport between the Share row and the
   * readouts and the controls between the readouts and the "Try:" row. CSS
   * `order` moves the paint and *not* the tab sequence, and a mismatch between
   * the two is WCAG 2.4.3: with the rail last in the DOM, Tab off Share skips
   * the transport and every control, lands on the chips a page further down,
   * and comes back up to Play stops later. So the stack is restacked in the DOM
   * as well.
   *
   * Re-parenting an element blurs it, so the focus is carried across the move —
   * which is the whole point of the exercise.
   */
  function restack(stacked: boolean): void {
    const active = document.activeElement;
    const held = active !== null && (transport.contains(active) || controls.contains(active));
    if (stacked) {
      figure.insertBefore(transport, readouts);
      figure.insertBefore(controls, story);
    } else {
      railPanel.append(transport, controls);
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

      // The confirmation is a 2 s timer on a shell that is never destroyed, and
      // the permalink under it is about to be rewritten. Left running it would
      // read "Link copied" beside the new route while the old one is on the
      // clipboard — vouching for a link that sends the reader somewhere else.
      restoreShare();

      activeIndex = index;
      activeViz = viz;

      for (const [i, tab] of tabs.entries()) {
        const selected = i === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }

      bench.setAttribute('aria-labelledby', `tab-${id}`);
      applyAspect(viz);

      // The strip is a horizontal scroller on a narrow screen; `block: 'nearest'`
      // keeps the page itself from jumping while the strip catches up.
      const tab = tabs[index];
      if (tab && typeof tab.scrollIntoView === 'function') {
        tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    },

    focusActiveTab() {
      const tab = tabs[activeIndex];
      if (tab && typeof tab.focus === 'function') tab.focus();
    },

    setPermalink(hash) {
      const next = absolutize(hash);
      if (next === permalink) return;
      // A confirmation is about a link, so it cannot outlive that link. A route
      // change is only one of the three ways the permalink moves — a parameter
      // change and a preset move it too, through `syncUrl()` — and folding the
      // invalidation into the write means no future call site can forget it.
      permalink = next;
      restoreShare();
      share.setAttribute('data-permalink', permalink);
    },

    destroy() {
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = null;
      for (const off of cleanups) off();
      cleanups.length = 0;
      page.remove();
    },
  };
}
