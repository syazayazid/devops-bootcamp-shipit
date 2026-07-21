# Ship It — Typing Race Mode design

**Date:** 2026-07-18
**Status:** Approved — the three open decisions resolved 2026-07-18 (Three.js ortho · server-authoritative · v1 mechanic)
**Related:** `CLAUDE.md` (pinned contracts), `docs/specs/2026-07-11-ship-it-architecture-design.md` (base architecture), slides reconciliation issue [`Infratify/slides-devops-bootcamp#161`](https://github.com/Infratify/slides-devops-bootcamp/issues/161)

## Summary

The board gains a **multiplayer typing-race mode**. Learners type CLI commands they have
already learned (Linux, git, gh, docker, aws) to drive their ship down a shared race track on
the projector. The launchpad gains one thing: a **READY button** that carries the learner from
their own static site to the board.

The point is not the game. The point is a **contrast that teaches beginners why a backend
server exists**: a static site (their launchpad on Pages) provably *cannot* run a shared,
realtime, multiplayer race — no shared state, no live push. A running server (the board) can.
The learner feels the wall, then in CI/CD 4 builds and deploys the very server that clears it.

This extends the prop; it does not replace it. The board keeps its roster/orbit "first contact"
view; race mode is an operator-toggled second view. The report → board event contract, the
serverless launchpad, and the S4 container-on-EC2 lesson are all preserved.

## Pedagogical thesis

Beginners struggle to see why a backend server is needed — CRUD apps make it look optional. A
multiplayer game makes the need undeniable. The lesson lives in a single contrast the learner
experiences with their own two URLs:

| | Static site (S1–S3) | Server (S4) |
|---|---|---|
| what it is | files on a CDN | a running process |
| your ship | solo, alone | racing everyone |
| knows about other players? | no | yes |
| can push live updates? | no | yes (WebSocket) |
| where | `user.github.io/…` | `BOARD_URL` |

The READY button is the journey from the left column to the right: *leaving your file, going to
the server*. Everyone lands on one URL — the hub made visible. The room becomes a live
client-server diagram (laptops = clients, projector = server).

Supporting teaching moves: the **kill-the-server demo** (stop the board mid-race → every laptop
freezes → "no server = no game"); a **live server HUD** on the projector ("47 clients connected ·
broadcasting 20×/sec"); the **postcard vs phone call** metaphor (S3 report = one fire-and-forget
POST; S4 game = a connection that stays open).

## What changes / what stays

**Stays (pins preserved):**

- Launchpad stays **static** — no backend of its own. A static page opening a WebSocket to the
  board is still static-hosted. "Serverless S1–S3" and "beginner-simple" hold.
- The **report → board event contract is unchanged.** The race reuses the existing roster
  `{ callsign, color, shipModel }` as its player list and ship appearance.
- The board's roster/orbit "first contact" view stays — it is still the S3 payoff.
- S4's pinned concept (build board image → GHCR → deploy to own EC2) is untouched and, in fact,
  reinforced: a multiplayer game server genuinely needs a server.
- Conventions hold: Node 20 ESM, no CDN, WebGL + reduced-motion fallbacks, one test gate
  (`preflight.mjs`), dev-time `node --test`, no vitest/Playwright.

**Changes:**

- Launchpad: add a **READY button** (a plain `<a href>` to `BOARD_URL/play?callsign=…`) and derive
  the learner's callsign at runtime from `location.hostname` instead of `VITE_CALLSIGN`.
- Board: add **race mode** — a `/play` cockpit page, inbound cockpit WebSocket handling (currently
  spectators are read-only), authoritative race state, an operator control surface, and a 2D race
  view alongside the existing orbit view.

**Notably NOT reversed:** the pinned "taught workflow never sets `VITE_CALLSIGN`" decision. Because
identity is derived from the Pages hostname at runtime, the workflow build step gains nothing. No
slides change to the workflow.

## Architecture

### Identity flow (two separate moments — do not conflate)

1. **Pipeline deploy (in the runner, S3).** `report.sh` POSTs one event → roster gains
   `{ callsign, color, shipModel }`. This is "registered." Already happens today.
2. **Live play (in the browser, later).** Learner opens their own Pages site → clicks READY →
   navigates to the board cockpit → drives their ship by typing.

The roster from moment 1 is the player list for moment 2.

**Callsign derivation (launchpad, runtime):** `location.hostname` is `user.github.io` for both
user and project Pages sites, so `hostname.split('.')[0]` yields the GitHub username = callsign.
Zero build change, zero pin reversal. Falls back to `VITE_CALLSIGN` then empty for local dev /
custom domains / org accounts.

**Roster gate (the ticket):** the board admits `?callsign=X` to the race **only if X is already
on the roster** — i.e. their pipeline actually ran and reported. Not on roster → "Ship not found —
run your pipeline first." A green pipeline is the literal entry ticket. Reuses existing state; adds
none.

**Callsign canonicalization (implementation note):** the board **lowercases the callsign at ingest**
(`sanitizeEvent`). GitHub usernames are case-insensitive and GitHub Pages hostnames are always
lowercase, so the cockpit (hostname-derived) can only ever produce a lowercase callsign — the roster
must key on the same form or a mixed-case user (`JohnDoe`) is permanently denied. Consequence: the
shared board now **displays callsigns lowercase** (`@johndoe`), including in the existing S3 orbit
view. Not a pin violation — no contract pins display case, and the event-contract example already
uses lowercase — but note it in CLAUDE.md / the slides so the S3 "first contact" label change is
expected.

### Launchpad changes (stays static)

- `src/main.js`: replace `const callsign = import.meta.env.VITE_CALLSIGN || ''` with a
  hostname-first derivation (new `src/callsign.js`, unit-tested with `node --test`).
- Add a READY button to the overlay: `href = "${VITE_BOARD_URL}/play?callsign=${callsign}"`.
  - `VITE_BOARD_URL` is a **public** build var (the board's address is a variable, never a secret).
    If unset, the button is hidden (pre-S3 / local dev) — the site degrades to today's behaviour.
  - **Build-time wiring (load-bearing — tracked in slides issue #161):** `VITE_BOARD_URL` is read
    by Vite at **build** time (`import.meta.env`), so the taught workflow's **build** step must set
    it: `env: { VITE_BOARD_URL: ${{ vars.BOARD_URL }} }` on the `npm run build` step. The pinned
    S3 report step exposes `BOARD_URL` only at *report* time (runtime), which the build never sees —
    so without this the button stays hidden and the race is unreachable in the real learner
    deployment. Reuses the existing `BOARD_URL` repo variable; adds no new secret.
  - The button is inert until the board is in race mode; the cockpit handles the "waiting for
    race" state, so the button can safely exist from the first fork.
- No other launchpad change. It remains the solo "file" half of the contrast.

### Board changes (race mode)

- **`/play` cockpit page** (new Vite entry): reads `?callsign`, opens a WebSocket to the board,
  renders the typing UI + the learner's own ship, sends progress. This is where the heavy game
  client lives — keeping it board-side is deliberate (the server is the hub; everyone comes here).
- **Inbound WebSocket handling** (`app.js`): today `wss` ignores inbound messages. Add a cockpit
  message protocol (below). Spectator connections stay read-only.
- **Authoritative race state** (new `src/race.js`, pure + node-testable, mirroring `room.js`): the
  server owns the prompt sequence and each ship's position; clients report completions, the server
  advances and broadcasts. Authoritative-server is on-theme for the lesson.
- **Operator control surface**: start/reset a race, toggle projector view orbit ↔ race. Guarded by
  a separate server-side `OPERATOR_KEY` (kept distinct from `SHIPIT_TOKEN` — the report token and the
  race-control key are different concerns). Never exposed to clients.
- **2D race view** (board client): a **Three.js orthographic camera** onto a side-on track, reusing
  the existing low-poly `.glb` ships (same assets as the orbit view), rendering all ships from
  broadcast race state, plus the live server HUD. Keeps the "board carries the Three.js spectacle"
  convention and the existing WebGL/reduced-motion fallback path (a 2D static leaderboard when WebGL
  is unavailable).

### Data flow

```
S3 pipeline ──report.sh POST──▶ board roster {callsign,color,shipModel}
                                        │
learner opens own Pages site ──READY──▶ BOARD_URL/play?callsign=X
                                        │ (roster gate: X must be present)
                                        ▼
                              cockpit WS ⇄ board race state ──broadcast──▶ projector 2D race
```

## Game design

### Mechanic (v1 — defaults locked, numbers tunable at playtest)

Classic typing racer, server-authoritative:

- **Same prompts for everyone.** At round start the server picks `N` commands from the session
  corpus and broadcasts the identical ordered sequence to all cockpits (fairness). Default
  **`N = 12`** (≈60–120s for a beginner cohort).
- **Position = commands completed.** The track has `N` segments; a ship advances one segment per
  command it completes. Ship position on the projector = `completed / N`. First to `N` wins;
  ties broken by server-side completion time.
- **Completion is exact-match.** The cockpit shows the target command; a command counts complete only
  when the learner's input exactly matches (backspace allowed). On match the cockpit sends
  `{ t: 'progress', callsign, completed }`; the server validates the index is the expected next one,
  advances, and broadcasts.
- **Beginner-friendly mistypes.** No lockout, no reset, no hard penalty — a mistype simply costs the
  time to fix and retype. Speed differences alone separate the field.
- **Server is authoritative over position and round phase.** Keystroke-level correctness is judged
  client-side (lightly spoofable — acceptable, see security); the server owns who is where and when
  the round ends.

### Corpus (session-gated)

Prompts are drawn only from commands taught up to the current point (~130 forms by CI/CD 3:
Linux ~40, git ~20, gh ~23, docker ~30, aws ~27 — inventory in the slides repo). Natural
difficulty tiers fall out by tool (short Linux basics → longer git/docker → aws one-liners as
"boss" prompts). Corpus lives in a board data file, filterable by session.

### Race lifecycle

Instructor/operator-driven: start round, reset, next round. Learners joining mid-round enter at the
start line of the next round; disconnects are handled gracefully (ship parks, rejoins on reconnect).
No persistence beyond the current cohort session (arena pattern).

## WebSocket protocol

Extends the current `{ t: 'roster', ships }` broadcast. Cockpit (inbound) and race (outbound)
messages:

- **inbound** `{ t: 'join', callsign }` — cockpit announces itself; server validates against roster.
- **inbound** `{ t: 'progress', callsign, completed }` — learner finished command index `completed`.
- **outbound** `{ t: 'race', phase, prompts, ships }` — authoritative race snapshot (positions,
  current round, phase = `idle | countdown | running | finished`).
- **outbound** `{ t: 'roster', ships }` — unchanged, used by the orbit view.

Client-side keystroke validation (the cockpit decides "typed correctly"); the server is
authoritative over *position and round*. Keystroke validation is lightly spoofable — acceptable
(see security).

## Identity & security

- `SHIPIT_TOKEN` **never** touches the client. It is the CI/CD 3 secret, used only server-side by
  `report.sh` in the runner. The Pages bundle is world-readable; embedding the board bearer token
  there would leak it. The cockpit WebSocket is therefore **unauthenticated by design**.
- `?callsign=X` is a claim, spoofable by anyone. For a classroom party game this is acceptable and
  intentional. The roster gate limits play to callsigns that actually shipped, which is enough.
- The operator control surface is the one privileged path; guard it server-side with an operator key,
  never shipped to clients.

## Session integration

Race in **both** CI/CD 3 and CI/CD 4, with different jobs (see slides issue #161):

- **CI/CD 3 — the experience.** Everyone's pipeline has reported → all connected → race on the
  instructor board as the celebratory session close. No server concept taught; no new LO. It is the
  payoff that *secret worked*.
- **CI/CD 4 — the lesson.** The session's existing productive-failure ("Pages ≠ jalankan server") is
  reframed to reference the race they already played, then they build + deploy the board image to
  their own EC2. Kill-server demo + "the engine you deployed is that race server" reveal. Optional
  short victory re-race.

**Two servers, two roles:** the shared multiplayer race always runs on **instructor infra** (only a
shared server gives multiplayer); the board each learner deploys to their EC2 in S4 is a **solo
victory lap** running the same software. That distinction is itself teachable.

The slides live in a separate repo and are reconciled by hand — tracked in issue #161, to be done
in a separate session.

## Pins & contracts impact

- Report → board event contract: **unchanged.**
- Serverless S1–S3 launchpad: **preserved** (static site + WebSocket client).
- "Workflow never sets `VITE_CALLSIGN`": **preserved** (hostname-parse instead).
- S4 concept (image → GHCR → EC2): **preserved and reinforced.**
- New public build var `VITE_BOARD_URL` for the launchpad (the board address is a variable, not a
  secret). **Must be set on the taught workflow's `npm run build` step** (`env: VITE_BOARD_URL:
  ${{ vars.BOARD_URL }}`) or the READY button hides and the race is unreachable — build-time var, not
  the S3 report step's runtime `BOARD_URL`. Slides/workflow wiring tracked in issue #161.
- Board **lowercases the callsign at ingest** (canonical, case-insensitive usernames / lowercase
  Pages hostnames) — shared-board display becomes lowercase; document in CLAUDE.md / slides. Not a
  pin violation (no contract pins display case).
- Board accepts inbound cockpit WebSocket messages (new); production still rejects unauthenticated
  *events* on `/api/event` (unchanged) — the cockpit WS is a separate, deliberately unauthenticated
  channel.

## Resolved decisions (2026-07-18)

1. **Renderer for the 2D race view: Three.js orthographic camera**, reusing the existing low-poly
   `.glb` ships — keeps the "board carries the Three.js spectacle" convention and the
   WebGL/reduced-motion fallback path, and reuses assets. (Canvas 2D rejected: second renderer + new
   fallback path, off-convention.)
2. **Race authority: server-authoritative** over position and round phase, with client-side
   keystroke validation. On-theme for "the server holds the truth." (Fully client-reported positions
   rejected: too spoofable, and it undercuts the lesson.)
3. **Mechanic: v1 defaults locked** (see Game design) — `N = 12` commands, position = completions,
   exact-match completion, beginner-friendly mistypes. Numbers tunable at playtest.

## Non-goals (YAGNI)

- No accounts, no auth beyond the roster gate, no persistence beyond the cohort session.
- No anti-cheat beyond the roster gate (party game).
- No launchpad backend, no launchpad-as-cockpit (rejected: it blurs the static-vs-server lesson).
- No new test frameworks (Node's built-in `node --test` only; the one gate stays `preflight.mjs`).

## Build & delivery timing

The game must ship in the prop **before CI/CD 3** (the experience race is that session's close),
not before CI/CD 4. This moves the delivery deadline earlier than a CI/CD 4-only payoff would. The
launchpad READY button ships in the fork from the start (static, inert until race mode).

## Testing

- Launchpad `callsign.js`: `node --test` unit tests (hostname → callsign, fallbacks).
- Board `race.js`: `node --test` unit tests (pure race-state transitions), mirroring `room.test.js`.
- Board `app.js`: server tests for the cockpit WS join/progress path, mirroring `server.test.js`.
- The one learner-facing gate remains `preflight.mjs`. No vitest, no Playwright.
