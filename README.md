# devops-bootcamp-shipit

**"Ship It: Mission Control"** — a live CI/CD teaching prop for the 2026 DevOps bootcamp.

Every learner ships a small personal **ship microsite** through a GitHub Actions pipeline. Each
pipeline stage is a **launch phase**; a fully-green run **launches their ship into a shared orbit**
on the projector. A failed test = **ABORT** — grounded on the pad until fixed. It makes an
invisible pipeline visible, shared, and personal.

Sibling props: `devops-bootcamp-app` (Three.js Docker scrollytelling — the visual bar) and
`devops-bootcamp-game` (PixiJS avatar arena — the shared-live-personal bar). This one is
CI/CD-native.

## Status

**Built and in use.** Learners fork this repo in CI/CD 1 and grow `.github/workflows/deploy.yaml`
one session at a time, from the building blocks on the slides — the workflow file is deliberately
NOT shipped here. `CLAUDE.md` holds the design rationale + the pinned contracts, including a
snapshot of the taught workflow.

## Layout

```
board/       Mission Control — ws hub + Three.js projector spectator → ghcr.io/infratify/shipit-board (:3000)
launchpad/   the learner ship microsite — static Vite + Three.js, ships to GitHub Pages (no image)
```

## The 4-session arc it serves

| Session | Launch phase | Teaches |
|---|---|---|
| CI/CD 1 | Pad live on Pages | first workflow · trigger · job/step/runner · Pages deploy |
| CI/CD 2 | Systems check | test gate (red = ABORT) · `needs` · branch protection |
| CI/CD 3 | First contact + clearance | secret vs variable · report to Mission Control · push/PR trigger split · manual approval |
| CI/CD 4 | LIFTOFF → orbit | pipeline builds the board image → GHCR → deploy to your EC2 |
