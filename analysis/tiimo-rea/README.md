# Tiimo, reverse-engineered with REA

This directory is an **analysis-only** artifact. It is not part of the product: it adds no code to
`apps/` or `packages/`, and it lives on the `analysis/rea-tiimo` branch so it can be reviewed or
dropped without touching `main`.

## Why this exists

Tiimo is the reference product in the same space as FocusLoop (ADHD-friendly planning and focus). The
question was: **which of Tiimo's strengths should FocusLoop learn from, and are any of them worth
copying?**

The short answer is in [`REPORT.md`](./REPORT.md): Tiimo's production source is **not** public, so
"reverse-engineering Tiimo" means analysing the public clones and the one public reverse-engineering
of its API. What we can take is _feature and UX design_, not code.

## The tool

[`morluto/rea`](https://github.com/morluto/rea) (`rea-agents` on npm, MIT) — an MCP server and CLI
that reconstructs evidence about native binaries, JavaScript/Electron applications, .NET assemblies
and websites. Static JavaScript analysis needs no native analysis engine (Hopper/Ghidra/IDA), which is
what this analysis used.

```sh
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json > evidence.json
```

REA reports its own limits, and they apply to every claim below: the JavaScript was parsed as **inert
text**, never executed; import, endpoint and storage relationships are static and do not prove runtime
behaviour; dynamic or obfuscated paths may stay unresolved; `confidence: derived`,
`authority: shipped-artifact`.

## Targets analysed

| Public repo                    | Stack               | Why it was chosen                                                                                |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------ |
| `anujgangwar7733-collab/Tiimo` | React + Vite        | The most feature-complete web clone; names its own endpoints and gamification model              |
| `nwachukwuchukwuka/tiimo`      | Expo / React Native | The fullest product surface: onboarding questionnaire, calendar, knowledge, AI planner, settings |
| `CasperEngl/tiimo-onboarding`  | Next.js             | A focused clone of Tiimo's onboarding tour (React Joyride)                                       |

Also read by hand (not analysed with REA, because it is Kotlin source and REA's native path needs an
engine that is not installed here): `halfdane/flow`, an offline Android "tiimo clone" with a clean
Room data model. Its data model is summarized in the report.

## Files

- `REPORT.md` — findings, gap analysis against FocusLoop, and recommendations.
- `digest.mjs` — condenses a REA Evidence JSON into a small, reviewable digest.
- `evidence/*.json` — the digests. The raw Evidence bundles are tens of megabytes each and are
  deliberately **not** committed; they can be regenerated with the command above.

## Reproduce the digests

```sh
npx -y rea-agents@latest analyze-javascript-application /path/to/repo --json > raw.json
node digest.mjs raw.json owner/repo > evidence/name.json
```

The digests were produced with `rea-agents@6.4.0` on Node 24.13.0, Windows 11, 2026-10.
