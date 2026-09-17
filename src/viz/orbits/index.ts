import type {
  Fact,
  ParamSpec,
  ParamValue,
  ParamValues,
  Preset,
  Readout,
  Viz,
  VizContext,
  VizInstance,
} from '../../core/types';
import {
  NBody,
  SCENARIOS,
  SOFTENED_PERIOD_COEFF,
  SOFTENING,
  STEP,
  centreOfMass,
  energy,
  keplerPeriod,
  scenarioById,
  type Body,
  type Scenario,
} from './gravity';

/**
 * Simulated time units per second of the engine's clock.
 *
 * One unit per second makes a two-body orbit take 4.97 s and the figure-eight
 * 6.33 s, which is a watchable pace at 1× and gives the speed picker somewhere
 * to go. The engine's 120 Hz tick is therefore 160 Verlet steps of `STEP`.
 */
const TIME_SCALE = 1;

/**
 * Where a run stops, in simulated time units.
 *
 * Twelve orbits of the two-body scenario, nine and a half figure-eights, and —
 * the number that actually decides it — the whole of the three-body
 * arrangement's measured good behaviour: it stays inside the view and clear of
 * a deep encounter for 60 units, and this tab does not claim anything about
 * what it does afterwards.
 */
const MAX_TIME = 60;

/** Simulated time between trail samples: sixty a second at 1×. */
const TRAIL_INTERVAL = 1 / 60;

/**
 * Trail samples kept per body, so the painted trail is 12 simulated time units
 * long however long the run has been going.
 *
 * Two and a half two-body orbits and nearly two figure-eights: enough that the
 * closed loop is drawn whole and a reader can see it is closed, and bounded so
 * the chaotic arrangement does not end as a solid scribble. Buffon learned this
 * at 20,000 needles — the ink budget is the picture, and a ring buffer is what
 * makes it independent of the run length rather than of the frame count.
 */
const TRAIL_POINTS = 720;

/** Verlet steps between trail samples. */
const TRAIL_STRIDE = Math.round(TRAIL_INTERVAL / STEP);

/**
 * Alpha bands the trail is drawn in, oldest to newest, and the alpha the oldest
 * band gets.
 *
 * Eight bands are indistinguishable from a continuous ramp at these widths and
 * cost eight strokes per body instead of one per segment. The newest band is at
 * full strength, so every body's current heading is carried by a mark at the
 * pen's own 4.80:1 on the plate; the ghosts behind it are what the eye reads as
 * "where it has been" and are not asked to carry anything.
 */
const TRAIL_BANDS = 8;
const TRAIL_FAINTEST = 0.12;

/**
 * Drawn radius of a unit mass, CSS px, and the floor under it.
 *
 * Radius goes as the cube root of the mass — the width of a body of that mass
 * at a fixed density, which is what a disc on a plate reads as. Encoding mass
 * as *area* is the textbook answer for a chart and the wrong one here: it would
 * put the 0.6 mass at 77 % of the width instead of 84 %, and on a phone the
 * floor would be doing all the work anyway. The floor is what keeps a light
 * body a body.
 */
const BODY_RADIUS = 6;
const MIN_BODY_RADIUS = 3;

/** Radius of the open circle marking the centre of mass, CSS px. */
const COM_RADIUS = 4;

const TAU = 2 * Math.PI;

const DEFAULT_SEED = 42;
const DEFAULT_SCENARIO = 'two';
/** Twin offset as a percentage of the picture's width. See the `twin` spec. */
const DEFAULT_TWIN = 0.02;

const params: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'scenario',
    label: 'Bodies',
    options: SCENARIOS.map((s) => ({ value: s.id, label: s.label })),
    default: DEFAULT_SCENARIO,
    help: 'Two bodies repeat for ever. Three bodies almost never do — the figure eight is the famous exception.',
  },
  {
    // The moment this tab exists for, in one knob. The scenario control gets a
    // reader to three bodies; this one is what shows that three bodies are not
    // merely more complicated than two, they are *unpredictable* — a second run
    // started closer than a pixel ends up somewhere else entirely, and the same
    // knob on two bodies does nothing at all, which is the comparison that
    // makes the point land.
    //
    // A trail-length fader was the other candidate and lost: it changes how the
    // picture looks and nothing about what it says.
    kind: 'range',
    key: 'twin',
    label: 'Twin offset',
    min: 0,
    max: 0.2,
    step: 0.002,
    default: DEFAULT_TWIN,
    unit: '%',
    help: 'A second run starts this far from the first, as a share of the picture’s width. At 0.02 % they begin a seventh of a pixel apart. Zero leaves one run.',
  },
  // Not a control — the rail never renders this kind — but the spec is what
  // binds the seed to the URL. The seed picks the direction the twin is
  // nudged in and nothing else: the first run has no randomness in it
  // anywhere, which is the whole point of putting this tab last.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

