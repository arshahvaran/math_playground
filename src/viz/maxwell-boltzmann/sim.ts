import type { Rng } from '../../core/types';
import { bandShare, sampleSpeed } from './gas';

/**
 * The bead machine: the plate's geometry and the motion of every bead. Pure,
 * canvas-free, and exercised end to end by tests/maxwell-boltzmann.test.ts.
 *
 * The machine is the one in the clip this tab answers. A hopper of beads sits
 * over a fan; the air lifts one bead at a time to a port at the top of a wall
 * and fires it out horizontally; it falls onto a row of slots and stays in the
 * one it reaches.
 *
 * What makes it a speedometer is that every bead falls the *same height*. A
 * horizontal launch leaves the vertical motion untouched, so every flight from
 * the port to the mouths of the slots lasts the same `FLIGHT_S`, and a bead
 * fired at speed v lands v·FLIGHT_S along — distance is speed times a constant.
 * Slots of equal width are then bands of equal speed, and the piles are a
 * histogram of the speeds before a single number has been read.
 *
 * Two layers that never touch, as on the Galton board. The *statistics* are
 * decided at release: the speed is drawn there, and with it the slot, so the
 * slot counts are exactly the Maxwell–Boltzmann law binned 100 m/s at a time,
 * for a seed, at every frame rate, step size and plate size. The *motion* is
 * then a true parabola from the port to the mouths — the one part of the
 * picture whose shape is the lesson — and two small fictions either side of
 * it: the air lift out of the hopper, which is a smooth curve rather than a
 * model of a jet, and the rattle inside a slot, where one bounce off the far
 * divider is followed by a fall steered gently onto the bead's place in the
 * pile.
 *
 * ## Units
 *
 * The motion is kept in the machine's own units so that a resize mid-run
 * changes nothing in the air: `x` in slot widths from the port's exit, which
 * is the left edge of slot 0, and `y` in drops — the height from the port to
 * the mouths — downward from the port. The mouths are at y = 1 and slot k
 * spans x ∈ [k, k + 1). Gravity in these units is 2/FLIGHT_S², whatever the
 * plate.
 */

/** Slots along the floor, and the band of speed each one holds, m/s. */
export const SLOTS = 20;
export const SLOT_SPEED = 100;

/**
 * The speed at the far wall. Slot k holds [100k, 100k + 100) m/s and the last
 * one, which ends at the case wall, everything from 1,900 m/s up: a bead
 * faster than the far wall strikes it and drops into that slot.
 */
export const TOP_SPEED = SLOTS * SLOT_SPEED;

/**
 * Seconds from the port to the mouths of the slots, for every bead. Fixed in
 * time rather than derived from a gravity in px/s², so the run looks the same
 * on a phone and on a monitor: four-fifths of a second is long enough to
 * follow one arc and short enough that the air is never crowded.
 */
export const FLIGHT_S = 0.8;

/** Seconds a bead takes to ride the air from the top of the hopper to the port. */
export const LIFT_S = 0.35;

/** Milliseconds from release to the mouth of the slots: the instant a bead is counted. */
export const COUNT_MS = (LIFT_S + FLIGHT_S) * 1000;

/** Gravity in drops per s²: the value that brings a bead down one drop in FLIGHT_S. */
export const GRAVITY = 2 / (FLIGHT_S * FLIGHT_S);

/**
 * Restitution off a divider and off the pile. A bead hitting a painted wooden
 * divider gives back little; a bead landing on a bed of beads gives back less
 * still, and a second hop is usually too small to draw.
 */
const WALL_RESTITUTION = 0.3;
const PILE_RESTITUTION = 0.3;

/** A hop lower than this, in drops, is not animated: the bead is at rest. */
const MIN_HOP = 0.008;

/** Largest flying-bead radius the slot walls are allowed to assume, in slot widths. */
const MAX_BEAD_RADIUS = 0.25;

/** Slot for a speed: the band it falls in, with everything past the far wall in the last. */
export function slotOf(v: number): number {
  return Math.min(SLOTS - 1, Math.max(0, Math.floor(v / SLOT_SPEED)));
}

