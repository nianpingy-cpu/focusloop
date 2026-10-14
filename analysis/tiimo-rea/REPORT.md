# Tiimo reverse-engineering — findings and what FocusLoop should take

Status: **analysis only.** Nothing here changes product code. Raw REA evidence is not committed; see
[`README.md`](./README.md) for the exact commands and REA's own limitations.

## TL;DR

- Tiimo's production source is **not public**. `github.com/tiimoapp` exists but publishes no
  repositories. Everything public is a clone, a boilerplate starter, or an unofficial client riding
  Tiimo's private API. "Reverse-engineer Tiimo" can therefore only mean **reverse-engineer its public
  behaviour and the public clones**, which is what this report does.
- What the clones show is consistent and specific. Tiimo is **three data models**: tasks (list-based),
  calendar activities (recurring, time-of-day), and **event-sourced completion** (a per-occurrence
  action record, not a mutation of the activity). Around them sit four experience layers: an
  **onboarding questionnaire**, a **schedule/timeline**, a **focus timer**, and a
  **wellbeing/gamification** loop.
- FocusLoop already matches or beats Tiimo in the parts that matter to this product: a real
  state machine, session continuity/resume, an agent/tutor loop, insights, local-first storage, and
  two languages. Tiimo beats FocusLoop in the **planning and motivational layer**: onboarding,
  scheduling/routines, mood/streaks, and reminders.
- **Recommended (fits FocusLoop, low risk):** mood/wellbeing check-in; streak + habit heatmap;
  reminders for a planned block; a short onboarding questionnaire that seeds preferences; a 12h/24h
  clock setting. **Recommended against:** a full calendar/day-planner pivot, gamification with
  confetti/trophies as a primary loop, and anything that depends on Tiimo's private API.

## 1. What was reverse-engineered, and how

