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
- Auth-gated or admin screens: use the review harness at `app/review/` — it
  monkeypatches the real Supabase client's `.from()`/`.rpc()`/`.channel()`
  with an in-memory fixture layer (`reviewHarness.js`), sets the app's
  module-level `currentUser`/`currentProfile` directly to a fake admin/user
  object (no real OAuth or Supabase session needed), and exposes
  `window.__review(screenName)` for Playwright to call the matching render
  function and screenshot it. Only imported behind a `VITE_REVIEW`
  env-guarded dynamic import so it's dead-code-eliminated from production
  builds — never guess how an auth-gated screen looks, always capture it
  this way.

**The harness is COMMITTED to the repo. Never re-gitignore it.** It used to
be gitignored; this container wipes untracked files on every recycle, so it
kept vanishing and sessions fell back to guessing. That is exactly how a
long run of "fixed" onboarding bugs shipped broken.

### 4a. Test the user's ACTUAL state, not the easiest state
The single biggest source of false "verified" claims in this repo: testing
as a **guest with one session** when the reporter is a **signed-in chef with
many sessions**. Different code path, different bugs.

Since v2.5.0.0 the onboarding tour is ONE unified step list — identical for
signed-in or guest, owner or not (see `buildOnboardingSteps()` in
`app/src/main.js`). There are no more branch personas to cover; what
differs between chefs is only what `completeOnboardingPurchase()` ends up
writing at the real "Yes, unlock it" tap (nothing is written anywhere
before that — abandon the tour and nothing was granted or forfeited).
Three fixture presets cover those write shapes, and **every onboarding
change must pass all three end-to-end before shipping**:
- `guest` — brand-new guest, not signed in, empty log, owns nothing
  (`guestWavingFree` false). Completes the purchase as a purely local write
  (`state.ownedEmotes`/`coinAdjustment`/`onboardingCoinClaimed`).
- `fresh-signup` — brand-new signed-in signup, 0 pizzas, owns nothing,
  `waving_free` false (the real column default post-migration). Exercises
  `complete_onboarding_purchase()`'s real coin-grant branch.
- `owner-many-sessions` — the admin's real account shape: Lv 10, already
  owns waving, ~7 sessions dated today so the day sheet has many rows.
  Exercises the RPC's no-coin/no-array-change branch — the shop still
  shows Waving Locked/buyable for them (render-time illusion only), but
  the real purchase is a no-op besides the claimed flag.

Drive the full flow with `node app/review/tour.mjs <preset>` and read the
per-step log + screenshots. If a report is about a signed-in user, a guest
run is not evidence.

### 4b. Never trust a worker's report as verification
A worker saying "build passes, fixed" is not verification. Builds pass on
broken behaviour constantly here. Opus re-runs the harness and looks at the
screenshots/measurements itself before telling the user anything is fixed.
Multiple regressions have shipped because a green build was reported as a
green outcome.

### 4c. Measure, don't eyeball
Where a defect is geometric or behavioural, assert it numerically in the
Playwright run rather than squinting at a screenshot:
- ring alignment → compare `getBoundingClientRect()` of ring vs target and
  assert the pad is equal on all four sides
- "this button is still clickable" → `document.elementFromPoint(cx, cy)` and
  check what actually receives the tap
- "the tour died" → assert `#tour-root` still exists and log the active step
- Playwright's `click({force:true})` bypasses the tour's blocker layer and
  produces false passes. Use `page.evaluate(s => document.querySelector(s)
  .click(), sel)` to simulate a real tap.

### 4d. State plainly what was NOT verified
The harness is headless Chromium with faked Supabase. It cannot verify:
real Supabase/RLS/RPC behaviour, **iOS Safari specifics** (soft-keyboard
viewport split, status bar, safe areas), H.264 video, or real touch
gestures. Every report must say which fixes are harness-verified and which
still need the user's device — never let an unverifiable fix sit inside a
list of verified ones.

### 4e. Device-reported bugs: WebKit-first, repro-first, no blind fixes
Learned the hard way (soundtrack mini-player, Aug 2026): a bug the user
screenshots on their iPhone was "fixed" and re-"fixed" against headless
Chromium, shipped as verified, and was never actually fixed — the failing
mechanism (a MutationObserver-driven CSS class) **raced only on Safari**.
Chromium-green means nothing for a device-reported bug. The rules:
1. **Reproduce the bug FIRST** (red), in Playwright **WebKit** with iPhone
   emulation (`devices['iPhone 13']`) — WebKit is Safari's engine and does
   catch engine-divergent behaviour Chromium hides. Install if missing
   (container recycles wipe it):
   `npx playwright install webkit && npx playwright install-deps webkit`
   (binaries land in /opt/pw-browsers, e.g. webkit-2336).
