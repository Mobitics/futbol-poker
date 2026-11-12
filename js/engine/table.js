// No-limit Texas Hold'em table where the cards are footballers.
// Pure state machine: the UI calls act() and reads state; no DOM.

import { buildDeck, mulberry32 } from './deck.js';
import { bestTeam } from './evaluate.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

export class Table {
  constructor({ seats, squads, smallBlind = 10, bigBlind = 20, seed = Date.now(), deckOpts = {} }) {
    this.seats = seats.map((s, i) => ({
      index: i, name: s.name, isHuman: !!s.isHuman, style: s.style || null,
      token: s.token || null, connected: true,
      chips: s.chips, hole: [], folded: false, allIn: false,
      bet: 0, total: 0, acted: false, out: s.chips <= 0, lastAction: '',
    }));
    this.squads = squads;
    this.sb = smallBlind;
    this.bb = bigBlind;
    this.rng = mulberry32(seed);
    this.deckOpts = deckOpts;
    this.dealer = Math.floor(this.rng() * this.seats.length);
    this.handNo = 0;
    this.log = [];
    this.street = 'idle';
  }

  /** Add a player between hands (online late joiners). */
  addSeat(s) {
    this.seats.push({
      index: this.seats.length, name: s.name, isHuman: !!s.isHuman, style: s.style || null,
      token: s.token || null, connected: true,
      chips: s.chips, hole: [], folded: true, allIn: false,
      bet: 0, total: 0, acted: false, out: s.chips <= 0, lastAction: '',
    });
    return this.seats.length - 1;
  }

  get live() { return this.seats.filter(s => !s.out); }
  get inHand() { return this.seats.filter(s => !s.out && !s.folded); }
  get pot() { return this.seats.reduce((a, s) => a + s.total, 0); }

