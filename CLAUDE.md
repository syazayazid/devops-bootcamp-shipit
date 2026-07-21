# CLAUDE.md — Ship It: Mission Control

Design rationale and the **pinned contracts** for this CI/CD teaching prop. Read `PROMPT.md`
first for the build brief, and `docs/specs/2026-07-11-ship-it-architecture-design.md` for the full
resolved architecture. This file is the durable source of truth once the build starts — keep the
contracts here stable, because the bootcamp slides quote them.

## What this is

A live CI/CD teaching prop for the 2026 DevOps bootcamp. Learners each ship a personal **ship
microsite** through a GitHub Actions pipeline; a green run **launches their ship into a shared
orbit** on the projector ("Mission Control"). It makes the invisible pipeline visible, shared,
and personal — the CI/CD counterpart to the arena prop.

Distinct from its siblings (do not blur them):
- `devops-bootcamp-app` — Three.js Docker-layers scrollytelling. **Match its visual bar.**
- `devops-bootcamp-game` — PixiJS avatar arena. **Match its shared-live-personal interaction.**

## Why it's shaped this way

- **The pipeline is the abstract thing.** CI/CD is YAML + green checks + logs — invisible. The
  prop's whole job is to give the pipeline a *body*: launch phases you watch, a ship that either
  reaches orbit or aborts on its pad.
- **One repo, one growing workflow.** Each learner keeps ONE repo across all four sessions; the
  workflow file *grows* (Pages deploy → build/test gate → secrets/approval → build & ship the board
  container to their own EC2). Four throwaway projects would kill the "watch it mature" payoff.
- **Personal identity in a shared world.** Every ship is customized (callsign, colour, model,
  emblem), so the shared orbit is 60 distinct ships, not 60 identical ones — the reason the arena
  landed.
- **Felt-need spine.** Each session automates last week's manual step; the ship visibly gets
  closer to orbit as the pipeline does more of the work.

## Components

| Component | Built from | Image | Port |
|---|---|---|---|
| `shipit-board` — Mission Control (ws hub + Three.js spectator) | `board/` | `ghcr.io/infratify/shipit-board` | 3000 |

- **`launchpad/` — the learner ship microsite.** **Serverless** (static, `vite build` → GitHub
  Pages; extensible to CF Pages). **No image** — the ship is static-only. Three.js, like `devops-bootcamp-app`.
- **`shipit-board` is dual-role:** the *shared* Mission Control on instructor EC2, **and** the
  artifact each learner **builds + deploys to their own EC2** in the S4 capstone.
- Learners fork **this monorepo** (`Infratify/devops-bootcamp-shipit`) and work in `launchpad/`
  (see Distribution below). The planned payload-only `shipit-launchpad` release repo was never used.

## PINNED — the 4-session arc (lean: one concept per session)

Slides quote this. Everything else — matrix, artifacts, environments, manual approval, tags,
rollback — is optional **stretch**, never required hands-on.

| Session | The one concept | What the learner sees |
|---|---|---|
| **S1** | a pipeline deploys on `push` | pad lights up — ship live on GitHub Pages |
| **S2** | a **test gate** can block you | systems check — green = go · red = **ABORT** |
| **S3** | **secrets** let your ship report to Mission Control (`$SHIPIT_TOKEN`) | first contact — ship appears live on the shared board |
| **S4** | your pipeline **builds a container and runs it on your server** | LIFTOFF — you deploy your *own* Mission Control to your EC2 |

The ship is serverless S1–S3; **S4's build/deploy artifact is the `board` image**, because the board
is the one thing that genuinely needs a server (the honest container-on-a-server lesson). Learners
already did `docker build` + ECR by hand in the AWS sessions — S4 *automates that in the pipeline*.

## PINNED — pipeline ↔ board event contract

The one integration point. Keep it stable; slides and the reference workflows depend on it.

- **Identity** = the learner's GitHub username (`${{ github.actor }}`), used as `callsign`.
- **Config:** the report script reads `color` + `shipModel` from the learner's `ship.config.json`,
  so the board renders each learner's real colour AND model (hex or a named-palette colour; board
  normalizes, greys/blacks stay neutral). `shipName` is cosmetic, never identity.
- **Transport:** `launchpad/scripts/report.sh` (shipped in this repo — learners call it, never write
  it) POSTs one event per invocation. The learner workflow adds ONE step (CI/CD 3 Amali 2) — a
  **single liftoff report** after the Pages deploy:

```yaml
- name: Lapor ke papan
  run: bash scripts/report.sh
  env:
    BOARD_URL: ${{ vars.BOARD_URL }}
    SHIPIT_TOKEN: ${{ secrets.SHIPIT_TOKEN }}
```

  That `env:` block IS the lesson surface — one `vars` line, one `secrets` line, nothing else. The
  HTTP mechanics live in the script. Extra beats (`report.sh pad running`, abort-on-failure) are
  optional operator flourishes, never required of learners.

