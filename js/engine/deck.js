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

/**
 * @param squads Map "clubId|era" -> players[]
 * @param opts { squadCount=13, perSquad=4, minSquadOverall=0 }
 */
export function buildDeck(squads, rng, opts = {}) {
  const { squadCount = 13, perSquad = 4, minSquadOverall = 0 } = opts;
  const keys = shuffle([...squads.keys()].filter(k => {
    const ps = squads.get(k);
    const avg = ps.reduce((a, p) => a + p.overall, 0) / ps.length;
    return ps.length >= perSquad && avg >= minSquadOverall;
  }), rng);

  const deck = [];
  const persons = new Set();
  for (const k of keys) {
    if (deck.length >= squadCount * perSquad) break;
    let pool = squads.get(k).filter(p => !persons.has(p.personId));
    const chosen = [];
    let hasGK = false;
    while (chosen.length < perSquad && pool.length) {
      // Stars show up more often; at most one keeper per squad.
      const i = weightedPick(pool, p => {
        const w = Math.pow(Math.max(1, p.overall - 60) / 10, 2);
        return p.position === 'GK' ? w * 0.7 : w;
      }, rng);
      const p = pool[i];
      pool.splice(i, 1);
      if (p.position === 'GK' && hasGK) continue;
      if (p.position === 'GK') hasGK = true;
      chosen.push(p);
    }
    if (chosen.length < perSquad) continue;
    chosen.forEach(p => persons.add(p.personId));
    deck.push(...chosen);
  }
  return shuffle(deck, rng);
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
