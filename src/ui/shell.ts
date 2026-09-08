import type { ParamSpec, ParamValue, ParamValues, Viz, VizGroup } from '../core/types';
import { coerceParams, parseHash } from '../core/router';
import { fmt } from '../core/stats';
import { h, svg, type Attrs } from './dom';
import {
  SHORTCUTS_EVENT,
  setShortcutsEnabled,
  shortcutsEnabled,
} from './transport';

/**
 * The bench.
 *
 * Everything on the page that is not a visualization: the masthead and its
 * scheme toggle, the peg-row tab strip with its pinned index, the figure/rail
 * lattice the components mount into, the caption with its permalink, and the
 * footer with the aggregated sources and the shortcuts switch.
 *
 * The shell is built once and reused for every route. It knows the registry —
 * titles, groups, facts — and nothing else about any visualization: no branch
 * here reads an `id`. Adding a tab is a registry line, and adding a *group* is
 * one more entry in the group union, because the run label is derived from the
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
const AFFILIATION = 'University of Toronto';
/** Mirrors package.json — the footer prints it, nothing reads it back. */
const VERSION = '0.1.0';

/** Namespaced so a sibling project on the same Pages origin cannot collide. */
const SCHEME_KEY = 'mp:scheme';

/** How long the Copy key shows its confirmation before returning to its label. */
const COPY_FEEDBACK_MS = 2000;

/** Thousands separators for counts in the caption sentence; prose, not a cell. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

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
  /** Move the ball, the roving tabindex, the index select and the figure number. */
  setActiveTab(id: string): void;
  /** Publish the current permalink: the Copy key, `data-permalink`, and the caption sentence. */
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

/** U+2212 in prose, per the typography rule. Mono cells decide separately. */
function minus(text: string): string {
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}

/**
 * `fmt()` keeps trailing zeros so a live cell never changes width mid-run. The
 * caption is a sentence, not a cell — "bias 0.5" reads, "bias 0.5000" does not.
 */
