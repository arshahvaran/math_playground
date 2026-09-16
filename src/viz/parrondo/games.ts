import type { Rng } from '../../core/types';

/**
 * Parrondo's paradox: the mathematics, with no canvas in sight.
 *
 * Two games are played for one coin a round. Game A is a single tilted coin,
 * won with probability ½ − ε. Game B looks at how much money the player has
 * and picks one of two coins: a bad one, 1/10 − ε, when the money is a multiple
 * of three, and a good one, 3/4 − ε, otherwise. Played alone, B loses, because
 * its own losses keep dropping it back onto the multiples of three where the
 * bad coin lives.
 *
 * Both games therefore drift downwards. Played two rounds of A, then two rounds
 * of B, over and over, the money drifts *up* — A is far too weak to win on its
 * own but strong enough to knock the money off the multiples of three before B
 * gets there, so B meets its good coin more often than it would on its own.
 *
 * Everything below reads the money only through `remainder()`, so a rule's
 * long-run behaviour is a chain on the three remainders {0, 1, 2}. That chain
 * is small enough to solve exactly, here in the browser, for whatever ε the
 * slider is on — which is what makes the measured-against-predicted comparison
 * honest rather than a published constant pasted next to a simulation.
 */

/**
 * The modulus game B reads the money by. Fixed at three, and not a control:
 * three is the only modulus with a paradox in it. At two the chain alternates
 * between the two remainders deterministically and the mixture loses (−0.0850
 * per round at ε = 0.005); at four, game B already wins on its own (+0.0527),
 * so there is nothing left to be surprised by.
 */
export const MODULUS = 3;

export type Game = 'A' | 'B';

/** Which game is played on each round of a repeating cycle. */
export type Rule = readonly Game[];

/** The three rules the tab races, in the order their arrays are laid out. */
export const RULE_A: Rule = ['A'];
export const RULE_B: Rule = ['B'];

/**
 * The winner: two rounds of A, then two rounds of B, repeating.
 *
 * Not the strict alternation A, B, A, B — that one **loses**, at −0.006738 per
 * round at ε = 0.005, and it is the standard trap in this problem. Two of each
 * wins at +0.014651 because the pair of A rounds is what carries the money off
 * a multiple of three and keeps it off long enough for B's good coin to pay.
 * The cycle is fixed rather than offered as a control for the same reason the
 * modulus is: a schedule picker is three more concepts and one of its settings
 * contradicts the tab's own title.
 */
export const RULE_TURNS: Rule = ['A', 'A', 'B', 'B'];

/** Rule index into every array here and every trace on the plate. */
export const A_ONLY = 0;
export const B_ONLY = 1;
export const TAKING_TURNS = 2;

export const RULES: readonly Rule[] = [RULE_A, RULE_B, RULE_TURNS];

/**
 * Money mod 3, for money that has gone negative — which it does, since nobody
 * is stopped at zero. `%` keeps the sign of its left operand in JavaScript: −1
 * % 3 is −1, which would index off the front of the chain, and −3 % 3 is −0,
 * which is a remainder of zero wearing a minus sign.
 */
export function remainder(money: number): number {
  const r = money % MODULUS;
  if (r < 0) return r + MODULUS;
  return r === 0 ? 0 : r;
}

/**
 * Probability of winning the round. Game A never looks at the money; game B
 * looks at nothing else.
 */
export function winProbability(game: Game, money: number, eps: number): number {
  if (game === 'A') return 0.5 - eps;
  return remainder(money) === 0 ? 0.1 - eps : 0.75 - eps;
}

/** Expected money change for one round of `game` played from remainder `i`. */
function stepMean(game: Game, i: number, eps: number): number {
  return 2 * winProbability(game, i, eps) - 1;
}

/**
 * One round of `game` as a transition matrix on the remainders: a win moves the
 * remainder up one, a loss down one, both mod 3. `P[i][j]` is the chance of
 * going from remainder `i` to remainder `j`.
 */
export function transitionMatrix(game: Game, eps: number): number[][] {
  const P: number[][] = [];
  for (let i = 0; i < MODULUS; i++) P.push(new Array<number>(MODULUS).fill(0));
  for (let i = 0; i < MODULUS; i++) {
    const row = P[i]!;
    const p = winProbability(game, i, eps);
    const up = (i + 1) % MODULUS;
    const down = (i + MODULUS - 1) % MODULUS;
    row[up] = row[up]! + p;
    row[down] = row[down]! + (1 - p);
  }
  return P;
}

/** Row vector times matrix: where a distribution over remainders goes next. */
function advance(v: readonly number[], P: readonly number[][]): number[] {
  const out = new Array<number>(MODULUS).fill(0);
  for (let j = 0; j < MODULUS; j++) {
    let sum = 0;
    for (let i = 0; i < MODULUS; i++) sum += v[i]! * P[i]![j]!;
    out[j] = sum;
  }
  return out;
}

function compose(A: readonly number[][], B: readonly number[][]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < MODULUS; i++) {
    const a = A[i]!;
    const row = new Array<number>(MODULUS).fill(0);
    for (let j = 0; j < MODULUS; j++) {
      let sum = 0;
      for (let k = 0; k < MODULUS; k++) sum += a[k]! * B[k]![j]!;
      row[j] = sum;
    }
    out.push(row);
  }
  return out;
}

