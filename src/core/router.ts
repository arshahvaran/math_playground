import { snapToStep } from './grid';
import type { ParamSpec, ParamValue, ParamValues } from './types';

/**
 * Hash routing and parameter serialization.
 *
 * A permalink is `#/<vizId>?key=value&…`, e.g. `#/galton?rows=12&p=0.5&seed=42`.
 * The fragment carries the state rather than the path so the app deploys as
 * static files on GitHub Pages with no rewrite rule, and so a link pasted into
 * a thread opens cold on exactly the run the sender saw.
 *
 * Two layers. The pure functions translate between the URL string and typed
 * `ParamValues`; they know nothing about the DOM. `createRouter()` binds them
 * to `location` and `history`, falling back to an in-memory fragment when
 * there is no window so the module loads and runs under vitest's node
 * environment.
 */

export interface Route {
  /** The visualization slug, or null when the fragment names none. */
  id: string | null;
  /** Raw query values, still strings. `coerceParams()` types them against a spec. */
  params: Record<string, string>;
}

export interface Router {
  readonly route: Route;
  /** Fires after every route change. Not on subscribe — read `route` for the current value. */
  subscribe(cb: (r: Route) => void): () => void;
  /** Go to a visualization. Pushes a history entry, so Back returns to the previous tab. */
  navigate(id: string, params?: Record<string, string | number | boolean>): void;
  /**
   * Mirror the current parameters into the URL with no history entry and no
   * subscriber notification — the shell made the change, it already knows.
   * Writes are coalesced so a slider drag rewrites the URL at most every 150 ms.
   * A no-op until a visualization has been navigated to.
   */
  replaceParams(params: Record<string, string | number | boolean>): void;
  /** Flush any pending URL write, drop the listener, and silence subscribers. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// URL string <-> Route
// ---------------------------------------------------------------------------

/** What a `Viz.id` may look like. Anything else in the id position is treated as no route. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse a fragment into a route. Tolerant by design — a permalink is typed,
 * pasted and truncated by humans — so `galton?rows=12`, `#galton` and `#/galton/`
 * all resolve to the same thing, and anything unrecognizable resolves to no route
 * rather than throwing.
 */
export function parseHash(hash: string): Route {
  let s = hash.trim();
  if (s.startsWith('#')) s = s.slice(1);

  const q = s.indexOf('?');
  const path = q >= 0 ? s.slice(0, q) : s;
  const query = q >= 0 ? s.slice(q + 1) : '';

  const id = decode(path.replace(/^\/+|\/+$/g, ''));
  if (!SLUG.test(id)) return { id: null, params: {} };

  return { id, params: parseQuery(query) };
}

/**
 * Build the fragment for a route. Keys keep insertion order so the same state
 * always yields the same string — which is what makes a permalink comparable.
 */
export function buildHash(id: string, params: Record<string, string | number | boolean>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  const query = pairs.length > 0 ? `?${pairs.join('&')}` : '';
  return `#/${encodeURIComponent(id)}${query}`;
}

function parseQuery(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
    // A key named __proto__ would reach for the prototype instead of storing a value.
    if (key === '' || key === '__proto__') continue;
    params[key] = decode(eq >= 0 ? pair.slice(eq + 1) : '');
  }
  return params;
}

/**
 * `decodeURIComponent` that keeps the input on a malformed escape (a stray `%`
 * in a hand-edited link) instead of throwing. Percent-encoding only: `+` is a
 * literal plus, not a space, so `1e+5` survives as a number.
 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Raw strings <-> typed ParamValues
// ---------------------------------------------------------------------------

/**
 * Type raw query strings against a visualization's specs. Every spec key is
 * present in the result; a missing, empty or unparsable value falls back to the
 * spec default, and out-of-range numbers are clamped rather than rejected.
 * Keys with no spec are dropped — the URL cannot introduce parameters.
 *
 * The result is always a fixed point of `serializeParams()`: a range value is
 * rounded to the slider's resolution here, on the way in, so the run and the
 * permalink the page advertises for it are the same experiment.
 */
export function coerceParams(specs: readonly ParamSpec[], raw: Record<string, string>): ParamValues {
  const values: Record<string, ParamValue> = {};
  for (const spec of specs) values[spec.key] = coerceOne(spec, raw[spec.key]);
  return values;
}