What the script sends (slides show this as *anatomy* — learners read it, never type it):

```
POST  $BOARD_URL/api/event
Authorization: Bearer $SHIPIT_TOKEN
Content-Type: application/json

{ "callsign": "octocat", "stage": "liftoff", "status": "shipped",
  "color": "#22d3ee", "shipModel": "fighter",
  "siteUrl": "https://octocat.github.io/devops-bootcamp-shipit/" }
```

`callsign` = `GITHUB_ACTOR` (Actions sets it automatically — no templating in the learner file);
`color`/`shipModel` read from `ship.config.json`; stage/status from the script args (default
`liftoff shipped`). `siteUrl` is **derived inside `report.sh`** from the vars Actions already sets
(`GITHUB_REPOSITORY_OWNER` + repo name → `https://<owner>.github.io[/<repo>]/`) — NOT from the taught
`env:` block, which stays the pinned two lines. Omitted when the script runs outside Actions.

- **Board accepts more than the taught report** (operator flourishes only, never asked of learners):
  `stage` ∈ `pad | build | test | clearance | liftoff`, `status` ∈ `running | passed | failed |
  aborted | shipped`, plus optional `version`, `siteUrl`. Required: just `callsign` + a known
  `stage`/`status` — `color`/`shipModel` default when absent or invalid (see `board/src/room.js`).
- **`siteUrl` → LIVE (green).** When an event carries a `siteUrl`, the board probes it (`HEAD`, on
  arrival + a periodic sweep) and broadcasts a per-ship `live` boolean on the roster; a ship shows a
  green **LIVE** halo only when its *real* Pages site answers `200` (see `board/src/liveness.js`).
  This ties the token + report to the actual deploy — a reported ship that never went live stays
  neutral. A fresh deploy can 404 for ~1 min; the periodic re-check flips it green when the site
  actually comes up. Non-200/timeout = "not live yet," never an error.
- **The script's `curl` uses `--fail-with-body`** (pinned in `report.sh`'s header too): on a 401
  the step **fails** (non-zero exit → red run) AND the run log prints `{"error":"unauthorized"}`,
  so the wrong-token demo shows both the red X and the reason. Changed 2026-07-20 (was: no `-f`,
  stay-green — the shape CI/CD 3 Amali 3 was delivered with). Plain `-f` would swallow the
  response body — don't switch to it.

- `$BOARD_URL` is a **public** repo/environment **variable**.
- `$SHIPIT_TOKEN` is the **secret** taught in CI/CD 3 — a ship with no/late token can't report to
  Mission Control (the "unauthorized" lesson). Do NOT accept unauthenticated events in prod mode.
  The POST-to-board step is *added to the workflow in S3*; before that, the learner's payoff is the
  Actions run + the live Pages URL, not the shared board.
- The board keeps an ephemeral roster and broadcasts it to spectators over WebSocket (arena
  pattern). No persistence required beyond the current cohort's session.

## PINNED — learner-facing contract

Frozen — slides quote these verbatim.

- **Config file** learners edit: `ship.config.json` → `{ shipName, color, shipModel, emblem }`.
  - `shipName` non-empty ≤ 24 chars · `color` hex `/^#[0-9a-fA-F]{6}$/` **or** a named-palette colour
    (`red · orange · amber · yellow · lime · green · emerald · teal · cyan · sky · blue · indigo ·
    violet · purple · fuchsia · pink · rose · white · gray/grey · black`), resolved to hex everywhere
    (recolours the ship — sets its hue to `color`; every saturated texel takes that hue, greys/blacks
    stay neutral — and drives the UI accent) · `shipModel` ∈ `fighter · interceptor · hauler · scout` · `emblem` ∈
    `comet · bolt · star · ring · delta · phoenix`. `callsign` is **not** in config — it's the GitHub
    username. On the board it comes from `${{ github.actor }}` in the report step. The site *can*
    display it via `VITE_CALLSIGN` at build, but **the taught workflow never sets it** — the app
    falls back to empty (`launchpad/src/main.js`); don't assume the microsite shows a callsign.
  - The ship is one of four low-poly spaceships (Quaternius, CC0), hue-set by `color`; the site and
    board both render whichever `shipModel` the learner picked.