  nextIdx(i, pred) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const j = (i + k) % n;
      if (pred(this.seats[j])) return j;
    }
    return -1;
  }

  say(msg) { this.log.push({ hand: this.handNo, msg }); }

  startHand() {
    for (const s of this.seats) s.out = s.chips <= 0;
    if (this.live.length < 2) { this.street = 'gameover'; return; }
    this.handNo++;
    this.deck = buildDeck(this.squads, this.rng, this.deckOpts);
    this.deckIds = this.deck.map(c => c.id);
    this.board = [];
    this.result = null;
    for (const s of this.seats) {
      Object.assign(s, { hole: [], folded: s.out, allIn: false, bet: 0, total: 0, acted: false, lastAction: '' });
    }
    this.dealer = this.nextIdx(this.dealer, s => !s.out);
    const headsUp = this.live.length === 2;
    const sbIdx = headsUp ? this.dealer : this.nextIdx(this.dealer, s => !s.out);
    const bbIdx = this.nextIdx(sbIdx, s => !s.out);
    this.sbIdx = sbIdx; this.bbIdx = bbIdx;
    this.say(`— Hand #${this.handNo} — ${this.seats[this.dealer].name} has the button`);
    this.postBlind(sbIdx, this.sb, 'SB');
    this.postBlind(bbIdx, this.bb, 'BB');
    for (let r = 0; r < 2; r++) {
      let i = sbIdx;
      for (let k = 0; k < this.live.length; k++) {
        this.seats[i].hole.push(this.deck.pop());
        i = this.nextIdx(i, s => !s.out);
      }
    }
    this.street = 'preflop';
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.toAct = this.nextIdx(bbIdx, s => !s.folded && !s.allIn);
    this.checkRoundOver();
  }

  postBlind(i, amt, label) {
    const s = this.seats[i];
    const a = Math.min(amt, s.chips);
    s.chips -= a; s.bet += a; s.total += a;
    if (s.chips === 0) s.allIn = true;
    s.lastAction = `${label} ${a}`;
    this.say(`${s.name} posts ${label} ${a}`);
  }

  /** What the seat to act may do. */
  legal(i = this.toAct) {
    const s = this.seats[i];
    const toCall = Math.min(this.currentBet - s.bet, s.chips);
    const maxTo = s.bet + s.chips;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    return {
      toCall,
      canCheck: toCall === 0,
      canRaise: s.chips > toCall,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
    };
  }

  /** action: {type:'fold'|'check'|'call'|'raise', to?: number} ('raise' to a total bet) */
  act(i, action) {
    if (i !== this.toAct || !['preflop', 'flop', 'turn', 'river'].includes(this.street)) return false;
    const s = this.seats[i];
    const L = this.legal(i);
    let { type } = action;
    if (type === 'check' && !L.canCheck) type = 'call';
    if (type === 'call' && L.toCall === 0) type = 'check';

    if (type === 'fold') {
      s.folded = true; s.lastAction = 'Fold';
      this.say(`${s.name} folds`);
    } else if (type === 'check') {
      s.lastAction = 'Check';
      this.say(`${s.name} checks`);
    } else if (type === 'call') {
      const a = L.toCall;
      s.chips -= a; s.bet += a; s.total += a;
      if (s.chips === 0) s.allIn = true;
      s.lastAction = s.allIn ? `All-in ${s.bet}` : `Call ${a}`;
      this.say(`${s.name} ${s.allIn ? 'calls all-in' : 'calls'} ${a}`);
    } else if (type === 'raise') {
      if (!L.canRaise) return this.act(i, { type: 'call' });
      let to = Math.max(L.minRaiseTo, Math.min(Math.floor(action.to), L.maxRaiseTo));
      const a = to - s.bet;
      const raiseBy = to - this.currentBet;
      s.chips -= a; s.bet = to; s.total += a;
      if (s.chips === 0) s.allIn = true;
      if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
      const wasBet = this.currentBet === 0;
      this.currentBet = Math.max(this.currentBet, to);
      for (const o of this.seats) if (o !== s) o.acted = false;
      s.lastAction = s.allIn ? `All-in ${to}` : `${wasBet ? 'Bet' : 'Raise to'} ${to}`;
      this.say(`${s.name} ${s.allIn ? 'goes all-in for' : wasBet ? 'bets' : 'raises to'} ${to}`);
    }
    s.acted = true;
    this.toAct = this.nextIdx(i, o => !o.folded && !o.allIn && !o.out);
    this.checkRoundOver();
    return true;
  }

  checkRoundOver() {
    const inHand = this.inHand;
    if (inHand.length === 1) return this.awardUncontested(inHand[0]);
    const canAct = inHand.filter(s => !s.allIn);
    const pending = canAct.filter(s => !s.acted || s.bet < this.currentBet);
    if (pending.length === 0 || (canAct.length <= 1 && pending.length === 0)) return this.nextStreet();
    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) return this.nextStreet();
    const cur = this.seats[this.toAct];
    if (!cur || cur.folded || cur.allIn || (cur.acted && cur.bet >= this.currentBet)) {
      this.toAct = this.nextIdx(this.toAct, o => !o.folded && !o.allIn && !o.out && (!o.acted || o.bet < this.currentBet));
    }
  }

  nextStreet() {
    for (const s of this.seats) { s.bet = 0; s.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;
    const idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    if (this.street === 'flop') { this.deck.pop(); this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); }
    if (this.street === 'turn' || this.street === 'river') { this.deck.pop(); this.board.push(this.deck.pop()); }
    if (this.street === 'showdown') return this.showdown();
    this.say(`${this.street[0].toUpperCase() + this.street.slice(1)}: ${this.board.map(c => c.name).join(', ')}`);
    const canAct = this.inHand.filter(s => !s.allIn);
    if (canAct.length <= 1) {
      this.toAct = -1;
      this.runningOut = true; // UI reveals remaining streets with a delay
      return;
    }
    this.toAct = this.nextIdx(this.dealer, o => !o.folded && !o.allIn && !o.out);
  }

  /** Called by the UI while everyone is all-in, one street at a time. */
  advanceRunout() {
    if (!this.runningOut) return;
    this.runningOut = false;
    this.nextStreet();
  }

  awardUncontested(w) {
    const pot = this.pot;
    w.chips += pot;
    this.say(`${w.name} wins ${pot} (everyone else folded)`);
    this.result = { uncontested: true, winners: [{ seat: w.index, amount: pot }], teams: {}, pots: [] };
    this.street = 'handover';
    this.toAct = -1;
    for (const s of this.seats) { s.total = 0; s.bet = 0; }
  }

  showdown() {
    this.toAct = -1;
    const teams = {};
    for (const s of this.inHand) teams[s.index] = bestTeam([...s.hole, ...this.board]);
    // Side pots
    const levels = [...new Set(this.seats.filter(s => s.total > 0).map(s => s.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const s of this.seats) amount += Math.max(0, Math.min(s.total, lvl) - prev);
      const eligible = this.inHand.filter(s => s.total >= lvl).map(s => s.index);
      if (eligible.length === 0 && pots.length) pots[pots.length - 1].amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = lvl;
    }
    // Merge consecutive pots with identical eligibility (cosmetic).
    const merged = [];
    for (const p of pots) {
      const last = merged[merged.length - 1];
      if (last && last.eligible.join() === p.eligible.join()) last.amount += p.amount;
      else merged.push({ ...p });
    }
    const winnings = {};
    merged.forEach((p, pi) => {
      const top = Math.max(...p.eligible.map(i => teams[i].total));
      const ws = p.eligible.filter(i => teams[i].total === top);
      // Odd chips go to the first winner left of the button.
      const ordered = [];
      let j = this.dealer;
      for (let k = 0; k < this.seats.length; k++) { j = (j + 1) % this.seats.length; if (ws.includes(j)) ordered.push(j); }
      const share = Math.floor(p.amount / ws.length);
      let rem = p.amount - share * ws.length;
      p.winners = ordered;
      for (const w of ordered) {
        const amt = share + (rem-- > 0 ? 1 : 0);
        this.seats[w].chips += amt;
        winnings[w] = (winnings[w] || 0) + amt;
      }
      const label = merged.length > 1 ? (pi === 0 ? 'main pot' : `side pot ${pi}`) : 'the pot';
      this.say(`${ordered.map(w => this.seats[w].name).join(' & ')} win${ordered.length > 1 ? ' (split)' : 's'} ${p.amount} from ${label} — ${teams[ordered[0]].hand.name}, ${teams[ordered[0]].total}`);
    });
    this.result = {
      uncontested: false, teams, pots: merged,
      winners: Object.entries(winnings).map(([seat, amount]) => ({ seat: +seat, amount })),
    };
    for (const s of this.seats) { s.total = 0; s.bet = 0; }
    this.street = 'handover';
  }
}