function coerceOne(spec: ParamSpec, text: string | undefined): ParamValue {
  const s = text === undefined ? '' : text.trim();
  if (s === '') return spec.default;

  switch (spec.kind) {
    case 'range': {
      const n = Number(s);
      // The rail's own grid, not a second definition of it: without this
      // `temp=2.27` runs while the fader, the address bar and the copied link
      // all say 2.25 — three opinions about one experiment. `snapToStep` clamps
      // to the ends as part of snapping, so there is no separate clamp to keep
      // in step with it.
      return Number.isFinite(n) ? snapToStep(n, spec.min, spec.max, spec.step) : spec.default;
    }
    case 'int': {
      const n = Number(s);
      return Number.isFinite(n) ? clamp(Math.round(n), spec.min, spec.max) : spec.default;
    }
    case 'toggle': {
      const t = s.toLowerCase();
      if (t === 'true' || t === '1') return true;
      if (t === 'false' || t === '0') return false;
      return spec.default;
    }
    case 'choice':
      return spec.options.some((o) => o.value === s) ? s : spec.default;
    case 'seed': {
      // `>>> 0` is the same reduction mulberry32 applies to its seed, so any
      // numeric text maps to the stream the RNG would actually produce for it.
      const n = Number(s);
      return Number.isFinite(n) ? n >>> 0 : spec.default;
    }
  }
}

/**
 * The inverse of `coerceParams()`, for writing the URL. Only values that differ
 * from the spec default are emitted, so a permalink names what the sender
 * changed and nothing else. Values of the wrong type are treated as defaults.
 */
export function serializeParams(specs: readonly ParamSpec[], values: ParamValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const s = serializeOne(spec, values[spec.key]);
    if (s !== null) out[spec.key] = s;
  }
  return out;
}

