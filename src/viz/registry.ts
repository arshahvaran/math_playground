import type { Viz } from '../core/types';
import { galton } from './galton';
import { buffon } from './buffon';
import { montecarloPi } from './montecarlo-pi';
import { arcsine } from './arcsine';
import { waitingTime } from './waiting-time';
import { prisoners } from './prisoners';
import { parrondo } from './parrondo';
import { compounding } from './compounding';
import { dla } from './dla';
import { chaosGame } from './chaos-game';
import { bifurcation } from './bifurcation';
import { lorenz } from './lorenz';
import { ising } from './ising';
import { kuramoto } from './kuramoto';
import { coprime } from './coprime';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical, and the shell builds its group runs from *consecutive*
 * entries, so the two facts are one fact: the order below is both the argument
 * and the strip. Do not sort this alphabetically.
 *
 * A group may therefore appear only once. A tab dropped into the middle of
 * another group's run cuts that run in two and prints its label twice in the
 * strip, which is why `coprime` is not filed beside the two π estimators it
 * belongs with mathematically — see the numbers run below.
 *
 * The randomness run is a single escalation in what a random process is asked to
 * produce. The board makes a distribution out of coin flips. Buffon makes a
 * *constant* out of geometry, at the O(1/√N) rate that is the honest price of
 * every estimator after it. Monte Carlo π reaches the same constant by the
 * cheapest possible rule, which is what makes it the place to draw the 1.64/√n
 * envelope and admit the rate out loud.
 *
 * Those three settle that a random process converges on a number. The five that
 * follow are there because it is almost never the number anyone guesses, and
 * they are ordered by how far the mechanism behind the surprise sits from the
 * question asked. The arcsine law is the nearest: nothing but a fair coin, and
 * the lead is almost never shared. Waiting time keeps the same coin and changes
 * only *who is asking* — sample a timetable by turning up in it and the gaps you
 * land in are the long ones. The prisoners answer with a probability that ought
 * to be astronomical and is a third, because the players stop choosing
 * independently. Parrondo leaves both games alone and changes only their order.
 * Compounding ends the sequence by splitting the question itself: the average
 * player and the typical player are different people, and no amount of sampling
 * reconciles them.
 *
 * DLA then closes the group, as it always has: it asks for a *shape*, and the
 * answer — dimension 1.71 — is the first target here with no closed form at all.
 * That is the bridge out, and it is why the chaos run follows immediately and
 * nothing is filed between them.
 *
 * The chaos run then removes the randomness one tab at a time. The chaos game
 * still draws from the seeded stream, but its limit is exact and independent of
 * every draw — the point where randomness stops mattering to the answer. The
 * bifurcation diagram has no randomness left and produces chaos anyway. Lorenz
 * makes that continuous, and its twin trajectory is the reason any of it matters
 * outside a screen. The Ising sheet then closes the run by inverting it: the
 * randomness comes back, at the smallest scale there is, and this time what it
 * builds is *sharp* — a whole sheet that agrees or does not, either side of one
 * definite temperature.
 *
 * Waves is one tab on purpose, and it sits next to that sheet rather than before
 * the chaos run, because it is the same story told without heat: a crowd of
 * oscillators with nothing in common but a pull towards each other, and a
 * tipping point at a coupling of 2. Read left to right, Ising and Kuramoto are
 * one claim in two materials.
 *
 * Numbers closes the app, and closing it is the argument for the placement. The
 * orchard is the only tab whose answer is not a property of any process: the
 * trees do not move, the lattice was always there, and the random checks are
 * merely how a visitor reads a fact of arithmetic off a picture. It recovers π —
 * the constant the run three groups ago spent two tabs chasing through geometry
 * — from a square grid with nothing round in it.
 */
export const registry: readonly Viz[] = [
  galton,
  // `clt` (Central Limit Machine) belongs here once built: the board is that
  // machine with a fixed Bernoulli source, so the general statement sits between
  // the hero and the first route to π.
  buffon,
  montecarloPi,
  arcsine,
  waitingTime,
  prisoners,
  parrondo,
  compounding,
  dla,
  chaosGame,
  bifurcation,
  lorenz,
  ising,
  kuramoto,
  coprime,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
