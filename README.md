# Fútbol Poker

Texas Hold'em where the cards are footballers. Each player gets 2 player
cards, 5 more come to the board, and the best **5-a-side team** (GK, DEF,
MID, FWD + one flexible outfielder) out of your 7 wins the pot. A team's
score is **Talent + Chemistry**, and chemistry carries a lot of the weight.

## Play online

**https://mobitics.github.io/futbol-poker/** is hosted on GitHub Pages from this repo. Every push to `main` redeploys it.

Click **Create online table** and send friends the invite link. The host's browser runs the game, and players connect to it directly through WebRTC (PeerJS). There's no server, so the host has to keep the tab open. The code is in `js/net.js` and `js/engine/view.js`.

## Run it locally

No install needed. Python 3 serves the folder:

```bash
cd "/Users/js/Futbol Poker" && python3 -m http.server 8765
```

Then open http://localhost:8765.

## How a hand is scored (`js/engine/evaluate.js`)

- **Talent:** the average role rating across the 5 positions. Each rating is
  built from attack/defense/technique/physical/gk/overall, and playing out
  of position costs you (an outfielder in goal gets about 30).
- **Chemistry:** teammates (same club + era) +4 per pair; same club in a
  different era +1.5 per pair; same nationality +1.5 per pair, plus +6 if
  all five share one; one player from each era (1980s→2020s) +10; style
  bonuses (Tiki-Taka, Iron Wall, Lethal Strike Partnership, Engine Room)
  +2 to +3.
- **Hand names** use poker vocabulary: Partnership (pair), Two Partnerships,
  Trio, Through the Eras (straight), National Team (flush), Full House,
  Dynasty (quads), Golden Generation (straight flush).

All the weights are in the `CHEM` constant, so tuning means editing that one place.

## The deck (`js/engine/deck.js`)

Every hand builds a fresh 52-card deck from **13 random squads × 4
players**. Squads stand in for ranks, so you land teammates about as often as
you land a pair in real poker. Stars come up more often, there is at most one
keeper per squad, and no person appears twice.

## Other pieces

- `js/engine/table.js`: the no-limit Hold'em state machine. It handles
  blinds, heads-up rules, min-raises, all-in run-outs and side pots.
- `js/engine/ai.js`: the bots. Each estimates its equity with a Monte Carlo
  run over the unseen cards, then plays against pot odds. The four
  personalities are Rock, Pro, Maniac and Caller.
- `js/main.js`: the UI. It shows your live "best five" with its chemistry
  breakdown and win %, plus the showdown screen.
- `data/players.json`, `data/clubs.json`: copied from the 15-0 app
  (2,415 players, 185 club/era squads, editorial 1–99 ratings).