/**
 * Three, and the third one is the whole argument.
 *
 * `ui/story.ts` shows the first three chips and no more, so a fourth would be a
 * preset nobody could reach — and the one that would have been dropped is the
 * one the tab exists for. Every chip leaves the twin running at the default
 * offset, because the comparison only lands if the reader has already watched
 * the second run sit invisibly under the first on two bodies.
 */
const presets: readonly Preset[] = [
  {
    id: 'two-bodies',
    label: 'Two bodies',
    caption: 'Two bodies pull on each other and go round the same closed loop for ever, which is why an eclipse can be predicted centuries ahead.',
    values: { scenario: 'two', twin: DEFAULT_TWIN },
  },
  {
    id: 'figure-eight',
    label: 'Figure eight',
    caption: 'Three bodies can repeat, but only from this one arrangement, balanced on a knife edge and found by computer search in 1993.',
    values: { scenario: 'figure-eight', twin: DEFAULT_TWIN },
  },
  {
    id: 'a-whisker-apart',
    label: 'Three bodies',
    caption: 'The second run starts a fraction of a pixel from the first and ends up on the other side of the picture, which is what unpredictable means here.',
    values: { scenario: 'three', twin: DEFAULT_TWIN },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Poincaré found in 1890 that three bodies have no formula you can write down, and that two starts a hair apart ' +
      'end up nowhere near each other — the first description of what we now call chaos.',
    source: {
      label: 'Wikipedia, Three-body problem',
      url: 'https://en.wikipedia.org/wiki/Three-body_problem',
    },
  },
  {
    text:
      'Three equal masses can chase each other round a single figure eight for ever, an orbit Moore found by computer ' +
      'search in 1993 and Chenciner and Montgomery proved really exists in 2000.',
    source: {
      label: 'Moore, “Braids in Classical Dynamics”, Phys. Rev. Lett. 70, 3675 (1993)',
      url: 'https://doi.org/10.1103/PhysRevLett.70.3675',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

function text(values: ParamValues, key: string, fallback: string): string {
  const v = values[key];
  return typeof v === 'string' ? v : fallback;
}

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/** Drawn radius of a body, CSS px. */
export function bodyRadius(mass: number, particleRadius: number): number {
  return Math.max(MIN_BODY_RADIUS, particleRadius, BODY_RADIUS * Math.cbrt(Math.max(mass, 0)));
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/**
 * A body's recent path, in **world** coordinates.
 *
 * World, not pixels, for the same reason Buffon stores its needles as
 * fractions: the plate in front of the reader now decides where a sample lands,
 * so a resize re-lays-out the trail already drawn instead of stranding it at
 * coordinates the plate no longer has.
 */
class Trail {
  private readonly xs = new Float32Array(TRAIL_POINTS);
  private readonly ys = new Float32Array(TRAIL_POINTS);
  private head = 0;
  private stored = 0;

  get count(): number {
    return this.stored;
  }

  push(x: number, y: number): void {
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = this.head + 1 === TRAIL_POINTS ? 0 : this.head + 1;
    if (this.stored < TRAIL_POINTS) this.stored++;
  }

  /** The `i`-th oldest sample held, 0 ≤ i < count. */
  x(i: number): number {
    return this.xs[this.slot(i)] ?? 0;
  }

  y(i: number): number {
    return this.ys[this.slot(i)] ?? 0;
  }

  reset(): void {
    this.head = 0;
    this.stored = 0;
  }

  private slot(i: number): number {
    // Until the ring wraps the oldest sample is slot 0; afterwards it is the
    // slot `head` is about to overwrite.
    const start = this.stored < TRAIL_POINTS ? 0 : this.head;
    const slot = start + i;
    return slot >= TRAIL_POINTS ? slot - TRAIL_POINTS : slot;
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface View {
  /** CSS px per world length unit. */
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Fit a scenario's declared world box onto the plate, centred, with one scale
 * for both axes.
 *
 * Isotropic by construction: a separate x and y scale would turn a circular
 * orbit into an ellipse and the tab would be lying about the one thing it is
 * for. The box is a property of the scenario rather than of the run, because
 * there is no randomness anywhere here — a scenario is one fixed curve, and its
 * extent was measured once.
 */
export function viewFor(width: number, height: number, scenario: Scenario): View {
  const scale = Math.min(width / (2 * scenario.view.x), height / (2 * scenario.view.y));
  return { scale: Math.max(scale, 1e-6), cx: width / 2, cy: height / 2 };
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

function create(ctx: VizContext): VizInstance {
  let scenario: Scenario = scenarioById(text(ctx.params, 'scenario', DEFAULT_SCENARIO));

  let primary = new NBody(scenario.bodies());
  /** The second run, or null when the offset is zero and there is only one. */
  let twin: NBody | null = null;

  let trails: Trail[] = [];
  let twinTrails: Trail[] = [];

  let view: View = viewFor(ctx.width, ctx.height, scenario);
  /** The geometry `drawBackground()` last painted for, so a repaint that changes nothing costs nothing. */
  let painted = '';

  /** Verlet steps taken, and the simulated time they amount to. */
  let steps = 0;
  let time = 0;
  /** Fractional simulated time owed between engine ticks. */
  let pending = 0;

  let startEnergy = 0;

  /** Two-body period measurement: the relative y last step, and the completed turns. */
  let previousRelY = 0;
  let turns = 0;
  let lastTurnAt = 0;

  /** The twin's starting offset in world units, and the direction it was taken in. */
  let offset = 0;

  function twinOffset(): number {
    // A percentage of the picture's width, so the number in the rail means the
    // same thing to a reader on every scenario: 0.02 % of a 705 px plate is a
    // seventh of a pixel whatever the world units happen to be.
    return (num(ctx.params, 'twin', DEFAULT_TWIN) / 100) * 2 * scenario.view.x;
  }

  /**
   * A unit vector from the seeded stream, by rejection on the unit disc.
   *
   * Arithmetic and one square root, with no `Math.cos`: the direction of the
   * nudge is the only thing on this tab that is drawn rather than derived, and
   * the trigonometric functions are the one part of the language whose last bit
   * is not pinned across engines. A run that is meant to be reproducible from a
   * permalink should not depend on one.
   */
  function randomDirection(): { x: number; y: number } {
    for (let i = 0; i < 64; i++) {
      const x = ctx.rng.range(-1, 1);
      const y = ctx.rng.range(-1, 1);
      const r2 = x * x + y * y;
      if (r2 > 1e-12 && r2 <= 1) {
        const r = Math.sqrt(r2);
        return { x: x / r, y: y / r };
      }
    }
    return { x: 1, y: 0 };
  }

  function buildTwin(): void {
    offset = twinOffset();
    if (!(offset > 0)) {
      twin = null;
      twinTrails = [];
      return;
    }
    const nudged = scenario.bodies();
    const first = nudged[0];
    const dir = randomDirection();
    if (first) {
      first.x += offset * dir.x;
      first.y += offset * dir.y;
    }
    twin = new NBody(nudged);
    twinTrails = nudged.map(() => new Trail());
  }

  function sampleTrails(): void {
    primary.bodies.forEach((b, i) => trails[i]?.push(b.x, b.y));
    if (twin) twin.bodies.forEach((b, i) => twinTrails[i]?.push(b.x, b.y));
  }

  /**
   * One completed turn of the two-body orbit, timed.
   *
   * The relative separation crosses y = 0 on the far side once per orbit, and
   * the crossing is interpolated inside the step it happened in, so a turn is
   * located to far better than the step itself. Dividing the n-th crossing by n
   * is what makes the band on the measured period shrink: the timing error is
   * one step for the first orbit and a twelfth of a step by the twelfth.
   *
   * No `Math.atan2`, for the reason `randomDirection()` gives, and because a
   * zero crossing is exact arithmetic where an accumulated angle is a sum of
   * rounding errors.
   */
  function detectTurn(): void {
    const a = primary.bodies[0];
    const b = primary.bodies[1];
    if (!a || !b) return;
    const dy = b.y - a.y;
    if (previousRelY < 0 && dy >= 0 && b.x - a.x > 0) {
      const fraction = previousRelY / (previousRelY - dy);
      turns++;
      lastTurnAt = (steps - 1) * STEP + fraction * STEP;
    }
    previousRelY = dy;
  }

  /** Largest distance between a body and its twin, in world units. NaN with no twin. */
  function separation(): number {
    if (!twin) return Number.NaN;
    let worst = 0;
    for (let i = 0; i < primary.bodies.length; i++) {
      const a = primary.bodies[i];
      const b = twin.bodies[i];
      if (!a || !b) continue;
      worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y));
    }
    return worst;
  }

  /** The energy drift the hero publishes: the change since the start, as a share of the start. */
  function drift(): number {
    return (energy(primary.bodies) - startEnergy) / Math.abs(startEnergy);
  }

  function readouts(): Readout[] {
    const width = 2 * scenario.view.x;
    const gap = separation();
    const out: Readout[] = [
      {
        key: 'drift',
        label: 'Energy drift',
        value: drift(),
        digits: 3,
        target: 0,
        formula: ['(', { v: 'E' }, ' − ', { v: 'E' }, '₀) / |', { v: 'E' }, '₀|'],
        plain: 'how much the total energy has slipped since the start',
        headline: true,
        hint: 'nothing in this tab is random, so a reading that stays at zero is what tells you the picture is the physics and not the arithmetic',
        // The amplitude of velocity Verlet's own energy oscillation at this
        // step, measured over a full run and given an order of magnitude of
        // headroom — see `Scenario.energyEnvelope`. It is a rounding allowance,
        // not a tolerance: the claim is that a symplectic integrator stays
        // inside a fixed envelope for ever, and an integrator that loses energy
        // secularly walks out of it and keeps going.
        band: { kind: 'absolute', half: scenario.energyEnvelope },
        // A prediction of exactly zero is no scale of its own, so `readouts.ts`
        // has nothing to judge the band against unless the reading says how far
        // it could travel. This one is a share of the starting energy: ±1 is the
        // whole of it, which is as wrong as the arithmetic could possibly be.
        range: [-1, 1],
      },
      {
        key: 'separation',
        // In the same unit the knob is set in, so the two numbers can be read
        // against each other: started at 0.02 % of the picture, now at 40 %.
        // The label says *of what*, because this row is only ever reached
        // through the ledger — by a screen reader or in print — where a bare
        // "111 %" is a percentage of nothing in particular.
        label: 'Twin separation, share of the view',
        value: (100 * gap) / width,
        digits: 3,
        unit: '%',
        plain: 'how far the second run has drifted from the first, across the picture',
      },
      { key: 'energy', label: 'Total energy', value: energy(primary.bodies), digits: 9, expertOnly: true },
      { key: 'time', label: 'Simulated time', value: time, digits: 4, expertOnly: true },
    ];

    const kepler = scenario.kepler;
    if (kepler) {
      const predicted = keplerPeriod(kepler.a, kepler.gm);
      // The softening lengthens a circular orbit by SOFTENED_PERIOD_COEFF·(ε/a)²
      // of it — 1.49·10⁻⁵ here — and no amount of orbiting makes that go away,
      // so the band is floored at twice it. Above that floor it is the timing
      // resolution: one integration step, divided by the turns the measurement
      // averages over.
      const shift = SOFTENED_PERIOD_COEFF * (SOFTENING / kepler.a) ** 2 * predicted;
      out.splice(2, 0, {
        key: 'period',
        label: 'Orbital period',
        value: turns > 0 ? lastTurnAt / turns : Number.NaN,
        digits: 7,
        target: predicted,
        formula: ['2', { v: 'π' }, '√(', { v: 'a' }, '³/', { v: 'GM' }, ')'],
        plain: 'how long one full circuit takes',
        band: { kind: 'absolute', half: 2 * shift + (turns > 0 ? STEP / turns : STEP) },
      });
      out.push({ key: 'turns', label: 'Completed orbits', value: turns, digits: 4, expertOnly: true });
    }

    const com = centreOfMass(primary.bodies);
    out.push({
      key: 'com',
      label: 'Centre-of-mass offset',
      value: Math.hypot(com.x, com.y),
      digits: 3,
      expertOnly: true,
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function syncView(): void {
    view = viewFor(ctx.width, ctx.height, scenario);
  }

  const toX = (x: number): number => view.cx + x * view.scale;
  const toY = (y: number): number => view.cy - y * view.scale;

  /**
   * One body's trail, in `bands` strokes of rising alpha.
   *
   * Bands overlap by one sample so the polyline has no gaps where the alpha
   * steps; a gap in a trail reads as the body having jumped.
   */
  function strokeTrail(fg: CanvasRenderingContext2D, trail: Trail, pen: string, width: number): void {
    const n = trail.count;
    if (n < 2) return;
    fg.strokeStyle = pen;
    fg.lineWidth = width;
    fg.lineJoin = 'round';
    fg.lineCap = 'round';
    for (let band = 0; band < TRAIL_BANDS; band++) {
      const from = Math.floor((band * (n - 1)) / TRAIL_BANDS);
      const to = Math.floor(((band + 1) * (n - 1)) / TRAIL_BANDS);
      if (to <= from) continue;
      fg.globalAlpha = TRAIL_FAINTEST + (1 - TRAIL_FAINTEST) * ((band + 1) / TRAIL_BANDS);
      fg.beginPath();
      fg.moveTo(toX(trail.x(from)), toY(trail.y(from)));
      for (let i = from + 1; i <= to; i++) fg.lineTo(toX(trail.x(i)), toY(trail.y(i)));
      fg.stroke();
    }
    fg.globalAlpha = 1;
  }

  /** Every body of one run as a filled disc, in one path and one fill. */
  function fillBodies(fg: CanvasRenderingContext2D, bodies: readonly Body[], pen: string): void {
    fg.fillStyle = pen;
    fg.beginPath();
    for (const b of bodies) {
      const r = bodyRadius(b.mass, ctx.theme.particleRadius);
      const x = toX(b.x);
      const y = toY(b.y);
      fg.moveTo(x + r, y);
      fg.arc(x, y, r, 0, TAU);
    }
    fg.fill();
  }

  const instance: VizInstance = {
    step(dt) {
      if (time >= MAX_TIME) {
        pending = 0;
        return;
      }
      pending += (dt / 1000) * TIME_SCALE;
      // A fixed step, always, whatever the clock hands in: the energy envelope
      // the hero is judged against was measured at this step and at no other,
      // and a step that varied with the frame rate would make the headline a
      // different claim on every machine.
      while (pending >= STEP && time < MAX_TIME) {
        primary.step(STEP);
        twin?.step(STEP);
        pending -= STEP;
        steps++;
        time = steps * STEP;
        if (scenario.kepler) detectTurn();
        if (steps % TRAIL_STRIDE === 0) sampleTrails();
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the view.
      syncView();
      // The pens are part of what was painted, not just the geometry. The shell
      // calls this again when the reader changes the colour scheme, and with
      // only the size and the scenario in the signature that call was skipped:
      // the axes and the centre of mass stayed in the previous scheme's ink on
      // the new bed, which is the one thing this layer must never do, because it
      // is the layer nothing else repaints.
      const signature = `${ctx.width}×${ctx.height}×${scenario.id}×${ctx.theme.gridSoft}×${ctx.theme.lineWidth}`;
      if (signature === painted) return;
      painted = signature;

      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);

      // The centre of mass and the axes through it are the frame around the
      // experiment, not the experiment, so they take the container pen. With
      // zero total momentum the centre of mass never moves, which is exactly
      // why it belongs on the layer that is painted once: it is the one fixed
      // point in a picture where everything else is falling.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const x = Math.round(toX(0)) + snap;
      const y = Math.round(toY(0)) + snap;
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      bg.moveTo(0, y);
      bg.lineTo(width, y);
      bg.moveTo(x, 0);
      bg.lineTo(x, height);
      bg.stroke();

      bg.beginPath();
      bg.moveTo(x + COM_RADIUS, y);
      bg.arc(x, y, COM_RADIUS, 0, TAU);
      bg.stroke();
    },

    draw() {
      syncView();
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // The twin goes down first, so where the two runs still agree the reader
      // sees the first one and not a blue disc sitting on top of it.
      const trailWidth = 2 * theme.lineWidth;
      if (twin) {
        for (const trail of twinTrails) strokeTrail(fg, trail, theme.data2, trailWidth);
        fillBodies(fg, twin.bodies, theme.data2);
      }
      for (const trail of trails) strokeTrail(fg, trail, theme.data1, trailWidth);
      fillBodies(fg, primary.bodies, theme.data1);

      // Live energy drift in the top-right as a display window: an opaque plate
      // of the canvas colour with a container-pen frame, the way Buffon prints
      // its π. Published through emit() below as well; the canvas itself is
      // aria-hidden, so the window is the sighted reader's copy and the ledger
      // is everyone else's.
      const label = `ΔE/E ${formatDrift(drift())}`;
      const margin = 10;
      const pad = 5;
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      const textW = fg.measureText(label).width;
      const textH = fontPx(theme.labelFont);
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const plateX = Math.round(width - margin - textW - pad);
      const plateY = Math.round(margin - pad);
      const plateW = Math.round(textW + 2 * pad);
      const plateH = Math.round(textH + 2 * pad);
      fg.fillStyle = theme.canvas;
      fg.fillRect(plateX, plateY, plateW, plateH);
      fg.strokeStyle = theme.gridSoft;
      fg.lineWidth = theme.lineWidth;
      fg.strokeRect(plateX + snap, plateY + snap, plateW - 2 * snap, plateH - 2 * snap);
      fg.fillStyle = theme.ink;
      fg.fillText(label, width - margin, margin);

      // Which run is which. Two words and two dashes, no numbers, painted only
      // when there is a second run to tell apart — a key naming one thing is a
      // label for the whole plate, which the title already is.
      if (twin) {
        fg.textAlign = 'left';
        fg.lineWidth = trailWidth;
        const keyY = margin + textH / 2;
        const dash = 14;
        for (const [row, pen, name] of [
          [0, theme.data1, 'this run'],
          [1, theme.data2, 'a whisker away'],
        ] as const) {
          const ky = Math.round(keyY + row * (textH + 6)) + snap;
          fg.strokeStyle = pen;
          fg.beginPath();
          fg.moveTo(margin, ky);
          fg.lineTo(margin + dash, ky);
          fg.stroke();
          fg.fillStyle = theme.inkMuted;
          fg.fillText(name, margin + dash + 6, ky - textH / 2);
        }
      }

      ctx.emit(readouts());
    },

    // No onParamChange: both knobs are structural. A new scenario is a new
    // experiment, and a new twin offset is a different second run that has to
    // start alongside the first rather than be nudged mid-flight. The shell
    // resets on each of them.

    reset() {
      scenario = scenarioById(text(ctx.params, 'scenario', DEFAULT_SCENARIO));
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      primary = new NBody(scenario.bodies());
      trails = primary.bodies.map(() => new Trail());
      buildTwin();
      startEnergy = energy(primary.bodies);
      steps = 0;
      time = 0;
      pending = 0;
      turns = 0;
      lastTurnAt = 0;
      const a = primary.bodies[0];
      const b = primary.bodies[1];
      previousRelY = a && b ? b.y - a.y : 0;
      syncView();
      // The background is keyed on the geometry it was painted for, and the
      // scenario is part of that geometry: a reset that changes the scenario
      // has to repaint the axes for the new view.
      painted = '';
      sampleTrails();
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

/**
 * The drift for the in-canvas window: a signed exponent, or an exact zero.
 *
 * `toExponential` rather than `fmt()` because the quantity spans 10⁻¹⁴ to 10⁻⁶
 * across the scenarios and a fixed-point rendering of it is a row of zeros. The
 * ledger prints the same number through `fmt()`, where the hero's own rules
 * apply.
 */
export function formatDrift(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '= 0';
  return `≈ ${value.toExponential(1)}`;
}

export const orbits: Viz = {
  id: 'orbits',
  title: 'Two Bodies, Three Bodies',
  group: 'chaos',
  blurb:
    'Two bodies pulling on each other trace the same closed loop forever — that is why we can predict eclipses ' +
    'centuries ahead. Add a third and the whole thing becomes unpredictable, no matter how precisely you measure ' +
    'where they started.',
  // Landscape, because the orbits are: the figure eight is three times as wide
  // as it is tall, and the three-body arrangement is 3.0 by 2.6. Square on a
  // phone, where a 1.6 bed would fit the eight and crush the other two.
  aspect: 1.6,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  // Three bodies, and the twin run's three alongside them.
  budget: { maxEntities: 6 },
  create,
};
