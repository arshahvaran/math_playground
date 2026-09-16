/**
 * A DOM small enough to boot the bench under vitest's node environment.
 *
 * The shell, the route lifecycle and the transport are the parts of this app
 * whose defects are *sequences* — a font promise that never settles, a tab
 * selection that tears the route down, a confirmation timer that outlives the
 * link it vouches for. None of that can be asserted on a pure function, and the
 * project ships no headless browser, so this is the smallest document the real
 * `src/main.ts` will run against: elements with attributes, a parent chain,
 * listeners, a focus pointer, an address bar that records whether an entry was
 * pushed or replaced, and a 2D context that records the calls made to it.
 *
 * It is deliberately not a DOM implementation. Nothing here does layout,
 * cascade, or selector matching beyond the `#app` the bootstrap asks for. Where
 * a behaviour is load-bearing for a test it is modelled exactly — assigning
 * `location.hash` pushes an entry and fires `hashchange`, `location.replace()`
 * swaps the entry in place and fires it too, and re-parenting an element leaves
 * the focus where the browser leaves it.
 */

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export class MNode {
  parentNode: MElement | null = null;

  get textContent(): string {
    return '';
  }
}

export class MText extends MNode {
  constructor(public data: string) {
    super();
  }

  override get textContent(): string {
    return this.data;
  }
}

interface MStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
  [key: string]: unknown;
}

export interface MEvent {
  type: string;
  target: MElement | null;
  currentTarget: MElement | null;
  bubbles: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  [key: string]: unknown;
}

export function makeEvent(type: string, init: Record<string, unknown> = {}): MEvent {
  return {
    type,
    target: null,
    currentTarget: null,
    bubbles: true,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {
      /* no capture phase to stop */
    },
    ...init,
  };
}

type Listener = (event: MEvent) => void;

export class MElement extends MNode {
  readonly childNodes: MNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  readonly style: MStyle = makeStyle();
  tabIndex = 0;
  hidden = false;
  value = '';
  checked = false;
  disabled = false;
  isContentEditable = false;
  clientWidth = 0;
  clientHeight = 0;
  width = 0;
  height = 0;

  constructor(readonly tagName: string) {
    super();
  }

  // -- tree -----------------------------------------------------------------

  get children(): MElement[] {
    return this.childNodes.filter((n): n is MElement => n instanceof MElement);
  }

  get firstChild(): MNode | null {
    return this.childNodes[0] ?? null;
  }

  override get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  override set textContent(text: string) {
    this.childNodes.length = 0;
    if (text !== '') this.append(text);
  }

  append(...nodes: Array<MNode | string>): void {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new MText(node) : node);
  }

  appendChild<T extends MNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore<T extends MNode>(node: T, ref: MNode | null): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const at = ref === null ? -1 : this.childNodes.indexOf(ref);
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }

  removeChild<T extends MNode>(node: T): T {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  contains(node: MNode | null): boolean {
    for (let n: MNode | null = node; n !== null; n = n.parentNode) if (n === this) return true;
    return false;
  }

  // -- attributes -----------------------------------------------------------

  setAttribute(name: string, value: string | number): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  get classList(): {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
  } {
    const read = (): Set<string> => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (set: Set<string>): void => this.setAttribute('class', [...set].join(' '));
    return {
      add: (...names) => {
        const set = read();
        for (const name of names) set.add(name);
        write(set);
      },
      remove: (...names) => {
        const set = read();
        for (const name of names) set.delete(name);
        write(set);
      },
      contains: (name) => read().has(name),
    };
  }

  // -- events, focus, layout ------------------------------------------------

  addEventListener(type: string, handler: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event: MEvent): boolean {
    event.target ??= this;
    for (let node: MElement | null = this; node !== null; node = node.parentNode) {
      event.currentTarget = node;
      for (const handler of [...(node.listeners.get(event.type) ?? [])]) handler(event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  focus(): void {
    doc.activeElement = this;
  }

  blur(): void {
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }

  scrollIntoView(): void {
    /* no scrollport */
  }

  /** One context per canvas, like the real thing: a second call is the same object. */
  getContext(kind: string): FakeContext | null {
    if (kind !== '2d') return null;
    return (this.context ??= fakeContext());
  }

  private context: FakeContext | null = null;
}

function makeStyle(): MStyle {
  const props = new Map<string, string>();
  return {
    setProperty(name: string, value: string): void {
      props.set(name, value);
    },
    removeProperty(name: string): void {
      props.delete(name);
    },
    getPropertyValue(name: string): string {
      return props.get(name) ?? '';
    },
  };
}

class MInput extends MElement {}
class MSelect extends MElement {}
class MTextArea extends MElement {}

/** Dispatch `type` at `el` the way a user gesture would. */
export function fire(el: MElement, type: string, init: Record<string, unknown> = {}): MEvent {
  const event = makeEvent(type, init);
  el.dispatchEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// The 2D context: a call recorder
// ---------------------------------------------------------------------------

export interface FakeContext {
  /** Every method called on this context, in order. `draw()` is "did anything ink?". */
  readonly calls: string[];
  [key: string]: unknown;
}

/** Context state the visualizations read back as well as write. */
const CONTEXT_STATE: Record<string, unknown> = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
};

function fakeContext(): FakeContext {
  const calls: string[] = [];
  const state: Record<string, unknown> = { ...CONTEXT_STATE, calls };
  const fixed: Record<string, (...args: never[]) => unknown> = {
    // The only two calls whose return value is read back.
    measureText: (text: never) => ({ width: String(text).length * 6 }),
    getContext: () => null,
    // A real buffer, not a recorded call: the Ising sheet writes its spins into
    // the alpha bytes of one of these and blits it, so a stub that answered
    // `undefined` here made that tab throw on its first frame under the
    // harness — a failure of this file and not of the tab.
    createImageData: (w: never, h: never) => ({
      width: Number(w),
      height: Number(h),
      data: new Uint8ClampedArray(Math.max(0, Number(w) * Number(h) * 4)),
    }),
  };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in fixed) {
        return (...args: never[]) => {
          calls.push(key);
          return fixed[key]?.(...args);
        };
      }
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        void args;
        calls.push(key);
      };
    },
    set(target, key, value) {
      if (typeof key === 'string') target[key] = value;
      return true;
    },
  }) as unknown as FakeContext;
}

