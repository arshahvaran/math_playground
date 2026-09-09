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
      // Same rounding `serializeOne()` applies, so an off-step permalink is
      // reproducible: without it p=0.3333 would run while the address bar, the
      // caption and the copied link all said 0.33 — a different distribution.
      return Number.isFinite(n) ? clamp(roundToStep(n, spec.step), spec.min, spec.max) : spec.default;
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
      // Round both sides to the slider's resolution: 0.1 + 0.2 must serialize
      // as 0.3, and an untouched control must never appear in the URL even if
      // its stored value has drifted by an ulp.
      const v = roundToStep(value, spec.step);
      return v === roundToStep(spec.default, spec.step) ? null : String(v);
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

/** Round to the decimal precision of `step`. A step that is not a positive finite number rounds nothing. */
function roundToStep(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return value;
  return Number(value.toFixed(decimalPlaces(step)));
}

/**
 * Decimal places needed to write `step` exactly. `String(1e-7)` is "1e-7", not
 * "0.0000001", so the exponent has to be folded into the count. Capped at 20 —
 * beyond that `toFixed` is printing binary noise, not slider resolution.
 */
function decimalPlaces(step: number): number {
  const s = String(step);
  const e = s.indexOf('e');
  const mantissa = e >= 0 ? s.slice(0, e) : s;
  const exponent = e >= 0 ? Number(s.slice(e + 1)) : 0;
  const dot = mantissa.indexOf('.');
  const fraction = dot >= 0 ? mantissa.length - dot - 1 : 0;
  return Math.max(0, Math.min(20, fraction - exponent));
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
  replace(hash: string): void;
  listen(onChange: () => void): () => void;
}

function browserSource(): HashSource {
  return {
    read: () => window.location.hash,
    push: (hash) => {
      window.location.hash = hash;
    },
    // A bare fragment resolves against the current URL. replaceState fires
    // neither hashchange nor popstate, so the bar updates silently.
    replace: (hash) => window.history.replaceState(window.history.state, '', hash),
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
    },
    listen: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
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
    try {
      source.replace(hash);
    } finally {
      replacing = false;
    }
    // Re-read rather than trust our own string: the browser may normalize the fragment.
    seen = source.read();
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
      // itself if the bar has already moved under it.
      flush();
      source.push(buildHash(id, params));
      // The browser updates location.hash synchronously but queues the event;
      // syncing here keeps `route` current for the caller's next line. The
      // queued hashchange then finds nothing new.
      sync();
    },

    replaceParams(params) {
      const id = current.id;
      if (id === null) return;
      const hash = buildHash(id, params);
      // The route reflects the shell's state immediately; only the URL write waits.
      seen = hash;
      current = parseHash(hash);
      // The bar stays untouched for the whole debounce window, so the fragment
      // this write amends is whatever it held when the window opened.
      if (timer === null) {
        pendingBase = source.read();
        timer = setTimeout(flush, REPLACE_DEBOUNCE_MS);
      }
      pending = hash;
    },

    destroy() {
      unlisten();
      flush();
      subscribers.clear();
    },
  };
}