- **The S2 fitness gate** is a config **validation** check (not a unit test): taught as
  `npm run test` (in `launchpad/`, via the workflow's `defaults.run.working-directory`) →
  `node scripts/preflight.mjs` validates `ship.config.json` and **exits non-zero (ABORT)** on a bad
  config (unparseable, bad hex, unknown emblem, over-long name). Teaches the *exit-code gate* (a
  DevOps skill), not test authoring (a developer skill).
- **The slides are the source of truth for the workflow** — learners build `deploy.yaml` from the
  building blocks on the slides, nothing else. The authored answer keys (`starter/workflows/`) were
  retired 2026-07-17: learners shipped a simpler file than they prescribed, and the extra plumbing
  (config extraction, pad/abort beats) never earned its place *in the learner's workflow* — it now
  lives in the prop's `launchpad/scripts/report.sh` instead, behind a two-line `env:` mapping that
  doubles as the secrets/vars demo surface. A session's reference state is *derived* by running its
  amali on a test fork (see Distribution).

**Taught workflow — end of S3.** Snapshot derived from the delivered decks 2026-07-17, NOT a spec —
regenerate from the slides if in doubt. Filename is `.github/workflows/deploy.yaml` (set in CI/CD 1:
`.yaml`, not `.yml`); `permissions` sits at the bottom because that's where CI/CD 1 adds it; S1's
`workflow_dispatch` was dropped when S3 rewrote `on:`:

```yaml
name: deploy
on:
  push:
    branches: [main]
  pull_request:

defaults:
  run:
    working-directory: launchpad

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
      - run: npm clean-install
      - run: npm run test

  deploy:
    needs: test
    if: github.event_name == 'push'
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
      - run: npm clean-install
      - run: npm run build
      - uses: actions/upload-pages-artifact@v5
        with:
          path: launchpad/dist
      - uses: actions/deploy-pages@v5
      - name: Lapor ke papan
        run: bash scripts/report.sh
        env:
          BOARD_URL: ${{ vars.BOARD_URL }}
          SHIPIT_TOKEN: ${{ secrets.SHIPIT_TOKEN }}

permissions:
  pages: write
  id-token: write
```

No `contents: read` — checkout still works because learner forks are public. The deploy job binds
`environment: production` (a learner-created environment with Required reviewers), NOT the
conventional `github-pages` environment. S4 extends this file; it must not restructure it.
- **Per-session commands** (kelas-taip-bersama): fork → author `deploy.yml` step-by-step per session →
  `git push` → watch. Full list in the spec §7.
- **Slides drift note:** the bootcamp slides repo (`~/repo/slides-devops-bootcamp`) quotes the two
  PINNED contracts above verbatim — it is a separate repo and is **not** updated by changes here;
  update it by hand whenever these contracts change.

## PINNED — learner distribution (fork, not template)

- Learners **fork** `Infratify/devops-bootcamp-shipit` (this monorepo) and work in `launchpad/`
  (workflow steps use `working-directory: launchpad`). The payload-only `shipit-launchpad` release
  repo + its build scripts (`scripts/release-launchpad.sh` & co.) were retired 2026-07-17, never used.
- **The learner authors the workflow** — `.github/workflows/deploy.yml` is NOT shipped on `main`;
  they write it from the slide building blocks, and it grows each session. That is the lesson.
- **`cicdN` reference branches** (recovery/diff aid, not a spec): before each session the operator
  follows that session's amali verbatim on a test fork — proving the slides run green — and pushes
  the resulting state as branch `cicdN` on `Infratify/devops-bootcamp-shipit`.
- **CI/CD 3 operator dep:** push `launchpad/scripts/report.sh` to upstream `main` before class
  (new file — sync-fork safe); learners fetch it with `gh repo sync` + `git pull` at the start of
  Amali 2 — the first live use of the fork model's "sync for instructor fixes" promise.
- **Discipline rule (load-bearing):** upstream `main` must never gain `.github/workflows/` or
  re-touch `launchpad/ship.config.json`, so learner **sync-fork** stays conflict-free.

## Conventions

- Node 20, ESM. Fail loud. No CDN (vendor/bundle). Theme-aware. WebGL + reduced-motion fallbacks.
- **One test only: the config-validation pre-flight gate** (`npm test` → `node scripts/preflight.mjs`,
  exit-code = ABORT). Dev-time unit tests use Node's built-in `node --test`. **No `vitest`, no Playwright.**
- Multi-arch (`amd64`/`arm64`) GHCR publish for `shipit-board` on a `v*` tag; image public before class.
- `launchpad` stays beginner-simple; `board` carries the Three.js spectacle.

## Bootcamp integration (context; the arc itself lives in the slides repo)

`~/repo/slides-devops-bootcamp` → `outlines/2026/ci-cd1..4.md` + `slides/2026/ci-cd1..4/`. The
`$SHIPIT_TOKEN` is the CI/CD 3 secret; the **S4 deploy has the learner's pipeline build the `board`
image, push it to their GHCR, and deploy it to their own EC2 (from AWS 2) via SSM** — with a
rollback demo (redeploy the previous tag) as stretch. The instructor's shared board runs on
instructor infra.