// ---------------------------------------------------------------------------
// Document, window, and the address bar
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  kind: 'push' | 'replace';
  url: string;
}

export interface Harness {
  /** The `#app` element `src/main.ts` mounts into. */
  app: MElement;
  document: typeof doc;
  window: typeof win;
  /** Every address-bar write, in order, tagged with whether it added an entry. */
  history: HistoryEntry[];
  /** Fails every write, the way a browser with site data blocked does. */
  breakStorage(): void;
  /** Resolve or hang the canvas label face. `hang()` never settles, like a blackholed request. */
  fonts: {
    hang(): void;
    resolve(): void;
    /** A face that is still in flight. The returned function delivers it. */
    defer(): () => void;
    remove(): void;
  };
  /** Flip a media query and notify its listeners. */
  setMedia(query: string, matches: boolean): void;
  /** Run every frame callback the app has queued, once. */
  flushFrames(): void;
  find(predicate: (el: MElement) => boolean): MElement | undefined;
  findAll(predicate: (el: MElement) => boolean): MElement[];
  teardown(): void;
}

const BASE = 'http://localhost/math_playground/';

const doc = {
  documentElement: new MElement('html'),
  body: new MElement('body'),
  activeElement: null as MElement | null,
  fonts: undefined as unknown,
  listeners: new Map<string, Set<Listener>>(),
  createElement(tag: string): MElement {
    if (tag === 'input') return new MInput(tag);
    if (tag === 'select') return new MSelect(tag);
    if (tag === 'textarea') return new MTextArea(tag);
    return new MElement(tag);
  },
  createElementNS(_ns: string, tag: string): MElement {
    return new MElement(tag);
  },
  createTextNode(text: string): MText {
    return new MText(text);
  },
  querySelector(selector: string): MElement | null {
    return selector === '#app' ? app : null;
  },
  addEventListener(type: string, handler: Listener): void {
    let set = doc.listeners.get(type);
    if (!set) doc.listeners.set(type, (set = new Set()));
    set.add(handler);
  },
  removeEventListener(type: string, handler: Listener): void {
    doc.listeners.get(type)?.delete(handler);
  },
  dispatchEvent(event: MEvent): boolean {
    for (const handler of [...(doc.listeners.get(event.type) ?? [])]) handler(event);
    return !event.defaultPrevented;
  },
};

let app = new MElement('div');
let href = BASE;
const history: HistoryEntry[] = [];
const media = new Map<string, { matches: boolean; listeners: Set<(e: MEvent) => void> }>();
let frames: Array<(t: number) => void> = [];
let storageBroken = false;
const store = new Map<string, string>();

function fireHashChange(): void {
  const event = makeEvent('hashchange', { bubbles: false });
  for (const handler of [...(win.listeners.get('hashchange') ?? [])]) handler(event);
}

function mediaEntry(query: string): { matches: boolean; listeners: Set<(e: MEvent) => void> } {
  let entry = media.get(query);
  if (!entry) media.set(query, (entry = { matches: false, listeners: new Set() }));
  return entry;
}

