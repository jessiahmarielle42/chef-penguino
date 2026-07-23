# Chef Penguino — Working Rules

Vanilla-JS + Vite focus-timer web app (a penguin runs a pizzeria; focus
sessions "bake pizzas"). Backend: Supabase (Postgres + RLS + Auth via
Google OAuth). Deployed on Vercel — prod auto-deploys from `main`
(chefpenguino.vercel.app). Supabase ref: `jnhshtrfaxpzhonkokwa`. Admin
email: `keefefons@gmail.com`.

All app logic lives in `app/src/main.js`, styles in `app/src/style.css`.
Build: `cd app && npm run build`.

These rules apply to every session working in this repo. Read them before
starting any task.

## 1. Token/cost discipline
Delegate to Sonnet/Haiku worker agents wherever a task doesn't need Opus-level
judgment (routine implementation, mechanical edits, running builds/tests,
grepping/reading code). Don't burn Opus-tier reasoning on work a cheaper
worker can do correctly.

## 2. Parallelism
Run worker agents in parallel whenever tasks are independent. Don't
serialize work that has no real dependency between steps.

## 3. Planning, delegating, and review = Opus
Planning the approach, deciding how to split work across workers, and the
final review pass are always done at Opus tier — never delegated down.

## 4. Review with real screenshots
Opus reviews using **real screenshots**, not assumptions about how something
looks:
- Guest-visible / non-auth screens: screenshot directly (headless
  Chromium / the review harness).
- Auth-gated or admin screens: use the gitignored review harness at
  `app/review/` — it monkeypatches the real Supabase client's
  `.from()`/`.rpc()`/`.channel()` with an in-memory fixture layer
  (`reviewHarness.js`), sets the app's module-level `currentUser`/
  `currentProfile` directly to a fake admin/user object (no real OAuth or
  Supabase session needed), and exposes `window.__review(screenName)` for
  Playwright to call the matching render function and screenshot it. Only
  imported behind a `VITE_REVIEW` env-guarded dynamic import so it's
  dead-code-eliminated from production builds — never guess how an
  auth-gated screen looks, always capture it this way.

## 5. UI/functionality/design QA
Every review pass checks:
- The UI actually works (interactions, states, edge cases).
- The functionality is correct (not just "renders").
- The design meets premium/polished app standards — actively look for
  amateur mistakes: inconsistent spacing, elements not centered/aligned,
  buttons not in the same row when they should be, low-contrast/hard-to-read
  colors, uneven padding, anything that reads as sloppy or unfinished.

## 6. Anticipate downstream UI gaps
Don't just implement the literal spec — think through where a feature's
effects surface elsewhere in the app, and fix gaps proactively. Example:
if a plan adds an admin action (e.g. "unsend a broadcast") but doesn't say
where the admin actually accesses that control, don't build it half-finished
— identify the gap and add the missing surface/entry point as part of the
same pass, then note it was added.

## 7. Maximize autonomous progress
Don't stall waiting on user input. If genuinely blocked on one thing, keep
working on everything else that doesn't depend on it. Only stop fully when
truly nothing else can proceed without the user's answer. Reasonable
defaults get chosen and flagged in the report, not asked about upfront.

## 8. Fix-in-real-time vs. deploy-on-command
When the user reports errors/bugs live, fix and commit them immediately.
**Never push live** (merge to `main` / push `main`) until the user's message
contains the literal trigger word **"push"** — then push everything queued
at once, in one go.

## 9. SQL migrations
Any new SQL (schema changes, RPCs, RLS, storage buckets) is written as a
`.sql` file in `supabase/` — never run by Claude. Paste the full SQL near
the end of the report so the user can copy-paste it directly into the
Supabase SQL Editor.

## 10. Report format
End every work report with a concise bullet summary of the new features/
changes added to the app.

## Standing deploy flow
1. Develop on the designated feature branch.
2. Commit as work completes (small, clear commits).
3. Hold any SQL-dependent merge until the user confirms they've run the
   migration in Supabase.
4. Only merge `--no-ff` into `main` and push `main` when the user says
   "push" — that's what goes live via Vercel.
