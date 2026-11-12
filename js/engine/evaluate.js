// Team evaluation: turns any 5–7 player "cards" into the best possible
// 5-a-side team and scores it on TALENT (stats in the right roles) plus
// CHEMISTRY (how the players fit together). Pure logic, no DOM.

export const ROLES = ['GK', 'DEF', 'MID', 'FWD', 'FLEX'];

// Chemistry weights — tune here. A squad pair (real teammates) is the most
// valuable link, which is what makes "pairs", "trios" etc. poker-like.
export const CHEM = {
  squadPair: 4,       // same club AND same era: they actually played together
  clubPair: 1.5,      // same club, different era: shared DNA
  nationPair: 1.5,    // same nationality
  nationFlush: 6,     // extra bonus when all five share a nationality
  eraStraight: 10,    // five different eras, 1980s → 2020s
  styles: {
    tikiTaka: 3,      // outfield technique avg ≥ 85
    ironWall: 3,      // GK ≥ 88 and DEF role ≥ 88 defense
    lethal: 3,        // two outfielders with attack ≥ 88
    engineRoom: 2,    // outfield physical avg ≥ 85
  },
};

const ADJ = {
  // multiplier when a player plays a role outside his natural group
  DEF: { DEF: 1, MID: 0.88, FWD: 0.75 },
  MID: { DEF: 0.88, MID: 1, FWD: 0.9 },
  FWD: { DEF: 0.75, MID: 0.9, FWD: 1 },
  GK: { DEF: 0.55, MID: 0.5, FWD: 0.5 },
};

function formula(p, group) {
  switch (group) {
    case 'DEF': return 0.6 * p.defense + 0.2 * p.physical + 0.2 * p.technique;
    case 'MID': return 0.4 * p.technique + 0.3 * p.attack + 0.3 * p.defense;
    case 'FWD': return 0.6 * p.attack + 0.25 * p.technique + 0.15 * p.physical;
  }
  return 0;
}

/** Rating of a player in a given role (0–99 scale). Cached on the card. */
export function roleScores(p) {
  if (p._rs) return p._rs;
  const out = {};
  out.GK = p.position === 'GK' ? 0.5 * p.gk + 0.5 * p.overall : 30;
  for (const g of ['DEF', 'MID', 'FWD']) {
    const f = formula(p, g);
    out[g] = p.position === g ? 0.5 * f + 0.5 * p.overall : f * ADJ[p.position][g];
  }
  out.FLEX = Math.max(out.DEF, out.MID, out.FWD);
  p._rs = out;
  return out;
}

// All 120 ways to give 5 cards the 5 roles.
const PERMS = (() => {
  const res = [];
  const rec = (arr, rest) => {
    if (!rest.length) return res.push(arr);
    rest.forEach((x, i) => rec([...arr, x], rest.filter((_, j) => j !== i)));
  };
  rec([], [0, 1, 2, 3, 4]);
  return res;
})();

function combos(n, k) {
  const res = [];
  const rec = (start, arr) => {
    if (arr.length === k) return res.push(arr);
    for (let i = start; i < n; i++) rec(i + 1, [...arr, i]);
  };
  rec(0, []);
  return res;
}
const COMBOS = { 5: combos(5, 5), 6: combos(6, 5), 7: combos(7, 5) };