const win = {
  listeners: new Map<string, Set<Listener>>(),
  devicePixelRatio: 1,
  location: {
    get href(): string {
      return href;
    },
    get hash(): string {
      const at = href.indexOf('#');
      return at < 0 ? '' : href.slice(at);
    },
    set hash(value: string) {
      const next = `${BASE}${value.startsWith('#') ? value : `#${value}`}`;
      // Assigning the fragment already in force is not a navigation.
      if (next === href) return;
      href = next;
      history.push({ kind: 'push', url: next });
      fireHashChange();
    },
    replace(url: string): void {
      if (url === href) return;
      href = url;
      history.push({ kind: 'replace', url });
      fireHashChange();
    },
  },
  history: {
    state: null as unknown,
    replaceState(state: unknown, _title: string, url: string): void {
      win.history.state = state;
      href = url.startsWith('#') ? `${BASE}${url}` : url;
      history.push({ kind: 'replace', url: href });
    },
  },
  matchMedia(query: string): {
    matches: boolean;
    media: string;
    addEventListener(type: string, handler: (e: MEvent) => void): void;
    removeEventListener(type: string, handler: (e: MEvent) => void): void;
  } {
    const entry = mediaEntry(query);
    return {
      get matches(): boolean {
        return entry.matches;
      },
      media: query,
      addEventListener: (_type, handler) => entry.listeners.add(handler),
      removeEventListener: (_type, handler) => entry.listeners.delete(handler),
    };
  },
  addEventListener(type: string, handler: Listener): void {
    let set = win.listeners.get(type);
    if (!set) win.listeners.set(type, (set = new Set()));
    set.add(handler);
  },
  removeEventListener(type: string, handler: Listener): void {
    win.listeners.get(type)?.delete(handler);
  },
  dispatchEvent(event: MEvent): boolean {
    for (const handler of [...(win.listeners.get(event.type) ?? [])]) handler(event);
    return !event.defaultPrevented;
  },
};

const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();

function define(name: string, value: unknown): void {
  if (!saved.has(name)) saved.set(name, globals[name]);
  globals[name] = value;
}

/**
 * Install the document and boot nothing. Call `await import('../src/main')`
 * afterwards — the module bootstraps on import — and `teardown()` when done.
 */
export function installDom(options: { hash?: string; devicePixelRatio?: number } = {}): Harness {
  app = new MElement('div');
  app.setAttribute('id', 'app');
  // The stage measures its host; without a size every backing store is 1x1.
  app.clientWidth = 900;
  app.clientHeight = 600;
  href = `${BASE}${options.hash ?? ''}`;
  history.length = 0;
  media.clear();
  frames = [];
  storageBroken = false;
  store.clear();
  doc.activeElement = doc.body;
  doc.fonts = undefined;
  doc.listeners.clear();
  win.listeners.clear();
  win.devicePixelRatio = options.devicePixelRatio ?? 1;
  doc.body.childNodes.length = 0;
  doc.body.appendChild(app);

  define('document', doc);
  define('window', win);
  define('location', win.location);
  define('history', win.history);
  define('devicePixelRatio', win.devicePixelRatio);
  define('Node', MNode);
  define('Element', MElement);
  define('HTMLElement', MElement);
  define('HTMLInputElement', MInput);
  define('HTMLSelectElement', MSelect);
  define('HTMLTextAreaElement', MTextArea);
  define('getComputedStyle', () => ({
    position: '',
    getPropertyValue: () => '',
  }));
  define('requestAnimationFrame', (cb: (t: number) => void) => {
    frames.push(cb);
    return frames.length;
  });
  define('cancelAnimationFrame', () => undefined);
  define('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageBroken) throw new Error('site data blocked');
      store.set(key, value);
    },
    removeItem: (key: string) => void store.delete(key),
  });

  /** Every element in the tree, so a test can find a control by its label. */
  const walk = (node: MNode, out: MElement[]): MElement[] => {
    if (node instanceof MElement) {
      out.push(node);
      for (const child of node.childNodes) walk(child, out);
    }
    return out;
  };

  return {
    app,
    document: doc,
    window: win,
    history,
    breakStorage(): void {
      storageBroken = true;
    },
    fonts: {
      hang(): void {
        doc.fonts = { load: () => new Promise<never>(() => undefined), ready: new Promise<never>(() => undefined) };
      },
      resolve(): void {
        doc.fonts = { load: () => Promise.resolve([]), ready: Promise.resolve() };
      },
      defer(): () => void {
        let deliver = (): void => undefined;
        const arrival = new Promise<void>((settle) => {
          deliver = () => settle();
        });
        doc.fonts = { load: () => arrival.then(() => []), ready: arrival };
        return deliver;
      },
      remove(): void {
        doc.fonts = undefined;
      },
    },
    setMedia(query: string, matches: boolean): void {
      const entry = mediaEntry(query);
      entry.matches = matches;
      for (const handler of [...entry.listeners]) handler(makeEvent('change', { matches }));
    },
    flushFrames(): void {
      const due = frames;
      frames = [];
      for (const cb of due) cb(0);
    },
    find(predicate): MElement | undefined {
      return walk(doc.body, []).find(predicate);
    },
    findAll(predicate): MElement[] {
      return walk(doc.body, []).filter(predicate);
    },
    teardown(): void {
      for (const [name, value] of saved) {
        if (value === undefined) delete globals[name];
        else globals[name] = value;
      }
      saved.clear();
      frames = [];
    },
  };
}

/** The first element carrying `aria-label`, for reaching a key by its name. */
export function byLabel(harness: Harness, label: string): MElement | undefined {
  return harness.find((el) => el.getAttribute('aria-label') === label);
}

/** Elements whose class attribute contains `name`. */
export function byClass(harness: Harness, name: string): MElement[] {
  return harness.findAll((el) => el.className.split(/\s+/).includes(name));
}