function trimZeros(text: string): string {
  if (!text.includes('.') || text.includes('e')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function formatParam(spec: ParamSpec, value: ParamValue): string {
  switch (spec.kind) {
    case 'range':
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
      const text = Number.isInteger(value)
        ? COUNT_FORMAT.format(value)
        : trimZeros(fmt(value, 4));
      return `${minus(text)}${spec.unit ?? ''}`;
    }
    case 'toggle':
      return value === true ? 'on' : 'off';
    case 'choice': {
      const option = spec.options.find((o) => o.value === value);
      return option ? option.label : String(value);
    }
    case 'seed':
      // A seed is an identifier, not a quantity: no separators, no rounding.
      return String(value);
  }
}

/**
 * The caption sentence, rewritten from the live parameters every time the
 * permalink changes. It is composed from `ParamSpec.label` and the coerced
 * values, so it stays true for a visualization this file has never heard of.
 */
function describe(viz: Viz, values: ParamValues): string {
  const parts: string[] = [];
  for (const spec of viz.params) {
    const value = values[spec.key];
    if (value === undefined) continue;
    parts.push(`${spec.label} ${formatParam(spec, value)}`);
  }
  return parts.length > 0 ? `${viz.title}: ${parts.join(', ')}.` : `${viz.title}.`;
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
  });
  // A half-inked plate: the square is the bed, one half is filled.
  themeToggle.append(
    glyph(
      { d: 'M2 2h12v12H2z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' },
      { d: 'M8 2h6v12H8z' },
    ),
  );

  const masthead = h(
    'header',
    { class: 'masthead' },
    h('a', { class: 'masthead__wordmark', href: `#/${defaultId}` }, 'Math Playground'),
    h(
      'div',
      { class: 'masthead__end' },
      h(
        'p',
        { class: 'masthead__credit' },
        h('span', { class: 'masthead__author' }, AUTHOR),
        h('span', { class: 'masthead__affil' }, AFFILIATION),
      ),
      // Deliberately no target: the only new-tab links on this page are the
      // external citations in the fact card and the footer.
      h('a', { class: 'masthead__repo', href: REPO_URL }, 'Source'),
      themeToggle,
    ),
  );

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
    on(tab, 'click', () => onSelect(viz.id));
    tabs.push(tab);
    run.append(tab);
  }

  // -- tab index (present at every width, the complete list at 10 tabs or 25) --

  const prevKey = h('button', {
    class: 'key key--icon tabs__prev',
    type: 'button',
    'aria-label': 'Previous visualization',
  });
  prevKey.append(glyph({ d: 'M10.5 2 4.5 8l6 6z' }));

  const nextKey = h('button', {
    class: 'key key--icon tabs__next',
    type: 'button',
    'aria-label': 'Next visualization',
  });
  nextKey.append(glyph({ d: 'M5.5 2 11.5 8l-6 6z' }));

  const indexSelect = h('select', { class: 'select tabs__select', id: 'viz-index' });
  let optgroup: HTMLOptGroupElement | null = null;
  let optgroupGroup: VizGroup | null = null;
  for (const viz of vizList) {
    if (optgroup === null || viz.group !== optgroupGroup) {
      optgroupGroup = viz.group;
      optgroup = h('optgroup', { label: groupLabel(viz.group) });
      indexSelect.append(optgroup);
    }
    optgroup.append(h('option', { value: viz.id }, viz.title));
  }
  on(indexSelect, 'change', () => onSelect(indexSelect.value));

  const tabsNav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Visualizations' },
    strip,
    h(
      'div',
      { class: 'tabs__index' },
      prevKey,
      h('label', { class: 'visually-hidden', for: 'viz-index' }, 'Jump to visualization'),
      indexSelect,
      nextKey,
    ),
  );

  // -- figure column --------------------------------------------------------

  const title = h('h1', { class: 'figure__title' });
  const blurb = h('p', { class: 'figure__blurb' });

  const stageHost = h('div', { class: 'stage' });
  const plate = h('div', { class: 'plate' }, stageHost);

  const captionFigure = h('span', { class: 'caption__figure' });
  const captionText = h('span', { class: 'caption__text' });
  const copyKey = h('button', { class: 'caption__copy', type: 'button' }, 'Copy permalink');
  const caption = h('p', { class: 'caption' }, captionFigure, captionText, copyKey);

  const readouts = h('section', { class: 'readouts', 'aria-label': 'Readouts' });
  const story = h('section', { class: 'story' });
  const fact = h('section', { class: 'fact' });

  const figure = h(
    'div',
    { class: 'figure' },
    h('header', { class: 'figure__head' }, title, blurb),
    plate,
    caption,
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
  const controls = h('form', { class: 'controls', 'aria-label': 'Parameters' });
  // A generated panel has no submit control; Enter in a number field would
  // otherwise reload the page and lose the run.
  on(controls, 'submit', (event) => event.preventDefault());

  const rail = h('div', { class: 'rail' }, h('div', { class: 'rail__panel' }, transport, controls));

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

  const sourceList = h('ul', { class: 'sources__list' });
  for (const viz of vizList) {
    const seen = new Set<string>();
    for (const item of viz.facts) {
      const key = item.source.url ?? item.source.label;
      if (seen.has(key)) continue;
      seen.add(key);
      // The fact card and this list are the only places a link may open a new
      // tab: they are external citations, not navigation inside the app.
      const link = item.source.url
        ? h(
            'a',
            { href: item.source.url, target: '_blank', rel: 'noopener noreferrer' },
            item.source.label,
          )
        : h('span', {}, item.source.label);
      sourceList.append(
        h(
          'li',
          { class: 'sources__item' },
          h('span', { class: 'sources__viz' }, viz.title),
          link,
        ),
      );
    }
  }

  const shortcutsSwitch = h('input', {
    class: 'switch',
    type: 'checkbox',
    role: 'switch',
  });
  const footer = h(
    'footer',
    { class: 'footer' },
    h(
      'div',
      { class: 'sources' },
      h('h2', { class: 'sources__title' }, 'Sources'),
      sourceList,
    ),
    h(
      'div',
      { class: 'footer__meta' },
      h('span', {}, `v${VERSION}`),
      h('a', { href: LICENCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'CC BY-NC 4.0'),
      h('span', {}, AUTHOR),
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'),
      h(
        'label',
        { class: 'footer__shortcuts' },
        h('span', {}, 'Keyboard shortcuts'),
        shortcutsSwitch,
      ),
    ),
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

  const storedScheme = readStore(SCHEME_KEY);
  if (storedScheme === 'dark' || storedScheme === 'light') applyScheme(storedScheme === 'dark');

  on(themeToggle, 'click', () => {
    const dark = themeToggle.getAttribute('aria-pressed') !== 'true';
    applyScheme(dark);
    writeStore(SCHEME_KEY, dark ? 'dark' : 'light');
  });

  // -- keyboard shortcuts switch (SC 2.1.4) ---------------------------------

  // The transport owns the `.` and `Shift+.` bindings, their `aria-keyshortcuts`
  // hints and the stored preference; this switch is the control surface for
  // them. Turning them off is the SC 2.1.4 escape hatch.
  shortcutsSwitch.checked = shortcutsEnabled();
  on(shortcutsSwitch, 'change', () => {
    setShortcutsEnabled(shortcutsSwitch.checked);
  });

  // Another tab of the same page, or any other caller, can flip the preference.
  const onShortcutsChanged = (): void => {
    shortcutsSwitch.checked = shortcutsEnabled();
  };
  window.addEventListener(SHORTCUTS_EVENT, onShortcutsChanged);
  window.addEventListener('storage', onShortcutsChanged);
  cleanups.push(() => {
    window.removeEventListener(SHORTCUTS_EVENT, onShortcutsChanged);
    window.removeEventListener('storage', onShortcutsChanged);
  });

  // -- tab keyboard model ---------------------------------------------------

  let activeIndex = -1;
  let focusIndex = 0;

  /** Roving tabindex: exactly one tab is in the tab order at any moment. */
  function focusTab(index: number): void {
    const count = tabs.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    for (const [i, tab] of tabs.entries()) tab.tabIndex = i === next ? 0 : -1;
    focusIndex = next;
    tabs[next]?.focus();
  }

  on(strip, 'keydown', (event) => {
    let target: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        target = focusIndex - 1;
        break;
      case 'ArrowRight':
        target = focusIndex + 1;
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

  on(prevKey, 'click', () => {
    if (prevKey.getAttribute('aria-disabled') === 'true') return;
    const target = vizList[activeIndex - 1];
    if (target) onSelect(target.id);
  });
  on(nextKey, 'click', () => {
    if (nextKey.getAttribute('aria-disabled') === 'true') return;
    const target = vizList[activeIndex + 1];
    if (target) onSelect(target.id);
  });

  // -- permalink ------------------------------------------------------------

  let activeViz: Viz | null = null;
  let permalink = '';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function flashCopy(message: string, done: boolean): void {
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyKey.textContent = message;
    if (done) copyKey.dataset.state = 'done';
    else delete copyKey.dataset.state;
    copyTimer = setTimeout(() => {
      copyKey.textContent = 'Copy permalink';
      delete copyKey.dataset.state;
      copyTimer = null;
    }, COPY_FEEDBACK_MS);
  }

  on(copyKey, 'click', () => {
    const write = navigator.clipboard?.writeText;
    if (!write) {
      flashCopy('Copy unavailable', false);
      return;
    }
    // Insecure origins and denied permissions both reject rather than throw.
    void navigator.clipboard.writeText(permalink).then(
      () => flashCopy('Copied', true),
      () => flashCopy('Copy failed', false),
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

      activeIndex = index;
      activeViz = viz;

      for (const [i, tab] of tabs.entries()) {
        const selected = i === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      focusIndex = index;

      indexSelect.value = id;
      // Inoperable at the ends, not removed from the tab order. Below 600 px the
      // peg strip is `display: none` and these two keys are the only tab
      // navigation there is, so a reader walks to the last tab with Next and
      // presses Enter — and `disabled` on the key that just fired the navigation
      // takes it out of focus mid-keypress. `document.activeElement` falls back
      // to <body> and the next Tab restarts from the wordmark, past the whole
      // index, with no skip link to come back with. `aria-disabled` announces the
      // same thing, keeps the key focusable, and `.key[aria-disabled="true"]`
      // already carries the disabled look; the click handlers above refuse it.
      prevKey.setAttribute('aria-disabled', String(index === 0));
      nextKey.setAttribute('aria-disabled', String(index === vizList.length - 1));
      bench.setAttribute('aria-labelledby', `tab-${id}`);
      captionFigure.textContent = `Figure ${index + 1}.`;
      applyAspect(viz);

      // The strip is a horizontal scroller from ten tabs up; `block: 'nearest'`
      // keeps the page itself from jumping while the strip catches up.
      const tab = tabs[index];
      if (tab && typeof tab.scrollIntoView === 'function') {
        tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    },

    setPermalink(hash) {
      permalink = absolutize(hash);
      caption.setAttribute('data-permalink', permalink);
      if (activeViz) {
        const raw = parseHash(hash).params;
        captionText.textContent = describe(activeViz, coerceParams(activeViz.params, raw));
      }
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
