# Review request: two pull requests I wrote, one section each

Both PRs are mine (the same agent that wrote them is asking for this review), so treat them as work
from a contributor you do not trust. **Your job is the review; I will do the fixing. Do not write code.**

## Where the code is

Run everything from this worktree. `git fetch origin` has already been done.

- **#131** — `fix/ui-inspector-and-tutor-popover`, checked out here as the working tree and `HEAD`.
  Diff: `git diff origin/main...HEAD` (one commit, `0f86db6`).
- **#132** — `fix/insights-count-witnessed-time`, present as `origin/fix/insights-count-witnessed-time`
  (one commit, `301bda2`). Its files are **not** in this working tree, so read them with
  `git show origin/fix/insights-count-witnessed-time:<path>` and
  `git diff origin/main...origin/fix/insights-count-witnessed-time`.

Both PRs passed their required checks (9/9) and GitHub reports `MERGEABLE/CLEAN`, so "the tests pass" is
not the question. Whether the change is _right_ is the question.

## Context you should assume

- `apps/desktop` tests run in a **node** environment with no TestBed, so renderer decisions live in pure
  `apps/desktop/src/app/core/*.ts` modules to be falsifiable without a window. `docs/architecture.md`
  states "**no domain package ever produces a sentence**".
- `docs/wiki/` is a fact ledger: a status claim needs a commit/PR/CI link. `docs/wiki/delivery-roadmap.md`
  makes "Context Inspector 与 Outbound Request Inspector 都存在" an acceptance criterion for AG1.
- The app is Electron + Angular 20 (standalone, zoneless, signals). Sessions are rows in
  `learning_sessions`; `ended_at IS NULL` means open, and **nothing ever closes one** — the app has no
  abandonment rule and does not close a session on exit.

### What #131 claims to do

1. The tutor panel (`tutor-panel.component.ts`, `styles.css`) was pinned below its button with
   `top: calc(100% + 8px)`. On the focus screen the button sits near the bottom edge, so the panel hung
   off the window. It now measures and flips above when it does not fit below, via the pure rule in
   `core/panel-placement.ts`.
2. The developer context/outbound inspector (`agent-context-panel.component.ts`) is no longer rendered on
   `/dashboard`, via `core/inspector-visibility.ts`. It is kept on every other route.
3. One golden-path test changed mechanism: it used to click the step title to move focus off the panel;
   opening above puts the panel over that title, so it now blurs the textarea instead.

### What #132 claims to do

`buildStateTimeline` in `packages/agent-core/src/insights.ts` charged every silence between two events as
`DISTRACTED`, and bounded an open session at `now`. Between them, a quiet hour of reading read as "away"
and a session left open for four days added four days of 离开中. The change: a state the app measured
(`DISTRACTED` from a real `TAB_LEFT`/idle report) keeps the whole stretch; silence is credited to the
running state for at most `idleThresholdMs` and **not counted past that**; so `totalMs` is "time the app
can stand behind" rather than the session's wall-clock. Three tests that stated the old rule were
rewritten, one was added, and `docs/wiki/project-features.md` §D2 was updated to say so.

## For each PR report

1. Does it do what it claims, and nothing it does not claim?
2. **Blocking defects** — correctness, data loss, a contract violation, a test that cannot fail, a claim
   the code does not deliver.
3. **Minor findings** — naming, wording, missed edge case, missing test.
4. One verdict line: **mergeable as-is / mergeable after fixes / needs rework**.

## The questions I want firm answers to

**#131**

- Does the placement rule actually hold at the edges — exact fit, nothing fits either way, `panelHeight`
  of 0 (not yet measured), an anchor above/below the viewport? Can the panel still end up off-screen or
  invisible in any window height?
- Is the measuring wired correctly: `effect` + `ResizeObserver` + a `window` resize listener, in a zoneless
  component? Any leak, any missed re-measure (content growth, window resize), any write-in-effect loop?
- Is the route predicate right — `/dashboard`, `/dashboard?x=1`, `/dashboard#x`, `/dashboard/child`,
  `/dashboards`? Any route where the inspector should appear and now does not, or vice versa?
- **Did I weaken the golden-path assertion?** It should still fail if Escape from _outside_ the panel
  closes it. If moving focus by blurring makes the test vacuous, say so.
- Is hiding the inspector on one route consistent with the roadmap criterion quoted above, or does it
  falsify it?

**#132**

- Is the new rule internally consistent? Does anything _still_ fabricate an absence, and is a real
  absence still fully visible?
- Do the summary invariants still hold (`stateShares`/`courseShares` sum to 1, durations sum to `totalMs`,
  `daily` sums to `totalMs`, `activeDays`/`dailyAverageMs` consistent)?
- **Are the three rewritten tests still meaningful**, or were they bent to fit the new code? Does the
  midnight-split test still test the split?
- The trade-off, stated plainly: a genuine two-hour stretch of work with no events now counts as **two
  minutes**. Is "count only what was witnessed" the right resolution for a dashboard, or does it
  systematically understate real study time in a way that is its own kind of lie? If you think the better
  fix was elsewhere (for example ending abandoned sessions, or applying the engine's own time-based
  transition in the replay), say so — I would rather hear it now.
- Does any other test, wiki page, or consumer still assume `totalMs` is session duration? Check
  `buildStateTimeline`'s other callers and anything reading `InsightsSummary`.
- Are the dashboard labels (总时长 / 日均 / 专注占比 / 每日活动) still honest under the new meaning, or do
  they now promise something the number no longer is?

Report per PR, with `file:line` for every finding, blocking vs minor, and mark anything you could not
establish as NOT VERIFIED. I will fix what you find and re-run this review before merging.
