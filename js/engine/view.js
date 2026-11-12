// What one seat is allowed to see. The host sends this to each player, so
// other players' hole cards never leave the host until showdown.
// Cards are sent as ids; every client hydrates them from its own copy of
// players.json.

const BETTING = ['preflop', 'flop', 'turn', 'river'];

export function viewFor(t, me, extra = {}) {
  const handover = t.street === 'handover';
  const reveal = handover && t.result && !t.result.uncontested;
  const betting = BETTING.includes(t.street);
  return {
    ...extra,
    me,
    handNo: t.handNo,
    sb: t.sb,
    bb: t.bb,
    street: t.street,
    dealer: t.dealer,
    toAct: t.toAct ?? -1,
    currentBet: t.currentBet || 0,
    runningOut: !!t.runningOut,
    pot: handover && t.result ? t.result.winners.reduce((a, w) => a + w.amount, 0) : t.pot,
    seats: t.seats.map((s, i) => ({
      name: s.name, chips: s.chips, style: s.style, isHuman: s.isHuman, isBot: !s.isHuman,
      out: s.out, folded: s.folded, allIn: s.allIn, bet: s.bet, lastAction: s.lastAction,
      connected: s.connected !== false,
      holeCount: s.hole.length,
      hole: i === me || (reveal && !s.folded && !s.out) ? s.hole.map(c => c.id) : null,
    })),
    board: (t.board || []).map(c => c.id),
    legal: betting && t.toAct === me && me >= 0 ? t.legal(me) : null,
    result: t.result ? {
      uncontested: t.result.uncontested,
      winners: t.result.winners,
      showdown: reveal ? Object.keys(t.result.teams).map(Number) : [],
    } : null,
    // The 52-card set for this hand (not its order) — lets each client
    // estimate its own win chance without seeing anyone's cards.
    deck: betting ? t.deckIds : null,
    log: t.log.slice(-60),
  };
}