/**
 * The settled share of time the chain `P` spends on each remainder: the vector
 * x with xP = x and Σx = 1.
 *
 * Solved directly by Gaussian elimination with partial pivoting rather than by
 * iterating P — three unknowns, and a direct solve is exact to rounding, which
 * matters because this number is published as a target. The system is the first
 * `MODULUS − 1` balance equations (the last is their negative sum and would
 * make the matrix singular) closed with the normalisation row.
 */
export function solveShares(P: readonly number[][]): number[] {
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let j = 0; j < MODULUS - 1; j++) {
    const row = new Array<number>(MODULUS);
    for (let i = 0; i < MODULUS; i++) row[i] = P[i]![j]! - (i === j ? 1 : 0);
    rows.push(row);
    rhs.push(0);
  }
  rows.push(new Array<number>(MODULUS).fill(1));
  rhs.push(1);

  for (let c = 0; c < MODULUS; c++) {
    let pivot = c;
    for (let r = c + 1; r < MODULUS; r++) {
      if (Math.abs(rows[r]![c]!) > Math.abs(rows[pivot]![c]!)) pivot = r;
    }
    const tmpRow = rows[c]!;
    rows[c] = rows[pivot]!;
    rows[pivot] = tmpRow;
    const tmpRhs = rhs[c]!;
    rhs[c] = rhs[pivot]!;
    rhs[pivot] = tmpRhs;

    const pivotRow = rows[c]!;
    const diag = pivotRow[c]!;
    for (let j = c; j < MODULUS; j++) pivotRow[j] = pivotRow[j]! / diag;
    rhs[c] = rhs[c]! / diag;
    for (let r = 0; r < MODULUS; r++) {
      if (r === c) continue;
      const row = rows[r]!;
      const f = row[c]!;
      if (f === 0) continue;
      for (let j = c; j < MODULUS; j++) row[j] = row[j]! - f * pivotRow[j]!;
      rhs[r] = rhs[r]! - f * rhs[c]!;
    }
  }
  return rhs;
}

export interface RuleSolution {
  /** Money won per round once the chain has settled. Negative for a losing rule. */
  drift: number;
  /** Long-run share of rounds that start on each remainder. Sums to one. */
  shares: number[];
}

/**
 * Solve a rule exactly: the money it wins per round, and how its rounds are
 * spread over the three remainders.
 *
 * A rule of length L is not one chain but L of them in a cycle, so the object
 * that settles is the distribution at the *start* of a cycle, under the product
 * of the L matrices. The drift is then the expected step averaged over the L
 * positions of the cycle, each read against the distribution that position
 * actually sees — not against the cycle's own start.
 */
export function solveRule(rule: Rule, eps: number): RuleSolution {
  const mats = rule.map((game) => transitionMatrix(game, eps));
  let cycle = mats[0]!;
  for (let k = 1; k < mats.length; k++) cycle = compose(cycle, mats[k]!);

  let v = solveShares(cycle);
  const shares = new Array<number>(MODULUS).fill(0);
  let drift = 0;
  for (let k = 0; k < mats.length; k++) {
    const game = rule[k]!;
    for (let i = 0; i < MODULUS; i++) {
      shares[i] = shares[i]! + v[i]!;
      drift += v[i]! * stepMean(game, i, eps);
    }
    v = advance(v, mats[k]!);
  }
  for (let i = 0; i < MODULUS; i++) shares[i] = shares[i]! / mats.length;
  return { drift: drift / mats.length, shares };
}

/**
 * The exact expected money after 0, 1, … `out.length − 1` rounds, from a player
 * who starts on nothing.
 *
 * This is the drift line plus the start-up effect, and the start-up is real:
 * zero is a multiple of three, so every player's first round of game B is
 * played on the bad coin. The whole of that effect is a constant — −0.52 coins
 * for game B at ε = 0.005, reached within about ten rounds and never repaid —
 * so the curve is a straight line of slope `drift` shifted down by half a coin,
 * and it is what the plate draws as the prediction. Sampling it round by round
 * costs one 3-vector times a 3×3 matrix per round, once per parameter change.
 */
export function expectedMoneyInto(rule: Rule, eps: number, out: Float64Array): void {
  const mats = rule.map((game) => transitionMatrix(game, eps));
  let v: number[] = new Array<number>(MODULUS).fill(0);
  v[0] = 1;
  let money = 0;
  out[0] = 0;
  for (let k = 1; k < out.length; k++) {
    const at = (k - 1) % mats.length;
    const game = rule[at]!;
    for (let i = 0; i < MODULUS; i++) money += v[i]! * stepMean(game, i, eps);
    v = advance(v, mats[at]!);
    out[k] = money;
  }
}

/** The exact expected money after `rounds` rounds. */
export function expectedMoney(rule: Rule, eps: number, rounds: number): number {
  const n = Math.max(0, Math.floor(rounds));
  const out = new Float64Array(n + 1);
  expectedMoneyInto(rule, eps, out);
  return out[n]!;
}