Tool: [`morluto/rea`](https://github.com/morluto/rea) (`rea-agents@6.4.0`), static JavaScript
application analysis. It parses JavaScript as **inert text** — no code is executed — and emits an
Evidence bundle with `confidence: derived`, `authority: shipped-artifact`. Import, endpoint and
storage relationships it reports are static relationships, not proof of runtime behaviour; dynamic or
obfuscated paths may be unresolved. Those limits are restated wherever they matter below.

| Target                         | Stack               | REA digest                        |
| ------------------------------ | ------------------- | --------------------------------- |
| `anujgangwar7733-collab/Tiimo` | React + Vite        | `evidence/vite-tiimo-clone.json`  |
| `nwachukwuchukwuka/tiimo`      | Expo / React Native | `evidence/expo-tiimo-clone.json`  |
| `CasperEngl/tiimo-onboarding`  | Next.js             | `evidence/nextjs-onboarding.json` |

`halfdane/flow` (Kotlin, offline Android "tiimo clone") was read by hand; REA's native path needs
Hopper/Ghidra/IDA, which are not installed, and the Kotlin _source_ is not a REA target anyway.

## 2. Tiimo's product model, reconstructed

### 2.1 The data model (from the unofficial API client and the Android clone)

The one public **reverse-engineering of Tiimo's real API**, `ckumar1/tiimo-mcp`, documents:

- **Task lists** (To-do / Work / Travel …) each holding **tasks** (title, notes, icon, duration).
- **Calendar activities** with a `repetition` object (recurrence), read pre-expanded by date.
- **Completion is event-sourced**: `complete_activity` POSTs an _action record_ (`/activityactions`,
  `Completed` / `Reset`) for one occurrence date. It does not mutate the activity.

`halfdane/flow` models the same idea in Room, which is the cleanest statement of the domain:

```
Activity        (id, title, emoji, colour, startMinute, durationMinutes,
                 date?,          // one-off …
                 repeatDays,     // … or recurring by weekday
                 reminderEnabled, notes)
ChecklistItem   (activityId, text, done, position)
ActivityCompletion (activityId, date, completed)   // per-day tick, so a routine is not mutated
Todo            (text, emoji, done, position)
MoodEntry       (date, mood 1..5, note)            // one per day
```

Two ideas here are worth naming because they are easy to get wrong: **a recurring item is ticked per
day, not toggled**, and **a completion is an event, not a field flip**. FocusLoop already takes the
second idea seriously — its event log is the source of truth — but has no recurring items at all.

### 2.2 The feature map (from REA digests)

The Vite clone names its own backend surface, which is the clearest list of what Tiimo's product does
(`evidence/vite-tiimo-clone.json`, static string/route evidence):

```
/auth/{register,login,google,logout,me}
/tasks, /tasks/reorder
/insights/{stats,focus-session}
/gamification/{mood,streak/check,trophies,summary}
/subscription/{demo-upgrade,portal,create-checkout-session}
localStorage: tiimo_auth_user, tiimo_theme, daily_routine_token
```

Its function inventory shows the behaviours behind those routes: `handleScheduleTodoToTimeline`,
`handleStartFocus`, `AiPlannerView::generatePlan` / `handleApplyToTimeline`, `TimelineView`
(`getActivityStatus`, `getTimeSpan`, `parseTimeToMinutes`, `updateTime`, `toggleExpand`),
`FocusTimer` (`handleTogglePlay`, `handleAddFiveMin`, `handleComplete`, `handleReset`),
`HabitHeatmap`, `TrophiesView`, `MoodTracker`, `WellbeingView::handleSaveCheckin`,
`GamificationContext::onTaskCompleted` / `recordMood` / `triggerConfettiCelebration`, and an
`audioEngine` with white/pink noise, ambient sound, click sounds and a completion chime.

Its seed data names the experience: routines ("Morning Routine & Intention", "Evening Winddown"),
trophies ("Focus Champion", "Streak Master", "Early Bird"), wellbeing check-ins, mood entries, and
themes ("Notion Warm Minimal", "Sage Tranquility", …). This is demo data, so treat the _vocabulary_
as evidence of intent, not of shipped behaviour.

### 2.3 The onboarding flow (Expo clone)

`evidence/expo-tiimo-clone.json` lists the whole route tree. The onboarding is a real sequence, not a
single screen:

```
onboarding/questionnaire/{needs,neurodivergent,notifications}
onboarding/{routines-intro,morning-routines,calendar-permission,calendar-select,
            task-review,weekly-plans,commit,processing,paywall,updates-modal}
```

So Tiimo asks **what you need help with**, whether you are **neurodivergent**, and how you want
**notifications**, then builds a starter routine and a weekly plan before showing a paywall. The
Next.js clone (`nextjs-onboarding`) confirms the guided-tour pattern: React Joyride over Home /
Details / Settings, with a persisted "seen" flag.

The rest of the Expo surface: tabs `index` (Today), `to-do`, `focus`, `me`; `home-screens/{all-tasks,
explore,reschedule}`; `knowledge/{courses,course-detail,course-progress,questions,question-detail}`;
`settings/{theme,app-icon,calendar,notifications,reminders,fonts}`; an AI planner
(`PlanAiModal`, `app/ai-chat.tsx`, `ChatHistorySidebar`); and a full add-task flow
(`DatePicker`, `TimeOfDaySelector`, `DurationPicker`, `ColorPickerSheet`, `Tag*`, `SubtaskList`,
`ChooseVisualsModal`).

## 3. What FocusLoop already does as well or better

- **A real state engine.** The clones have nothing like FocusLoop's `learning-state` reducer,
  eight states, or time-based escalation. Tiimo's clones track tasks and a streak; they do not model
  _where a learner is cognitively_.
- **Session continuity.** Checkpoints, the resume card, resume-latency and re-engagement metrics are
  FocusLoop's differentiator and have no counterpart in the clones.
- **Agent/tutor loop.** `PlanAiModal` and `ai-chat` show Tiimo uses AI for _planning a day_; FocusLoop
  uses a model for _answering a step_ and _suggesting a rescue_, grounded in the learner's own
  material, with an offline fallback. Different and arguably harder.
- **Insights.** FocusLoop's donut/heatmap/focus-ratio/course split plus resume outcomes is broader
  than the clones' `insights/stats`.
- **Local-first, no account.** All clones carry auth and, in one case, a subscription paywall.
  FocusLoop ships with neither, which is a feature.
- **Bilingual.** Not present in any clone.

## 4. Gap analysis

| Tiimo/Flow has                                        | FocusLoop today                      | Verdict                                                                                                    |
| ----------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Onboarding questionnaire that seeds preferences       | A static "getting started" block     | **Adopt (small):** a short questionnaire that seeds real settings (idle tolerance, reminders, nudge style) |
| Recurring routines + per-day completion               | One-shot micro-tasks in a session    | **Later:** recurring _study blocks_ are plausible; per-day completion is the correct model for them        |
| Time-of-day timeline with a "now" marker + reschedule | An ordered plan list, no clock times | **Optional:** a "today" timeline view, not a replacement for the plan                                      |
| Mood/wellbeing check-in (1–5 + note + history)        | None (only a weekly reflection)      | **Adopt (small):** complements the learning-state insights                                                 |
| Streak + habit heatmap + trophies                     | Daily-activity heatmap only          | **Partly adopt:** streak + habits; skip confetti/trophy gamification as a primary loop                     |
| Reminders/notifications at a planned start            | None                                 | **Adopt (small, desktop):** an Electron notification for a planned block                                   |
| Ambient sound + completion chime                      | Brown-noise ambient layer            | **Already have** the ambient layer; a completion chime is optional                                         |
| 12h/24h clock, fonts, app icon                        | Theme + locale only                  | **Adopt (tiny):** 12h/24h clock                                                                            |
| AI day-planner + chat history                         | Tutor + rescue suggestions           | **Different by design**, not a gap                                                                         |
| Course/knowledge browsing with progress               | Course + micro-task + insights       | **Already have**, in a different shape                                                                     |

## 5. Recommendations

**Do (fits FocusLoop's identity, bounded work):**

1. **Mood/wellbeing check-in** — one entry per day, 1–5 plus an optional note, surfaced beside the
   learning insights. Small, self-contained, and the clearest Tiimo strength FocusLoop lacks.
2. **Streak + habit view** — reuse the existing daily aggregates; a streak is a label over data the
   app already computes, not a new store.
3. **Reminder for a planned block** — an OS notification; desktop analogue of Tiimo's exact alarms.
4. **Onboarding questionnaire** — two or three questions whose answers write real settings, replacing
   the static block with something that personalizes the app.
5. **12h/24h clock** — a settings toggle.

**Do not:**

- **Pivot to a calendar/day-planner.** Tiimo's centre of gravity is scheduling; FocusLoop's is
  continuity _inside_ a session. Turning FocusLoop into a planner would dilute the differentiator and
  put the competition submission's core story at risk.
- **Copy code.** None of the clones has a LICENSE file, so all rights are reserved; `rea` is MIT but
  that licenses _rea_, not the analysed apps.
- **Build on Tiimo's private API.** `ckumar1/tiimo-mcp` rides undocumented endpoints with a ~5-day
  token. Using it conflicts with FocusLoop's "local-first, nothing leaves the machine" promise and
  Tiimo's terms. It is useful as _documentation of Tiimo's data model_, nothing more.

## 6. Method and evidence

- REA `analyze-javascript-application` on three public clones; digests in `evidence/`. The digests
  keep the facts a reviewer needs (modules, endpoints, storage keys, functions, string literals) and
  drop per-expression plumbing. Raw bundles are reproducible from the commands in `README.md`.
- `ckumar1/tiimo-mcp` and `halfdane/flow` were read directly for the data model.
- No claim here is about Tiimo's closed-source production app beyond what its public interface and
  the clones demonstrate; every "Tiimo does X" statement is really "the public model/clone does X".