/** P(a bead lands in slot `k`) for thermal scale `a`. The last slot is open-ended. */
export function slotShare(k: number, a: number): number {
  const lo = k * SLOT_SPEED;
  return bandShare(lo, k === SLOTS - 1 ? Infinity : lo + SLOT_SPEED, a);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Plate margin, axis tick, gap to the numerals and the numeral row, CSS px — arcsine's. */
const PAD = 8;
export const TICK = 4;
export const LABEL_GAP = 3;
const LABEL_ROW = 14;

/**
 * Room between the machine's floor and the chart, CSS px: the chart's caption
 * sits in it, so it is a line of label text and a little air.
 */
const GAP = 22;

/** The chart's share of the plate under the margin, and the least of either half worth drawing. */
const CHART_SHARE = 0.34;
const MIN_CHART = 50;
const MIN_MACHINE = 120;

/**
 * Width of the column that holds the hopper and the fan, as a share of the
 * case. The rest is the flight and the slots, and every pixel of it is speed
 * resolution, so the column is as narrow as a hopper can be and still read as
 * one.
 */
const COLUMN_SHARE = 0.2;
const MIN_COLUMN = 44;

/** Heights inside the machine, as shares of lid-to-floor. */
const MOUTH_SHARE = 0.36;
const HOPPER_TOP_SHARE = 0.3;
const MESH_SHARE = 0.66;
const FAN_TOP_SHARE = 0.71;

/** The gap between the top of the wall and the lid that the beads leave through, CSS px. */
export const PORT_GAP = 12;

/** Thickness of the case and of the wall, CSS px: the container pen at twice the hairline. */
export const FRAME = 2;

export interface PlateLayout {
  width: number;
  height: number;
  /** The case: its left and right walls, its lid and its floor. */
  left: number;
  right: number;
  lid: number;
  floor: number;
  /** The wall's right face, which is the port's exit and the left edge of slot 0. */
  slotLeft: number;
  /** The case's right wall, which is the right edge of the last slot. */
  slotRight: number;
  slotWidth: number;
  /** Centre line of the port: where every flight begins. */
  portY: number;
  /** The mouths of the slots: where every flight ends and the dividers begin. */
  mouthY: number;
  /** Port to mouths, and mouths to floor, CSS px. */
  drop: number;
  depth: number;
  /** Inside of the column, left of the wall. */
  columnLeft: number;
  columnRight: number;
  /** Where a full hopper's pile reaches, and the mesh it rests on. */
  hopperTop: number;
  mesh: number;
  /** The fan's chamber, and the fan inside it. */
  fanTop: number;
  fanX: number;
  fanY: number;
  fanR: number;
  /** The chart: its top and its baseline. It spans slotLeft to slotRight. */
  chartTop: number;
  chartBase: number;
}

/**
 * Where everything sits on a plate `width` × `height`, CSS px.
 *
 * From the plate alone — never from the text of a number or from the run — so
 * the only thing that moves between frames is the data. The chart sits under
 * the slots and spans exactly their width, so slot k and bar k are one column
 * of the plate, and the eye can drop from a pile to its share without a scale
 * to translate through.
 */
export function layoutPlate(width: number, height: number): PlateLayout {
  const left = PAD;
  const right = Math.max(left + MIN_COLUMN + SLOTS, width - PAD);
  const lid = PAD;
  const chartBase = Math.max(
    lid + MIN_MACHINE + GAP + MIN_CHART,
    height - PAD - TICK - LABEL_GAP - LABEL_ROW,
  );
  const body = chartBase - lid;
  const chartHeight = Math.max(MIN_CHART, Math.min(CHART_SHARE * body, body - GAP - MIN_MACHINE));
  const chartTop = chartBase - chartHeight;
  const floor = chartTop - GAP;
  const tall = floor - lid;

  const column = Math.max(MIN_COLUMN, COLUMN_SHARE * (right - left));
  const slotLeft = left + column;
  const slotWidth = (right - slotLeft) / SLOTS;

  const portY = lid + PORT_GAP / 2;
  const mouthY = lid + MOUTH_SHARE * tall;
  const fanTop = lid + FAN_TOP_SHARE * tall;
  const columnLeft = left + FRAME;
  const columnRight = slotLeft - FRAME;
  const fanR = Math.max(4, 0.42 * Math.min(columnRight - columnLeft, floor - fanTop));

  return {
    width,
    height,
    left,
    right,
    lid,
    floor,
    slotLeft,
    slotRight: right,
    slotWidth,
    portY,
    mouthY,
    drop: mouthY - portY,
    depth: floor - mouthY,
    columnLeft,
    columnRight,
    hopperTop: lid + HOPPER_TOP_SHARE * tall,
    mesh: lid + MESH_SHARE * tall,
    fanTop,
    fanX: (columnLeft + columnRight) / 2,
    fanY: (fanTop + floor) / 2,
    fanR,
    chartTop,
    chartBase,
  };
}

/**
 * How the hopper's beads are packed: a grid of `cols` per row at `pitch`,
 * filling from the mesh up. The pitch is the largest that fits the whole run
 * in the hopper, and never more than a flying bead, so a full hopper of fifty
 * is fifty beads at the bottom of a tall box and a full hopper of five
 * thousand is a box packed to the brim.
 */
/** A hopper bead's drawn radius, as a share of the packing pitch. */
const HOPPER_BEAD = 0.4;

export interface HopperGrid {
  /** Left edge of the packing and the mesh it stands on, CSS px. */
  left: number;
  bottom: number;
  pitch: number;
  cols: number;
  /** Drawn radius of a bead in the hopper. */
  radius: number;
}

export function hopperGrid(L: PlateLayout, beads: number, particleRadius: number): HopperGrid {
  const w = Math.max(1, L.columnRight - L.columnLeft - 2);
  const h = Math.max(1, L.mesh - L.hopperTop);
  const n = Math.max(1, Math.floor(beads));
  let pitch = Math.min(2 * particleRadius, Math.sqrt((w * h) / n));
  // The square-root pitch is exact only when a row divides evenly; shrink it
  // until the rows the run needs actually stand inside the hopper.
  for (let i = 0; i < 60 && Math.ceil(n / Math.max(1, Math.floor(w / pitch))) * pitch > h; i++) pitch *= 0.97;
  const cols = Math.max(1, Math.floor(w / pitch));
  return {
    left: L.columnLeft + 1 + (w - cols * pitch) / 2,
    bottom: L.mesh,
    pitch,
    cols,
    // Smaller than the pitch, so a full hopper reads as a heap of beads with
    // light between them rather than as a vermilion slab.
    radius: HOPPER_BEAD * pitch,
  };
}

/** Centre of the hopper's `j`-th bead, counted from the bottom-left, CSS px. */
export function hopperPlace(g: HopperGrid, j: number): { x: number; y: number } {
  const col = j % g.cols;
  const row = Math.floor(j / g.cols);
  return { x: g.left + (col + 0.5) * g.pitch, y: g.bottom - (row + 0.5) * g.pitch };
}

/**
 * Resting place of the bead that arrived `stack`-th in its slot: lateral
 * offset from the slot's centre line and depth below the mouth, CSS px. The
 * Galton board's packing, to the pixel: `cols` per row at a pitch of
 * 2·dotRadius, filling from the floor up, and never above the mouth.
 */
export function restSlot(
  cols: number,
  dotRadius: number,
  depth: number,
  stack: number,
): { dx: number; depth: number } {
  const n = Math.max(1, Math.floor(cols));
  const col = stack % n;
  const row = Math.floor(stack / n);
  return {
    dx: (2 * col + 1 - n) * dotRadius,
    depth: Math.max(dotRadius, depth - dotRadius - row * 2 * dotRadius),
  };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface MachineParams {
  /** Beads in the hopper at the start; the run ends when they have all been fired. */
  beads: number;
  /** Release rate, beads per second of simulation time. */
  launchRate: number;
  /** Thermal scale a = √(kT/m), m/s. */
  scale: number;
}

/**
 * The parts of the plate the motion needs, CSS px. The renderer derives them
 * from `layoutPlate()` and its pile and hopper metrics and hands them over
 * through `setGeometry()`; the defaults are a desktop plate, so a machine that
 * is never shown one — the tests — still moves at a sensible scale.
 */
export interface MachineGeometry {
  slotWidth: number;
  drop: number;
  depth: number;
  /** Radius of a bead in flight. */
  beadRadius: number;
  /** Radius of a bead in a pile, and beads per row of a pile. */
  dotRadius: number;
  cols: number;
  /** The hopper's packing, with x and y measured from the port's exit. */
  hopper: HopperGrid;
}

export const DEFAULT_GEOMETRY: Readonly<MachineGeometry> = {
  slotWidth: 25,
  drop: 110,
  depth: 200,
  beadRadius: 2,
  dotRadius: 1.5,
  cols: 8,
  hopper: { left: -118, bottom: 200, pitch: 3, cols: 38, radius: 1.5 },
};

/** Where a bead is in its life. Each phase is one closed-form segment. */
export const LIFT = 0;
export const FLIGHT = 1;
export const FALL = 2;
export const HOP = 3;
export const REST = 4;

/** Per-bead flags. */
const COUNTED = 1; // through the mouth: in `slots` and in the measured speeds
const SETTLED = 2; // at rest and counted into `settledSlots`; drawn by the pile from now on

/** One bead, as the renderer sees it. A single view is reused: copy fields out rather than keep it. */
export interface BeadView {
  /** Slot widths from the port's exit, and drops below the port. */
  x: number;
  y: number;
  phase: number;
  slot: number;
  stack: number;
  /** m/s. */
  speed: number;
}

export interface Machine {
  step(dt: number): void;
  /** Beads fired so far, and beads counted through the mouths. */
  readonly launched: number;
  readonly landed: number;
  /** Beads the run will fire. */
  readonly target: number;
  /** Simulation clock, ms. */
  readonly time: number;
  /** When the last bead left the hopper, ms; Infinity until it has. */
  readonly emptiedAt: number;
  /** Beads counted per slot, and beads at rest per slot, in their order of arrival. */
  readonly slots: Uint32Array;
  readonly settledSlots: Uint32Array;
  /** Speed of bead `i`, m/s. Beads are counted in release order, so 0 … landed − 1 are the measured ones. */
  speedOf(i: number): number;
  /** Only the beads still moving: lifting, flying, falling, hopping, or at rest and not yet counted into a pile. */
  forEachActive(cb: (bead: BeadView, index: number) => void): void;
  /** Clear the machine. Does not reseed the RNG; the caller owns it. */
  reset(): void;
  setParams(p: MachineParams): void;
  /**
   * Tell the machine what the plate looks like. Beads in the air finish on the
   * plan they were given, in machine units, so they simply scale with the
   * plate; resting places are read back from the new geometry.
   */
  setGeometry(g: MachineGeometry): void;
}

/** Time to fall a height `h` (positive, downward) starting at vertical speed `vy` under `g`. */
function fallTime(g: number, vy: number, h: number): number {
  return (-vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * h))) / g;
}