function pairsByKey(players, keyFn) {
  const groups = new Map();
  for (const p of players) {
    const k = keyFn(p);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  let pairs = 0;
  const sizes = [];
  for (const n of groups.values()) { pairs += (n * (n - 1)) / 2; sizes.push(n); }
  sizes.sort((a, b) => b - a);
  return { pairs, sizes, groups };
}

const ERA_ORDER = ['1980s', '1990s', '2000s', '2010s', '2020s'];

/** Chemistry that depends only on which five players are together. */
function setChemistry(players) {
  const items = [];
  const squad = pairsByKey(players, p => p.clubId + '|' + p.era);
  const club = pairsByKey(players, p => p.clubId);
  const nation = pairsByKey(players, p => p.nationality);
  const eras = new Set(players.map(p => p.era)).size;

  if (squad.pairs) {
    for (const [k, n] of squad.groups) if (n > 1) {
      const p = players.find(x => x.clubId + '|' + x.era === k);
      items.push({ label: `${n}× ${p.club} ${p.era} teammates`, pts: CHEM.squadPair * (n * (n - 1)) / 2, kind: 'squad' });
    }
  }
  const crossClubPairs = club.pairs - squad.pairs;
  if (crossClubPairs > 0) {
    for (const [k, n] of club.groups) if (n > 1) {
      const sameClub = players.filter(x => x.clubId === k);
      const sq = pairsByKey(sameClub, x => x.era).pairs;
      const cross = (n * (n - 1)) / 2 - sq;
      if (cross > 0) items.push({ label: `${sameClub[0].club} legends across eras`, pts: CHEM.clubPair * cross, kind: 'club' });
    }
  }
  for (const [k, n] of nation.groups) if (n > 1) {
    items.push({ label: `${n}× ${k}`, pts: CHEM.nationPair * (n * (n - 1)) / 2, kind: 'nation' });
  }
  const flush = nation.sizes[0] === 5;
  if (flush) items.push({ label: 'National Team bonus', pts: CHEM.nationFlush, kind: 'nation' });
  const straight = eras === 5;
  if (straight) items.push({ label: 'Through the Eras (1980s→2020s)', pts: CHEM.eraStraight, kind: 'era' });

  return { items, squadSizes: squad.sizes, flush, straight };
}

function styleChemistry(lineup) {
  const items = [];
  const outfield = lineup.filter(s => s.role !== 'GK').map(s => s.player);
  const avg = f => outfield.reduce((a, p) => a + p[f], 0) / outfield.length;
  if (avg('technique') >= 85) items.push({ label: 'Tiki-Taka (technique)', pts: CHEM.styles.tikiTaka, kind: 'style' });
  const gk = lineup.find(s => s.role === 'GK').player;
  const def = lineup.find(s => s.role === 'DEF').player;
  if (gk.position === 'GK' && gk.gk >= 88 && def.defense >= 88) items.push({ label: 'Iron Wall (GK + DEF)', pts: CHEM.styles.ironWall, kind: 'style' });
  if (outfield.filter(p => p.attack >= 88).length >= 2) items.push({ label: 'Lethal Strike Partnership', pts: CHEM.styles.lethal, kind: 'style' });
  if (avg('physical') >= 85) items.push({ label: 'Engine Room (physical)', pts: CHEM.styles.engineRoom, kind: 'style' });
  return items;
}

/** Poker-style name for a team, from its chemistry pattern. */
export function handName(squadSizes, flush, straight) {
  const [a = 0, b = 0] = squadSizes;
  if (a === 5) return { rank: 10, name: 'Dream Team' };
  if (flush && straight) return { rank: 9, name: 'Golden Generation' };
  if (a === 4) return { rank: 8, name: 'Dynasty' };
  if (a === 3 && b === 2) return { rank: 7, name: 'Full House' };
  if (flush) return { rank: 6, name: 'National Team' };
  if (straight) return { rank: 5, name: 'Through the Eras' };
  if (a === 3) return { rank: 4, name: 'Trio' };
  if (a === 2 && b === 2) return { rank: 3, name: 'Two Partnerships' };
  if (a === 2) return { rank: 2, name: 'Partnership' };
  return { rank: 1, name: 'All-Stars' };
}

export const HAND_RANKINGS = [
  ['Dream Team', 'All five from the same squad (club + era)'],
  ['Golden Generation', 'Same nationality AND five different eras'],
  ['Dynasty', 'Four teammates from one squad'],
  ['Full House', 'Three teammates + two teammates from another squad'],
  ['National Team', 'All five share a nationality'],
  ['Through the Eras', 'One player from each era, 1980s → 2020s'],
  ['Trio', 'Three teammates from one squad'],
  ['Two Partnerships', 'Two pairs of teammates'],
  ['Partnership', 'Two teammates from one squad'],
  ['All-Stars', 'No teammates — pure talent'],
];

/** Score exactly five players: best role assignment + chemistry. */
export function scoreFive(players) {
  const rs = players.map(roleScores);
  let best = -1, bestPerm = null;
  for (const perm of PERMS) {
    let t = 0;
    for (let r = 0; r < 5; r++) t += rs[perm[r]][ROLES[r]];
    if (t > best) { best = t; bestPerm = perm; }
  }
  const lineup = bestPerm.map((pi, r) => ({ role: ROLES[r], player: players[pi], rating: rs[pi][ROLES[r]] }));
  const talent = best / 5;
  const set = setChemistry(players);
  const chemItems = [...set.items, ...styleChemistry(lineup)];
  const chemistry = chemItems.reduce((a, c) => a + c.pts, 0);
  const hand = handName(set.squadSizes, set.flush, set.straight);
  return {
    lineup, talent, chemistry, chemItems, hand,
    total: Math.round((talent + chemistry) * 10) / 10,
  };
}

/** Best five-player team from 5–7 cards. */
export function bestTeam(cards) {
  if (cards.length < 5) return null;
  let best = null;
  for (const c of COMBOS[cards.length]) {
    const s = scoreFive(c.map(i => cards[i]));
    if (!best || s.total > best.total) best = s;
  }
  return best;
}

/** Fast total-only version for Monte Carlo (skips label building). */
export function bestTotal(cards) {
  let best = -1;
  for (const c of COMBOS[cards.length]) {
    const ps = c.map(i => cards[i]);
    const rs = ps.map(roleScores);
    let t = -1, bp = null;
    for (const perm of PERMS) {
      let s = 0;
      for (let r = 0; r < 5; r++) s += rs[perm[r]][ROLES[r]];
      if (s > t) { t = s; bp = perm; }
    }
    const lineup = bp.map((pi, r) => ({ role: ROLES[r], player: ps[pi] }));
    let v = t / 5 + quickChem(ps);
    for (const it of styleChemistry(lineup)) v += it.pts;
    v = Math.round(v * 10) / 10;
    if (v > best) best = v;
  }
  return best;
}

function quickChem(ps) {
  const sq = pairsByKey(ps, p => p.clubId + '|' + p.era);
  const cl = pairsByKey(ps, p => p.clubId);
  const na = pairsByKey(ps, p => p.nationality);
  let c = sq.pairs * CHEM.squadPair + (cl.pairs - sq.pairs) * CHEM.clubPair + na.pairs * CHEM.nationPair;
  if (na.sizes[0] === 5) c += CHEM.nationFlush;
  if (new Set(ps.map(p => p.era)).size === 5) c += CHEM.eraStraight;
  return c;
}

export { ERA_ORDER };
