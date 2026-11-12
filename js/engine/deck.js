// Builds a 52-card "deck" of footballers for one hand, poker style:
// 13 squads (club + era) × 4 players each. Squads play the role of ranks,
// so landing teammates is about as likely as landing a pair in Hold'em.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick(items, weightFn, rng) {
  const ws = items.map(weightFn);
  let r = rng() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return i; }
  return items.length - 1;
}

export const DECK_SIZES = {
  small:  { squadCount: 8,  perSquad: 5, label: 'Small — 8 squads × 5 (40 cards)' },
  medium: { squadCount: 10, perSquad: 5, label: 'Medium — 10 squads × 5 (50 cards)' },
  large:  { squadCount: 13, perSquad: 4, label: 'Large — 13 squads × 4 (52 cards)' },
};

const GROUPS = ['GK', 'DEF', 'MID', 'FWD'];
const starWeight = p => Math.pow(Math.max(1, p.overall - 60) / 10, 2);

/**
 * Picks the deck for a whole game: a fixed, public set of squads. Every
 * squad contributes one GK, DEF, MID and FWD (plus one extra outfielder
 * when perSquad is 5), so squads work like suits in a normal deck and
 * players can reason about what is still out there.
 *
 * @param squads Map "clubId|era" -> players[]
 * @param opts { squadCount, perSquad, minSquadOverall }
 * @returns cards in display order (squad by squad)
 */
export function chooseDeck(squads, rng, opts = {}) {
  const { squadCount = 8, perSquad = 5, minSquadOverall = 0 } = opts;
  const keys = shuffle([...squads.keys()].filter(k => {
    const ps = squads.get(k);
    const avg = ps.reduce((a, p) => a + p.overall, 0) / ps.length;
    return avg >= minSquadOverall && GROUPS.every(g => ps.some(p => p.position === g));
  }), rng);

  const deck = [];
  const persons = new Set();
  let used = 0;
  for (const k of keys) {
    if (used >= squadCount) break;
    const pool = squads.get(k).filter(p => !persons.has(p.personId));
    const chosen = [];
    for (const g of GROUPS) {
      const cands = pool.filter(p => p.position === g && !chosen.includes(p));
      if (!cands.length) break;
      chosen.push(cands[weightedPick(cands, starWeight, rng)]);
    }
    while (chosen.length === GROUPS.length && chosen.length < perSquad) {
      const cands = pool.filter(p => p.position !== 'GK' && !chosen.includes(p));
      if (!cands.length) break;
      chosen.push(cands[weightedPick(cands, starWeight, rng)]);
    }
    if (chosen.length < perSquad) continue;
    chosen.forEach(p => persons.add(p.personId));
    deck.push(...chosen);
    used++;
  }
  return deck;
}

export function groupSquads(players) {
  const m = new Map();
  for (const p of players) {
    const k = p.clubId + '|' + p.era;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}
