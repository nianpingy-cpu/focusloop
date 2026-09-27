claude.exe : [claude-code:unrecognized_model] {"model":"deepseek-v4-pro[1m]","q
uery_source":"sdk"}
所在位置 行:1 字符: 253

- ... xe'; $out = & $claude -p "Read .pr-review/brief.md and carry out the ...
-                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  - CategoryInfo : NotSpecified: ([claude-code:un..._source":"sdk"}
    :String) [], RemoteException
  - FullyQualifiedErrorId : NativeCommandError

I have what I need. Here is the review.

---

# Review

Method: read-only. I read both diffs and the surrounding code, traced every test fixture through the new logic, and checked the CSS/DOM stack the placement math depends on. **I did not execute either suite** (the brief says they pass, and #132's code is not in this tree), so every "it passes" below is traced from source, not observed.

---

## PR #131 鈥?`fix/ui-inspector-and-tutor-popover`

### 1. Does it do what it claims?

Yes, and the three claims match the diff. Two things worth naming as _scope_, not defects: the stylesheet also gains `max-height: min(60vh, 420px); overflow-y: auto` (`apps/desktop/src/styles.css:1262-1263`) 鈥?claimed in the CSS comment and load-bearing for the rule (see below); and `[attr.data-placement]` (`tutor-panel.component.ts:53`) is a second encoding of `placement()` that **nothing reads** 鈥?no e2e, no unit test, no CSS selector (grepped `apps/desktop-e2e` and `styles.css`).

### 2. The placement rule at the edges

The rule (`core/panel-placement.ts:32-51`) is right where it matters, and the geometry is sound for a reason worth recording: `.content` is the scroll container (`styles.css:471-478`, `overflow-y: auto`) and `.shell` is `height: 100vh` with `html, body { margin: 0 }` (`styles.css:106-109, 174-179`), so its clip region is exactly `0 鈫?window.innerHeight`. Viewport coordinates and `window.innerHeight` are therefore the correct frame, and `'above'` is only returned when `anchor.top - gap >= panelHeight`, i.e. panel top 鈮?0 鈥?inside both the viewport and the scrollport. No off-screen case from the vertical axis, given the cap.

- **Exact fit** 鈥?`below >= panelHeight` 鈫?`'below'`, and at equality the panel's bottom edge lands exactly on `viewportHeight`. Correct.
- **Nothing fits either way** 鈥?roomier side (`:50`), and the "it will be cut off somewhere" note (`:44-49`) is honest. The `max-height: 60vh` cap is what keeps this rare: with the panel 鈮?0vh, "neither fits" needs the anchor between ~40vh and ~60vh. When it does happen the panel's overflow is `auto`, so what's cut is _its own_ top/bottom edge, clipped by `.content` and **not reachable by scrolling the panel** 鈥?the mode buttons are simply gone. Worth knowing; I'd accept it.
- **`panelHeight === 0`** 鈥?**minor, doc contradicts code.** The comment at `:46-48` says this case "is `panelHeight === 0`, which the first test sends below", and the spec is named "opens below when the panel has not been measured yet" (`panel-placement.spec.ts:40-43`). But the code only reaches the roomier-side branch when `below >= 0` fails; with the panel unmeasured and an anchor **below** the viewport bottom, it returns `'above'` (`above >= 0` is true whenever `anchor.top >= gap`). Unreachable in practice 鈥?`getBoundingClientRect()` forces layout, so the first measure is never 0 鈥?but the doc claims a universal the code doesn't have. Either special-case `panelHeight <= 0 鈫?'below'` or soften the comment.
- **Anchor off-screen** 鈥?above (`top < 0`): `below` is large 鈫?`'below'`. Below (`bottom > vh`): `below < 0` 鈫?`'above'`. Both sane, no NaN path.
- **Horizontal** 鈥?unchanged and out of scope: `right: 0` on a 360px panel anchored to a control near the row's end can still extend past the _left_ edge in a narrow window. Pre-existing; the PR claims only the vertical axis, correctly.

### 3. Is the measuring wired correctly?

Mostly yes. The effect + `ResizeObserver` + `window` resize combination is leak-free and loop-free:

- The effect reads `this.panel()` and `onCleanup` disconnects the observer on every re-run and on destroy (`tutor-panel.component.ts:228-241`); the window listener is added once and removed in `ngOnDestroy` (`:243, 246-248`). No leak.
- No write-in-effect loop: the effect never _reads_ `placementState`; the class toggle changes `top`/`bottom`, and neither affects the panel's measured height, so no `ResizeObserver` re-notification. `panelHeight === 0` is not a "couldn't measure" sentinel, so there's no hysteresis on height.
- The explicit `this.place()` at `:236` (rather than relying only on RO's first callback) is deliberate and right: it sets the placement during CD, before paint, so there's no visible flash of a below-positioned panel. Note it does force a synchronous layout inside CD, and the RO callback forces another; that's the price of measuring, not a defect.

**Missed re-measure 鈥?minor, but it is the exact failure the PR exists to fix.** The placement is only recomputed on (a) window resize, (b) the panel's own size changing, (c) open/reopen. Anything that moves the anchor _within the scrolled content_ leaves it stale, and the panel is `position: absolute` inside `.tutor`, so it moves with the anchor 鈥?it goes off the window again. Concrete repro on `/focus`: the tutor is the last item of `.focus-controls` (`focus.page.ts:261`), the same wrapping flex row as the stuck control; opening the reason chooser (`.stuck-reasons`, `focus.page.ts:203-235`, which "takes a line to itself" per `styles.css:1996-2003`) pushes the tutor button down a row while the panel is open. Scrolling is _not_ a problem (panel and anchor move together), and neither is `visible()` flipping, since the whole component is created per task. An `RO` on the anchor wouldn't catch it either (translation, not resize) 鈥?re-placing from a layout signal or on the control row's mutation is what's needed.

### 4. The route predicate

`isDashboardRoute` (`core/inspector-visibility.ts:21-24`) answers all five cases correctly: `/dashboard` 鈫?hidden; `/dashboard?x=1` and `/dashboard#x` 鈫?hidden; `/dashboard/child` 鈫?hidden (no such route exists; `app.routes.ts` sends unknown paths to `/home`); `/dashboards` and `/dashboard-roundup` 鈫?shown. The `**` wildcard means `/dashboards` never actually persists, so the test is guarding a state the app can't be in 鈥?harmless, and the segment logic is the right call anyway.

- **Nit:** matrix params (`/dashboard;x=1`) are not covered by `['/', '?', '#']` and would show the inspector on the dashboard. Nothing navigates that way today.
- **Wiring is sound but untested.** `currentUrl` (`app.component.ts:268`) is set only on `NavigationEnd` (`:369`). The constructor-vs-subscribe race is safe: every route is `loadComponent` (lazy, async), so the initial navigation cannot complete between the constructor and `ngOnInit`. Before that NavigationEnd lands, `router.url` is `'/'` and the inspector renders for the duration of the lazy chunk load on a cold start at `/dashboard` 鈥?cosmetic. No unit test covers the wiring; `inspector-visibility.spec.ts` covers only the pure predicate, and there is no e2e that visits `/dashboard` and asserts the inspector is gone (grepped: the inspector assertions in `golden-path.spec.ts:1043-1050` are on `/focus`).

### 5. Did I weaken the golden-path assertion?

**No, and it isn't vacuous.** After `blur()` (`golden-path.spec.ts:1072`) focus is on `document.body`; Escape dispatched to body has no path to the `(keydown.escape)` binding on the panel section, so the panel stays up. If the implementation ever grew a document-level listener (the thing the comment on `onEscape` says it must not rely on), Escape from outside _would_ close it and `toBeVisible` at `:1074` would fail. The positive half is still asserted at `:1063-1064` (Escape from inside closes it). The mechanism change is also justified: a click aimed at `task-title` would land on the raised panel, so Playwright would fail on intercepted pointer events rather than on the thing being tested.

One residual softness: `blur()` is a no-op if focus isn't in the textarea. Today the open-effect guarantees it (`tutor-panel.component.ts:218-220`) and the intervening `await expect(...toBeVisible())` at `:1066` gives CD time to run 鈥?but if that effect were ever removed, the test would silently stop exercising "focus was outside the panel" (it would still catch a document-level listener, so it wouldn't become vacuous, just weaker).

### 6. Does hiding it on one route falsify the AG1 criterion?

**No.** `delivery-roadmap.md:74` requires that **both Inspector views exist and each is traceable from the other**; the component still exists and still renders on `/`, `/home`, `/course/:id`, `/focus`, and `@if` is inside the shell, not inside the component 鈥?`agent-context-panel.component.ts:28` gates it on `simulatorEnabled`, so this is a **developer-only surface** and no learner loses anything (`project-features.md:410-435` still describes it truthfully). Two caveats:

- **Minor:** the change is not recorded in the ledger. A UI-visibility decision that touches an acceptance criterion should appear in `project-features.md` 搂E7 / 搂F1, or in `delivery-roadmap.md`; nothing in the wiki says "except on the dashboard".
- **Minor, wording:** the rationale at `app.component.ts:245-249` ("a screen you are _reading_") doesn't single out the dashboard. `/home` and `/course/:id` are equally reading screens, and the fixed bottom-left overlay also covers the sidebar's 浠婃棩 card on every route. The decision is defensible 鈥?the dashboard is where those totals are read 鈥?but the comment argues a general principle it doesn't apply generally. Say "the dashboard" rather than "a reading screen".

### Verdict #131: **mergeable after fixes**

No blocking defect. Fixes I'd ask for: (a) a test that the flip actually happens in the app 鈥?today `data-placement` is written and unread, and every suite passes whether the component measures correctly, measures the wrong element, or never calls `place()` at all; (b) the stale re-measure on control-row reflow; (c) the `panelHeight === 0` comment/code mismatch; (d) either use `data-placement` or drop it.

---

## PR #132 鈥?`fix/insights-count-witnessed-time`

### 1. Does it do what it claims?

Almost. The mechanism matches the description exactly: `credit` now caps every non-`DISTRACTED` stretch at `idleThresholdMs` and **drops the overflow** instead of charging it (`insights.ts:115-120` on the branch), while `DISTRACTED` keeps its whole stretch. Three tests rewritten, one added, `project-features.md` 搂D2 updated 鈥?all as described. I verified by reading the reducer that nothing _else_ can produce `DISTRACTED`: it arrives only from `TAB_LEFT` (`state-machine.ts:214`) and `IDLE_STARTED` (`:235`), both of which come from the tracker's real signals (`apps/extension/src/tracker.ts:55,62,81`) or the simulator (`engine.ts:1313`). And `evaluateTimeBasedState` moves a _reported_ absence to `INTERRUPTED` (`state-machine.ts:300-327`), never invents `DISTRACTED` from silence. So the "nothing fabricates an absence" claim holds for the _middle_ of a session.

**It does not hold at the tail 鈥?this is my main blocking finding.** See below.

### 2. Blocking

**B1. The stale contract, twice, including inside the file that changed.** Both still state the old rule verbatim:

- `packages/agent-core/src/insights.ts:9-13` (unchanged by this PR): "at most `idleThresholdMs` of a silent stretch is credited to the state it was in, **and the overflow is attributed to `DISTRACTED`**." That sentence describes code that no longer exists, in the module header of the module that changed.
- `docs/architecture.md:227-231` (untouched): the same rule, plus "**the consequence is that a window's `totalMs` equals the time its sessions were open**" 鈥?now false by an order of magnitude. Its own 搂"Insights" heading is the doc a reader lands on for exactly this question.

In a repo whose docs are the contract (and where the brief quotes `architecture.md` at you), a diff that changes the semantics of `totalMs` and updates only the wiki leaves two authoritative documents lying. This has to be in the same change.

**B2. The open-session tail is still unbounded, so the headline example is only half-fixed.** `credit` special-cases `DISTRACTED` to keep the whole stretch (`insights.ts:118`), and the final `credit(engineState.state, cursor, limitMs)` (`insights.ts:120` in the tree / branch equivalent) runs to `limitMs = now` for a session nobody ever closed. So:

- Last event `TASK_STARTED`/`TASK_COMPLETED`/`SESSION_STARTED` 鈫?tail state `READY`/`FOCUSED` 鈫?capped at 2 min. **Fixed** (the "sixteen hours overnight" case).
- Last event `TAB_LEFT` or `IDLE_STARTED` 鈫?tail state `DISTRACTED` 鈫?**charged to `now`, in full**. Open the app four days later and those four days of 绂诲紑涓?are still counted, and the total keeps growing while the app is open. That is the exact sentence this PR's own `credit` doc comment claims to have fixed (`insights.ts:107-111` on the branch: "a session left open overnight put sixteen hours of 绂诲紑涓?into the day").

This is not exotic: the app "has no abandonment rule and does not close a session on exit", and both the simulator's distraction button (`engine.ts:1313`) and the extension's tab-switch/window-blur (`tracker.ts:55,62`) leave `TAB_LEFT` last.

The internal inconsistency is the real argument: **the rule is not applied uniformly.** The code will credit at most one idle threshold of _inferred_ focus after the last event, but will charge an unbounded stretch of _inferred_ absence after the last event 鈥?even though the engine itself does not treat absence as persistent (`evaluateTimeBasedState` retires `DISTRACTED` after `tabLeftThresholdMs`). Under "count only what was witnessed", a four-day `DISTRACTED` stretch for one `TAB_LEFT` is exactly as unwitnessed as a four-day `FOCUSED` stretch. There is no test for this case. (Note the fix is _not_ "run `evaluateTimeBasedState` in the replay" 鈥?that would cap the _measured_ absence at ~2 min and break the good test you just added at `insights.spec.ts:114`. Bound the open **tail** only 鈥?`last event + threshold` 鈥?or end abandoned sessions, which is the root cause the brief names.)

### 3. Minor

- **M1. `insights.spec.ts:263-285` (midnight split) is now fragile, though still meaningful.** It still tests the split: an event-free session with a 2-minute credit straddling midnight yields >0 on both days and sums to `totalMs`. But the stretch now _exists only because_ `idleThresholdMs` is 120s; drop the threshold below 60s and the test fails with a message about the split, when nothing about the split broke. The old fixture had a 2-hour stretch and didn't depend on the threshold. Put an event on each side of midnight (`TASK_STARTED` at 23:59, `TASK_COMPLETED` at 00:01) so the split is driven by events.
- **M2. `packages/agent-core/src/engine.spec.ts:117` still reads like it asserts session duration** 鈥?`expect(summary.totalMs).toBe(30_000)` for a 30-second session. It passes only because 30s < the 120s threshold, so it can no longer distinguish "session duration" from "witnessed time"; a 3-minute fixture would return 120_000. Not wrong, but it's the one engine-level consumer that _looks_ like it pins the old meaning.
- **M3. The justification for the number 2 minutes is imprecise** (`insights.ts:104-105` on the branch): "the same bound the engine itself puts on 'still focused' when it evaluates a state by time alone". The engine's time-based rule measures from `idleSince`/`awaySince` 鈥?set by an _explicit_ report 鈥?not from the last event; without an idle report the engine keeps a silent learner `FOCUSED` indefinitely. So this is a new heuristic that borrows the engine's constant, not the same rule. Fine as a product decision; say it that way.
- **M4. Labels now promise what the numbers no longer are.** Concretely, a genuine two-hour stretch of work with events at the start and end reads as **4 minutes**:
  - `dashboard.hero.total` = 鎬绘椂闀?/ "Total time" (`messages.zh.ts:178`, `dashboard.page.ts:92`) 鈥?now witnessed time, not total time. Nothing in the UI says so; only `project-features.md` 搂D2 搂5 does.
  - `dashboard.hero.daily` = 鏃ュ潎 (`:179`, `dashboard.page.ts:98`) 鈥?same, and `activeDays` counts any day with a single event, so the average is dragged down by days that barely register.
  - `dashboard.focusRatio` = 涓撴敞鍗犳瘮 (`:182`, `dashboard.page.ts:143`) 鈥?the denominator changed meaning, so this converges on ~100%: `DISTRACTED` is only counted when a departure was witnessed. The helper's own doc still says "Share of a **window** spent on task" (`apps/desktop/src/app/core/insights-view.ts:101`). The number stops discriminating.
  - `dashboard.activity.hint` = 銆岄鑹茶秺娣憋紝褰撳ぉ瀛︿範瓒婁箙銆傘€? "Darker means more time that day" (`messages.zh.ts:185-186`) 鈥?the heatmap now encodes **event density**, not study time. This is the worst of the four because the hint makes the promise in words: a heavy day with four events renders nearly blank.
  - `app.today` / `app.today.empty` (`messages.zh.ts:31-32`, `app.component.ts:504-508`) 鈥?the same shift in the **sidebar, on every screen**; a day whose only time was the 2-minute tail after yesterday's event shows "鈥? and "浠婂ぉ杩樻病鏈夎褰曘€?
  - `project-features.md` 搂D1 搂2 ("鏌ョ湅 Session 鏃堕暱", unchanged) is stale for the same reason 搂D2 was updated.
- **M5. `awayMs` is ignored.** The measured absence duration the resume policy trusts (`TAB_RETURNED.payload.awayMs`, `IDLE_ENDED.payload.idleMs`) is not used by the timeline, which derives the stretch from event timestamps instead (`insights.spec.ts:114-131` sets `awayMs: 60 * 60_000` but the assertion only depends on the timestamps). If events are batched or delayed, the counted absence drifts from the measured one. Worth a sentence either way.

### 4. The invariants

All hold, by construction, and the spec pins the important ones (`insights.spec.ts:210-217`):

- `stateShares` sum to 1 and durations sum to `totalMs` 鈥?`stateMs` and `totalMs` accumulate the identical `span` (`insights.ts:263-265` in the tree), so the identity is exact, and `share = durationMs / totalMs`. The `durationMs > 0` filter can't break it (`totalMs === 0` 鈬?no shares).
- `courseShares` sum to 1 鈥?same accumulation.
- `daily` sums to `totalMs` 鈥?`splitByLocalDay` sums to each segment's span and the enumerated days cover the window. (Pre-existing and unrelated to this change: the day walk adds `86_400_000` to local midnight, so a DST transition inside the window can drift the walk and drop or duplicate a day. Not made worse here, but note that this PR's shortening of stretches means the midnight split is no longer exercised by long stretches 鈥?see M1.)
- `activeDays` / `dailyAverageMs` / `maxDailyMs` remain mutually consistent.

New consequence worth knowing (not a defect): a window can now have `sessionCount > 0` and `tasksCompleted > 0` with `totalMs === 0`, in which case the donut renders "杩欎釜鍖洪棿杩樻病鏈夎褰曘€? next to a non-zero task count. Reachable only if a session is closed at exactly its last event's timestamp.

### 5. The trade-off 鈥?is "count only what was witnessed" right for a dashboard?

The **direction is right and I would not revert it**: "99.6% 绂诲紑涓? for a quiet hour of reading is a fabricated fact about the learner, and the fix removes it. But **as a resolution it conflates two questions and answers the wrong one.** "How long did I study" and "what state was I in" are different; the session window is a boundary the _learner_ stated by pressing Start and Stop, so session duration is something the app can stand behind, while state attribution during unwitnessed time is not. This change fixes the state fabrication by discarding the duration 鈥?and it does so silently: the number shrinks by roughly 2 minutes per event, which is _plausible_, so nobody will notice it's wrong. The old bug was loud; this one looks like data. For a fact ledger that is the worse failure mode.

Ranked, what I'd do instead:

1. **Fix the root cause the brief names** 鈥?an open session's `now` bound is what makes absence unbounded. Bound an open session's tail at `max(lastEventAt, startedAt) + threshold` and/or give sessions an abandonment rule. That alone kills the four-day 绂诲紑涓?without discarding study time.
2. **If duration must stay session-scoped, make the state bucket explicit** 鈥?keep `totalMs` = session time and introduce an unattributed/`UNWITNESSED` bucket for silence. The ring then shows "here is your hour, and here is the part the app cannot describe" instead of shrinking the hour. That is honest in both directions and keeps 姣忔棩娲诲姩 meaningful.
3. **If you keep "witnessed time" as the definition** (defensible), then the labels must move with it: 鎬绘椂闀?鈫?something like 鏈夎褰曟椂闀? the 姣忔棩娲诲姩 hint must stop promising study duration, 涓撴敞鍗犳瘮's meaning must be documented next to the number, and 搂D1 must be updated. Right now only 搂D2 knows, and 搂D2's own 搂7 "宸茬煡闄愬埗" doesn't mention that 鎬绘椂闀?is no longer the session's duration.

Applying the engine's time-based transition in the replay, which the brief floats: I'd argue against it. It retires a witnessed `DISTRACTED` to `INTERRUPTED` after 20s, and `INTERRUPTED` would then be capped at 2 minutes 鈥?a real one-hour absence would report as ~2 minutes, breaking the "a real absence stays fully visible" property this PR rightly added a test for. Bound the tail; don't re-time the middle.

### Verdict #132: **mergeable after fixes**

B1 (stale contract in `insights.ts` and `architecture.md`) and B2 (unbounded `DISTRACTED` tail, with no test) are the two I'd hold the merge on; the label question in M4 is the one I'd want an explicit decision recorded for, because the fix is either a copy change or a different implementation.

---

## Not established

- **NOT VERIFIED (by any test): that the tutor panel actually flips above in the app.** `panel-placement.spec.ts` tests the pure rule only; nothing asserts that the component measures the right element, applies the class, or ever calls `place()`. `data-placement` is emitted and read by nothing. My read is that the wiring is correct and that the panel does flip in the 840px Electron window (1280脳840, `electron/window.ts:16-17`) 鈥?the golden-path author's own comment at `golden-path.spec.ts:1068-1070` says so, and the mechanism change only makes sense if it does 鈥?but that is second-hand, and the suite would pass identically if `place()` did nothing.
- **NOT VERIFIED: runtime behaviour of either suite.** I traced the fixtures (the 4-minute `totalMs`, the 2-minute first segment, the midnight split at 1 minute per side) rather than executing them; and #132's code is not in this worktree, so I reviewed it via `git show`.
- **NOT VERIFIED: whether `/home` and `/course/:id` are covered by the same inspector-over-content complaint** that motivated hiding it on `/dashboard`. I didn't try to reproduce the overlap 鈥?flagging it as a question about the rationale, not as a defect.
