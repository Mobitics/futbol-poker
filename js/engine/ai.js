// Computer opponents. Each estimates its equity by Monte Carlo — dealing
// out the unknown cards many times and scoring every team — then plays
// against the pot odds, flavoured by a personality.

import { bestTotal } from './evaluate.js';

export const PERSONALITIES = {
  rock:     { label: 'Rock',     tight: 0.12, aggr: 0.5, bluff: 0.02 },
  pro:      { label: 'Pro',      tight: 0.05, aggr: 1.0, bluff: 0.06 },
  maniac:   { label: 'Maniac',   tight: -0.08, aggr: 1.6, bluff: 0.16 },
  station:  { label: 'Caller',   tight: -0.12, aggr: 0.4, bluff: 0.03 },
};

/** Win probability for `seat` given only what that seat can see. */
export function estimateEquity(table, seat, iterations = 160) {
  const me = table.seats[seat];
  const opponents = table.inHand.filter(s => s.index !== seat).length;
  const known = new Set([...me.hole, ...table.board].map(c => c.id));
  // Everything this seat can't see: rest of the deck + other players' hole cards.
  const unseen = [...table.deck];
  for (const s of table.seats) if (s.index !== seat) for (const c of s.hole) if (!known.has(c.id)) unseen.push(c);
  return equityFromCards(me.hole, table.board, unseen, opponents, iterations);
}

/** Monte Carlo equity from raw cards: deal out the unseen cards many times. */
export function equityFromCards(hole, boardNow, unseen, opponents, iterations = 160) {
  if (opponents <= 0) return 1;
  const need = 5 - boardNow.length;
  const draw = need + opponents * 2;
  if (unseen.length < draw) return 0;
  let score = 0;
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher-Yates for the cards we need.
    const pool = unseen.slice();
    for (let i = 0; i < draw; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const board = [...boardNow, ...pool.slice(0, need)];
    const mine = bestTotal([...hole, ...board]);
    let best = -1, ties = 0;
    for (let o = 0; o < opponents; o++) {
      const t = bestTotal([pool[need + 2 * o], pool[need + 2 * o + 1], ...board]);
      if (t > best) { best = t; ties = 0; }
      if (t === best) ties++;
    }
    if (mine > best) score += 1;
    else if (mine === best) score += 1 / (ties + 1);
  }
  return score / iterations;
}

export function decide(table, seat) {
  const s = table.seats[seat];
  const P = PERSONALITIES[s.style] || PERSONALITIES.pro;
  const L = table.legal(seat);
  const n = table.inHand.length;
  const eq = estimateEquity(table, seat, table.street === 'preflop' ? 90 : 160);
  const fair = 1 / n;           // equity of an average hand
  const rel = eq / fair;        // >1 = better than average
  const pot = table.pot;
  const potOdds = L.toCall / (pot + L.toCall || 1);
  const r = Math.random();

  const sizeTo = frac => {
    const bet = Math.max(table.bb, Math.round((pot * frac) / table.sb) * table.sb);
    return Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, table.currentBet + bet));
  };
  const raiseWanted = rel > 1.9 - 0.25 * P.aggr || (r < P.bluff && table.street !== 'river');
  const strong = rel > 2.4 - 0.2 * P.aggr;

  let action;
  if (L.canCheck) {
    if (raiseWanted && L.canRaise) action = { type: 'raise', to: sizeTo(strong ? 0.75 + 0.25 * P.aggr : 0.5) };
    else action = { type: 'check' };
  } else {
    const callThreshold = potOdds + P.tight - (rel > 1 ? 0.05 : 0);
    if (eq < callThreshold && !(r < P.bluff / 2)) action = { type: 'fold' };
    else if (raiseWanted && L.canRaise && rel > 1.3) action = { type: 'raise', to: sizeTo(strong ? 1 : 0.6) };
    else action = { type: 'call' };
    // Don't fold for a tiny price.
    if (action.type === 'fold' && L.toCall <= table.bb / 2) action = { type: 'call' };
  }
  // Big favourites shove when short.
  if (strong && s.chips < pot && L.canRaise && eq > 0.6) action = { type: 'raise', to: L.maxRaiseTo };
  return { ...action, equity: eq };
}