2. **No fix ships without a red repro** or on-device measurements that
   pinpoint the defect. If it won't reproduce in WebKit either, do NOT
   ship a guess — ship an opt-in diagnostic instead (the `?tourdebug=1`
   pattern: an overlay that prints live rects/env values on screen) and ask
   the user for ONE debug screenshot; fix from that data.
3. A fix for a device-reported bug passes only when the SAME assertions go
   green in **both** engines (Chromium + WebKit-iPhone).
4. Prefer removing the fragile mechanism over patching it: races
   (observer-toggled classes, timing-dependent styles) and guessed
   geometry (hardcoded heights for elements whose size depends on device
   fonts) are bug factories — measure real layout at runtime instead.
5. Never claim "fixed" to the user for iOS-only compositing/viewport/
   keyboard behaviour that even WebKit-headless can't reproduce — say
   exactly what needs their device, per 4d.

## 5. UI/functionality/design QA
Every review pass checks:
- The UI actually works (interactions, states, edge cases).
- The functionality is correct (not just "renders").
- The design meets premium/polished app standards — actively look for
  amateur mistakes: inconsistent spacing, elements not centered/aligned,
  buttons not in the same row when they should be, low-contrast/hard-to-read
  colors, uneven padding, anything that reads as sloppy or unfinished.

## 5a. Root cause first, not the smallest patch
Fix problems fast and directly at the root cause, using the simplest,
most reliable approach — like a senior app designer would, not a string of
incremental patches. Concretely: before shipping a fix, ask whether it
removes the failure mode or just narrows it. If the same class of bug has
been "fixed" more than once (e.g. shell-height under-measuring in iOS
standalone across several viewport units), stop tuning the losing approach
and switch to one that can't fail the same way — e.g. pin chrome with
`position: fixed` off the real viewport instead of trusting a container's
computed height. Prefer the fix that eliminates a whole category of future
bug reports over the one that only resolves the current screenshot.

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

## "Send to Claude" bug-report triage workflow
The in-app admin Bug Reports page (Admin Dashboard → Support → Bug Reports)
has a per-report **Manage → Send to Claude** action. It flags a report for
Claude to read and plan a fix. The plumbing:
- `bug_reports.sent_to_claude_at` marks flagged reports; RPCs
  `flag_bug_report_for_claude` / `unflag_bug_report_for_claude` (admin-gated)
  toggle it. See `supabase/migration_bug_claude.sql`.
- Claude reads the flagged queue with the secret-gated RPC `claude_bug_queue`
  (only returns reports where `sent_to_claude_at is not null`). Fetch it with:
  ```
  curl -s -X POST 'https://jnhshtrfaxpzhonkokwa.supabase.co/rest/v1/rpc/claude_bug_queue' \
    -H 'apikey: <publishable key from app/src/supabaseClient.js>' \
    -H 'Authorization: Bearer <same key>' -H 'Content-Type: application/json' \
    -d '{"token":"a7f3c9e1-4b2d-4e8a-9c6f-1d2e3f4a5b6c"}'
  ```
  Each row has `id`, `description`, `screenshot_url`, `reporter_name`, status.

**Triage rules (how to handle flagged reports):**
1. When the user says **"check reports"**, fetch the queue immediately.
2. For each report: download the `screenshot_url`, read the screenshot +
   description, and post a **concise fix PLAN + clarifying questions**.
   **PLAN ONLY — do NOT write, edit, or deploy code during triage.** Wait for
   the user to answer questions and say "build" / "push" before implementing.
3. Track which report ids you've already triaged; only surface NEW ones.
4. An **hourly Routine** can run this check unattended (fetch queue → plan any
   newly-flagged report → stay silent if nothing new). Set it up with a
   self-binding cron trigger firing into the session when the user wants it.
5. Reports move Open → Resolved (Mark Resolved) / Dismissed via the Manage
   menu; `resolve_bug_report` / `dismiss_bug_report` RPCs back those.

Note: the queue `token` above is a shared secret living only in this private
repo (never in the shipped client bundle) — it gates the otherwise
anon-callable read RPC.