export function createMachine(rng: Rng, params: MachineParams, budget: number): Machine {
  const capacity = Math.max(1, Math.floor(budget));

  // Per-bead state, allocated once at the ceiling. Nothing grows per frame.
  const speed = new Float64Array(capacity);
  const slotIdx = new Uint8Array(capacity);
  const stackIdx = new Uint32Array(capacity);
  const launchAt = new Float64Array(capacity);
  const phase = new Uint8Array(capacity);
  const flags = new Uint8Array(capacity);
  // Whether the flight ends against a wall rather than at the mouths.
  const atWall = new Uint8Array(capacity);
  // The current segment: start, velocity, lateral acceleration, duration, and
  // the time elapsed within it. Machine units and seconds; the vertical
  // acceleration is gravity in every phase but the lift.
  const sX = new Float64Array(capacity);
  const sY = new Float64Array(capacity);
  const sVx = new Float64Array(capacity);
  const sVy = new Float64Array(capacity);
  const sAx = new Float64Array(capacity);
  const sDur = new Float64Array(capacity);
  const sT = new Float64Array(capacity);

  const slots = new Uint32Array(SLOTS);
  const settledSlots = new Uint32Array(SLOTS);
  // Places in the piles handed out at release. Beads reach the mouths in the
  // order they were fired, so this is also their order of arrival in a slot.
  const assigned = new Uint32Array(SLOTS);

  let target = 0;
  let rate = 0;
  let scale = 1;
  let geometry: MachineGeometry = { ...DEFAULT_GEOMETRY };

  let time = 0;
  let launched = 0;
  let landed = 0;
  let firstActive = 0;
  // Beads owed by the release accumulator; one, so the first leaves on the first tick.
  let owed = 1;

  const view: BeadView = { x: 0, y: 0, phase: 0, slot: 0, stack: 0, speed: 0 };

  // Scratch for the two-vector helper below, so planning allocates nothing.
  let outX = 0;
  let outY = 0;

  /** Resting place of bead `i` on the current plate, in machine units. */
  function restPoint(i: number): void {
    const g = geometry;
    const slot = restSlot(g.cols, g.dotRadius, g.depth, stackIdx[i] ?? 0);
    outX = (slotIdx[i] ?? 0) + 0.5 + slot.dx / g.slotWidth;
    outY = 1 + slot.depth / g.drop;
  }

  function beadRadius(): number {
    return Math.min(MAX_BEAD_RADIUS, geometry.beadRadius / geometry.slotWidth);
  }

  /**
   * From the end of the lift: a horizontal launch at the bead's speed, under
   * gravity, from the port.
   *
   * It ends at the mouths unless a wall is in the way first. Inside slot k the
   * wall is the divider on its right, which only exists below the mouths; in
   * the last slot it is the case itself, the full height of the machine,
   * which is how a bead faster than the far wall ends up in that slot. Either
   * way a wall reached after the bead would have come down onto its place is
   * no wall at all, and the flight ends at the mouths.
   */
  function planFlight(i: number): void {
    const k = slotIdx[i] ?? 0;
    const ux = (speed[i] ?? 0) / (SLOT_SPEED * FLIGHT_S);
    restPoint(i);
    const tRest = Math.sqrt((2 * outY) / GRAVITY);
    let tWall = ux > 0 ? (k + 1 - beadRadius()) / ux : Infinity;
    if (k < SLOTS - 1) tWall = Math.max(tWall, FLIGHT_S);
    phase[i] = FLIGHT;
    sX[i] = 0;
    sY[i] = 0;
    sVx[i] = ux;
    sVy[i] = 0;
    sAx[i] = 0;
    if (tWall < tRest) {
      atWall[i] = 1;
      sDur[i] = tWall;
    } else {
      atWall[i] = 0;
      sDur[i] = FLIGHT_S;
    }
    sT[i] = 0;
  }

  /**
   * From (x0, y0) with velocity (vx, vy) down onto the bead's place in its
   * pile: gravity as ever, and a constant lateral acceleration that closes the
   * gap — the Galton board's fall into a bin, and the gentlest correction on
   * the plate, spread over the whole depth of the slot.
   *
   * A bead that comes in off a wall is held to a rebound it can absorb before
   * it reaches the far side: its lateral speed is capped at the slot's inner
   * width over the fall, which keeps the whole path inside the slot it is
   * meant for.
   */
  function planFall(i: number, x0: number, y0: number, vx: number, vy: number, offWall: boolean): void {
    restPoint(i);
    const T = Math.max(1e-6, fallTime(GRAVITY, vy, outY - y0));
    let u = vx;
    if (offWall) {
      const inner = Math.max(0, 1 - 2 * beadRadius());
      u = -Math.min(WALL_RESTITUTION * Math.abs(vx), inner / T);
    }
    phase[i] = FALL;
    sX[i] = x0;
    sY[i] = y0;
    sVx[i] = u;
    sVy[i] = vy;
    sAx[i] = (2 * (outX - (x0 + u * T))) / (T * T);
    sDur[i] = T;
    sT[i] = 0;
  }

  /** Land on the pile at `vDown`: hop at the resting place, or stop if the hop is too small to see. */
  function bounce(i: number, vDown: number): void {
    restPoint(i);
    const v = PILE_RESTITUTION * vDown;
    sX[i] = outX;
    sY[i] = outY;
    sVx[i] = 0;
    sAx[i] = 0;
    sT[i] = 0;
    if ((v * v) / (2 * GRAVITY) < MIN_HOP) {
      phase[i] = REST;
      sVy[i] = 0;
      sDur[i] = Infinity;
    } else {
      phase[i] = HOP;
      sVy[i] = -v;
      sDur[i] = (2 * v) / GRAVITY;
    }
  }

  /** Finish bead `i`'s current segment and plan the next one. */
  function complete(i: number): void {
    const T = sDur[i] ?? 0;
    const x = (sX[i] ?? 0) + (sVx[i] ?? 0) * T + ((sAx[i] ?? 0) * T * T) / 2;
    const y = (sY[i] ?? 0) + (sVy[i] ?? 0) * T + (GRAVITY * T * T) / 2;
    const vx = (sVx[i] ?? 0) + (sAx[i] ?? 0) * T;
    const vy = (sVy[i] ?? 0) + GRAVITY * T;
    switch (phase[i]) {
      case LIFT:
        planFlight(i);
        return;
      case FLIGHT:
        planFall(i, x, y, vx, vy, atWall[i] === 1);
        return;
      case FALL:
        bounce(i, vy);
        return;
      case HOP:
        bounce(i, -(sVy[i] ?? 0));
        return;
      default:
        return;
    }
  }

  /** Move bead `i` forward by `dt` ms through as many segments as that covers. */
  function advance(i: number, dt: number): void {
    let t = (sT[i] ?? 0) + dt / 1000;
    let dur = sDur[i] ?? Infinity;
    while (t >= dur) {
      t -= dur;
      complete(i);
      dur = sDur[i] ?? Infinity;
    }
    sT[i] = t;
  }

  /** Release one bead that has already been on its way for `age` ms. */
  function spawn(age: number): void {
    const i = launched++;
    const v = sampleSpeed(rng, scale);
    const k = slotOf(v);
    speed[i] = v;
    slotIdx[i] = k;
    stackIdx[i] = assigned[k] ?? 0;
    assigned[k] = (assigned[k] ?? 0) + 1;
    launchAt[i] = time - age;
    flags[i] = 0;

    // The top bead of the hopper leaves first: the hopper still holds
    // `target − i` beads, and the highest of them is the last in the packing.
    const g = geometry;
    const place = hopperPlace(g.hopper, Math.max(0, target - 1 - i));
    phase[i] = LIFT;
    sX[i] = place.x / g.slotWidth;
    sY[i] = place.y / g.drop;
    sVx[i] = 0;
    sVy[i] = 0;
    sAx[i] = 0;
    sDur[i] = LIFT_S;
    sT[i] = 0;
    if (age > 0) advance(i, age);
  }

  /**
   * Count beads into the piles in the order their places were handed out. Two
   * beads bound for one slot can come to rest out of order — the later one
   * has the shorter fall — and the renderer paints a pile as its first n
   * places, so a bead is not counted until every place under it is filled. It
   * sits on its place meanwhile, drawn as the bead it still is.
   */
  function settleInOrder(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = firstActive; i < launched; i++) {
        const f = flags[i] ?? 0;
        if ((f & SETTLED) !== 0 || phase[i] !== REST) continue;
        const k = slotIdx[i] ?? 0;
        if (stackIdx[i] === (settledSlots[k] ?? 0)) {
          flags[i] = f | SETTLED;
          settledSlots[k] = (settledSlots[k] ?? 0) + 1;
          progress = true;
        }
      }
    }
  }

  function fillView(i: number): BeadView {
    const t = sT[i] ?? 0;
    const ph = phase[i] ?? REST;
    if (ph === LIFT) {
      // A quadratic Bézier from the bead's place in the hopper, through the
      // point straight above it at the port's height, into the port: up out of
      // the pile, then over into the wall. With s = (t/LIFT)² the bead leaves
      // gently and arrives at speed, which is what an air lift looks like.
      // (1 − s)² + 2s(1 − s) = 1 − s², which is why x has no third term.
      const tau = Math.min(1, t / LIFT_S);
      const s = tau * tau;
      view.x = (sX[i] ?? 0) * (1 - s * s);
      view.y = (sY[i] ?? 0) * (1 - s) * (1 - s);
    } else if (ph === REST) {
      // From the current plate rather than the one the bead stopped on, so a
      // resize moves it with the pile it is part of.
      restPoint(i);
      view.x = outX;
      view.y = outY;
    } else {
      view.x = (sX[i] ?? 0) + (sVx[i] ?? 0) * t + ((sAx[i] ?? 0) * t * t) / 2;
      view.y = (sY[i] ?? 0) + (sVy[i] ?? 0) * t + (GRAVITY * t * t) / 2;
    }
    view.phase = ph;
    view.slot = slotIdx[i] ?? 0;
    view.stack = stackIdx[i] ?? 0;
    view.speed = speed[i] ?? 0;
    return view;
  }

  function reset(): void {
    time = 0;
    launched = 0;
    landed = 0;
    firstActive = 0;
    owed = 1;
    slots.fill(0);
    settledSlots.fill(0);
    assigned.fill(0);
  }

  function setParams(next: MachineParams): void {
    target = Math.min(capacity, Math.max(0, Math.floor(next.beads)));
    rate = Math.max(0, next.launchRate);
    scale = Math.max(1e-9, next.scale);
  }

  setParams(params);

  return {
    step(dt) {
      time += dt;

      // Beads already in the machine move first; the ones released this tick
      // are placed by their own age below, so they must not be moved twice.
      while (firstActive < launched && ((flags[firstActive] ?? 0) & SETTLED) !== 0) firstActive++;
      const already = launched;
      for (let i = firstActive; i < already; i++) {
        if (((flags[i] ?? 0) & SETTLED) === 0) advance(i, dt);
      }

      if (launched < target && rate > 0) {
        owed += (rate * dt) / 1000;
        const period = 1000 / rate;
        while (owed >= 1 && launched < target) {
          owed -= 1;
          // What is still owed after this bead is how far past its release
          // instant the tick ended; staggering by it keeps a dense stream
          // evenly spaced instead of clumped at tick boundaries.
          spawn(owed * period);
        }
      }

      // Every flight lasts the same time and every lift too, so beads cross
      // the mouths in the order they were fired, and the count is a function
      // of the clock alone: identical at every step size.
      while (landed < launched && time >= (launchAt[landed] ?? 0) + COUNT_MS) {
        const k = slotIdx[landed] ?? 0;
        slots[k] = (slots[k] ?? 0) + 1;
        flags[landed] = (flags[landed] ?? 0) | COUNTED;
        landed++;
      }

      settleInOrder();
    },

    get launched() {
      return launched;
    },
    get landed() {
      return landed;
    },
    get target() {
      return target;
    },
    get time() {
      return time;
    },
    get emptiedAt() {
      return target > 0 && launched >= target ? (launchAt[target - 1] ?? 0) : Infinity;
    },
    slots,
    settledSlots,

    speedOf(i) {
      return speed[i] ?? Number.NaN;
    },

    forEachActive(cb) {
      for (let i = firstActive; i < launched; i++) {
        if (((flags[i] ?? 0) & SETTLED) === 0) cb(fillView(i), i);
      }
    },

    reset,
    setParams,

    setGeometry(g) {
      geometry = {
        slotWidth: Math.max(1e-3, g.slotWidth),
        drop: Math.max(1e-3, g.drop),
        depth: Math.max(1, g.depth),
        beadRadius: Math.max(0, g.beadRadius),
        dotRadius: Math.max(0.1, g.dotRadius),
        cols: Math.max(1, Math.floor(g.cols)),
        hopper: g.hopper,
      };
    },
  };
}