/**
 * Every player at the table, for all three rules at once.
 *
 * One Int32Array holds `RULES.length × maxPlayers` purses, allocated once at
 * the budget ceiling and never resized: rule `r`'s players occupy the slice
 * starting at `r · maxPlayers`. The running totals are kept as the rounds are
 * played rather than summed afterwards — each round moves a purse by exactly
 * ±1, so the total moves by the same amount for free, and a readout every frame
 * never rescans two thousand purses.
 *
 * What is counted here is every round of every player. What the plate paints is
 * bounded separately, by the plate.
 */
export class Table {
  readonly maxPlayers: number;
  readonly maxRounds: number;

  /** Purses: rule `r`, player `i` at `r · maxPlayers + i`. */
  readonly #money: Int32Array;
  /** Running total of each rule's purses, so the average is one division. */
  readonly #totals: Float64Array;
  /** Rounds each rule has started on a multiple of three. */
  readonly #onBad: Float64Array;
  /**
   * Average money per rule after each round, `maxRounds + 1` entries per rule
   * starting at round zero. Float32 is seven digits on a purse of a few
   * hundred coins; this array is only ever painted from.
   */
  readonly #history: Float32Array;
  readonly #stride: number;

  #players = 1;
  #eps = 0;
  #round = 0;

  constructor(maxPlayers: number, maxRounds: number) {
    this.maxPlayers = Math.max(1, Math.floor(maxPlayers));
    this.maxRounds = Math.max(1, Math.floor(maxRounds));
    this.#stride = this.maxRounds + 1;
    this.#money = new Int32Array(RULES.length * this.maxPlayers);
    this.#totals = new Float64Array(RULES.length);
    this.#onBad = new Float64Array(RULES.length);
    this.#history = new Float32Array(RULES.length * this.#stride);
  }

  /** Table size and coin tilt for the next run. Both are structural; this resets. */
  configure(players: number, eps: number): void {
    this.#players = Math.max(1, Math.min(this.maxPlayers, Math.floor(players)));
    this.#eps = eps;
    this.reset();
  }

  get players(): number {
    return this.#players;
  }

  get eps(): number {
    return this.#eps;
  }

  get round(): number {
    return this.#round;
  }

  /** True once the run has played every round it is going to. */
  get finished(): boolean {
    return this.#round >= this.maxRounds;
  }

  /**
   * Play one round under every rule.
   *
   * Exactly `RULES.length × players` draws are taken from `rng`, always in the
   * same order, so the run for a seed is the same however the fixed-timestep
   * driver batches its ticks.
   */
  playRound(rng: Rng): void {
    if (this.finished) return;
    const money = this.#money;
    const eps = this.#eps;
    const n = this.#players;
    for (let r = 0; r < RULES.length; r++) {
      const rule = RULES[r]!;
      const game = rule[this.#round % rule.length]!;
      // Both coins hoisted out of the player loop: game A uses one coin for
      // every remainder, game B two, and neither depends on which player is
      // being played. Six thousand players a round is not the place for a
      // string comparison and two subtractions each.
      const onBadCoin = winProbability(game, 0, eps);
      const otherCoin = winProbability(game, 1, eps);
      const base = r * this.maxPlayers;
      let total = this.#totals[r]!;
      let bad = this.#onBad[r]!;
      for (let i = 0; i < n; i++) {
        const k = base + i;
        const purse = money[k]!;
        const atBad = remainder(purse) === 0;
        if (atBad) bad++;
        const won = rng.next() < (atBad ? onBadCoin : otherCoin);
        money[k] = purse + (won ? 1 : -1);
        total += won ? 1 : -1;
      }
      this.#totals[r] = total;
      this.#onBad[r] = bad;
    }
    this.#round++;
    for (let r = 0; r < RULES.length; r++) {
      this.#history[r * this.#stride + this.#round] = this.#totals[r]! / n;
    }
  }

  /** Average money across the table under rule `r`, right now. */
  averageMoney(r: number): number {
    return (this.#totals[r] ?? 0) / this.#players;
  }

  /**
   * Average money won per round under rule `r`: the measurement the tab is
   * about. NaN before the first round, which is the honest value — no rounds,
   * no rate.
   */
  averagePerRound(r: number): number {
    return this.#round === 0 ? NaN : this.averageMoney(r) / this.#round;
  }

  /** Share of rule `r`'s rounds that started on a multiple of three. */
  shareOnBad(r: number): number {
    if (this.#round === 0) return NaN;
    return (this.#onBad[r] ?? 0) / (this.#round * this.#players);
  }

  /**
   * Average money under rule `r` after `round` rounds, for the painter. Reading
   * past `this.round` gives zero — the run has not been there yet.
   */
  historyAt(r: number, round: number): number {
    return this.#history[r * this.#stride + round] ?? 0;
  }

  /** Everyone back to nothing, every counter zeroed. Nothing reallocates. */
  reset(): void {
    this.#money.fill(0);
    this.#totals.fill(0);
    this.#onBad.fill(0);
    this.#history.fill(0);
    this.#round = 0;
  }
}