function serializeOne(spec: ParamSpec, value: ParamValue | undefined): string | null {
  switch (spec.kind) {
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      // Snap both sides to the same grid `coerceOne()` reads into: 0.1 + 0.2
      // must serialize as 0.3, and an untouched control must never appear in
      // the URL even if its stored value has drifted by an ulp. Because both
      // directions use one grid, `coerce(serialize(coerce(x)))` is a fixed
      // point — the permalink and the run are the same experiment.
      const v = snapToStep(value, spec.min, spec.max, spec.step);
      return v === snapToStep(spec.default, spec.min, spec.max, spec.step) ? null : String(v);
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const v = Math.round(value);
      return v === spec.default ? null : String(v);
    }
    case 'toggle':
      return typeof value === 'boolean' && value !== spec.default ? String(value) : null;
    case 'choice':
      return typeof value === 'string' && value !== spec.default && spec.options.some((o) => o.value === value)
        ? value
        : null;
    case 'seed': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const v = value >>> 0;
      return v === spec.default >>> 0 ? null : String(v);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Minimum spacing between URL rewrites while a slider is being dragged. */
const REPLACE_DEBOUNCE_MS = 150;

/**
 * Where the fragment lives. The browser source is `location` + `history`; the
 * memory source stands in when there is no window, with the same observable
 * behaviour (a push to the current value is a no-op and fires nothing).
 */
interface HashSource {
  read(): string;
  push(hash: string): void;
  /** True when the bar took the write. A refusal is a fact, never an exception. */
  replace(hash: string): boolean;
  listen(onChange: () => void): () => void;
}

/**
 * Both writes are guarded, because both of them throw in environments the app
 * is expected to survive. `history.replaceState` throws a SecurityError at an
 * opaque origin — a `sandbox="allow-scripts"` iframe, which is what Notion and
 * most LMSs embed with — and again when WebKit's ceiling of 100 calls per 30 s
 * is reached, which a 15 s slider drag at a 150 ms debounce does on its own.
 * Unguarded, that throw escapes a `setTimeout` as an uncaught error once per
 * debounce tick, and — because `navigate()` flushes before it pushes — it also
 * swallows the tab click that came after it.
 *
 * A refused write is reported rather than thrown, and it costs only the address
 * bar: the route still moves, the Share key still composes the right link, and
 * `seen` is re-anchored to what the bar really holds so the next write composes
 * against it. It is deliberately *not* retried through `location.hash`, which
 * would push one history entry per debounce tick and trap the Back button.
 */
function browserSource(): HashSource {
  return {
    read: () => window.location.hash,
    push: (hash) => {
      try {
        window.location.hash = hash;
      } catch {
        /* Navigation is app state; `navigate()` moves the route without the bar. */
      }
    },
    // A bare fragment resolves against the current URL. replaceState fires
    // neither hashchange nor popstate, so the bar updates silently.
    replace: (hash) => {
      try {
        window.history.replaceState(window.history.state, '', hash);
        return true;
      } catch {
        return false;
      }
    },
    listen: (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
  };
}

function memorySource(): HashSource {
  let hash = '';
  const listeners = new Set<() => void>();
  return {
    read: () => hash,
    push: (next) => {
      if (next === hash) return;
      hash = next;
      for (const l of listeners) l();
    },
    replace: (next) => {
      hash = next;
      return true;
    },
    listen: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

function clock(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

export function createRouter(): Router {
  const source = typeof window === 'undefined' ? memorySource() : browserSource();

  // `seen` is the fragment `current` was parsed from. It may run ahead of the
  // address bar while a replaceParams() write is pending; comparing against it
  // is what lets a change be detected exactly once whether it arrives through
  // navigate() synchronously or through the browser's queued hashchange task.
  let seen = source.read();
  let current = parseHash(seen);
  const subscribers = new Set<(r: Route) => void>();

  let pending: string | null = null;
  // The address bar as it stood when the pending write was armed — the fragment
  // that write means to amend. A hash navigation updates the bar synchronously
  // but is delivered as a queued task, so without this a debounce firing inside
  // that window would replace the new fragment with the old one's parameters and
  // then mark it seen, reverting the navigation with nobody notified.
  let pendingBase: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let replacing = false;
  /** When the bar was last written. The debounce's leading edge is measured from it. */
  let lastWrite = -Infinity;

  function cancelPending(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    pendingBase = null;
  }

  function flush(): void {
    // Also reached early by destroy(): clear the timer rather than assume it fired.
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const hash = pending;
    const base = pendingBase;
    pending = null;
    pendingBase = null;
    // The bar is no longer the one this write was composed against: a hash
    // navigation landed and its `hashchange` is still queued. Abandon the write
    // and leave the new fragment alone — `sync()` adopts it when the event runs.
    if (base !== null && source.read() !== base) return;
    replacing = true;
    let wrote = false;
    try {
      wrote = source.replace(hash);
    } finally {
      replacing = false;
    }
    lastWrite = clock();
    // Re-read rather than trust our own string: the browser may normalize the
    // fragment. On a refused write this re-anchors `seen` to what the bar
    // actually holds, so the router cannot spend the rest of the session
    // believing a fragment it never managed to write.
    seen = source.read();
    if (!wrote) current = parseHash(seen);
  }

  /** Adopt the address bar's fragment if it moved since we last looked. */
  function sync(): void {
    const hash = source.read();
    if (hash === seen) return;
    seen = hash;
    current = parseHash(hash);
    // The route moved under a pending rewrite (Back button, pasted link); the
    // rewrite would clobber the new route with the old one's parameters.
    cancelPending();
    for (const cb of subscribers) cb(current);
  }

  function onHashChange(): void {
    // replaceState never fires hashchange, so this guard is belt-and-braces
    // against a history polyfill that does.
    if (replacing) return;
    sync();
  }

  const unlisten = source.listen(onHashChange);

  return {
    get route() {
      return current;
    },

    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },

    navigate(id, params = {}) {
      // Land the pending write on the entry we are about to leave rather than
      // drop it, so a control moved in the last 150 ms is still there when Back
      // returns here. Safe against the race above: `flush()` abandons the write
      // itself if the bar has already moved under it, and it cannot throw.
      flush();
      const hash = buildHash(id, params);
      const before = source.read();
      source.push(hash);
      // The browser updates location.hash synchronously but queues the event;
      // syncing here keeps `route` current for the caller's next line. The
      // queued hashchange then finds nothing new.
      sync();
      if (source.read() === before && seen !== hash) {
        // The bar refused the write. Navigation is the app's state, not a URL
        // cosmetic: a tab click must move the route whether or not the fragment
        // can be written, so the subscribers are told directly.
        seen = hash;
        current = parseHash(hash);
        cancelPending();
        for (const cb of subscribers) cb(current);
      }
    },

    replaceParams(params) {
      const id = current.id;
      if (id === null) return;
      const hash = buildHash(id, params);
      // The route reflects the shell's state immediately; only the URL write waits.
      seen = hash;
      current = parseHash(hash);
      pending = hash;
      if (timer !== null) return;
      // The bar stays untouched for the whole debounce window, so the fragment
      // this write amends is whatever it held when the window opened.
      pendingBase = source.read();
      // Leading edge. The debounce exists because one slider drag emits sixty
      // input events and must not emit sixty `replaceState` calls — not because
      // the first of them should be withheld. Deferring it too meant a control
      // moved less than 150 ms before a hash navigation never reached the bar
      // at all: `sync()` cancels the pending write, and the entry the reader
      // left kept the parameters they had already replaced. Writing the first
      // change of a gesture at once makes the entry always carry at least the
      // value in force when the gesture began, whatever the timing.
      if (clock() - lastWrite >= REPLACE_DEBOUNCE_MS) {
        flush();
        return;
      }
      timer = setTimeout(flush, REPLACE_DEBOUNCE_MS);
    },

    destroy() {
      unlisten();
      flush();
      subscribers.clear();
    },
  };
}
