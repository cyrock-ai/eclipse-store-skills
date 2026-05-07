# CLAUDE.md — Authoring Eclipse Store Skills

This repo is the source of truth for a portable skill set that is consumed by
Claude Code natively and ported to Cursor / Windsurf / Copilot / Continue /
Aider / Cline via `tools/port-skills.mjs`. Read this file before adding,
splitting, or rewriting a skill.

## Repository layout

```
eclipse-store-skills/
├── .claude-plugin/             # Claude Code plugin descriptor (do not hand-edit casually)
│   ├── plugin.json
│   └── marketplace.json
├── skills/                     # source of truth
│   └── <skill-name>/           # one directory per topic
│       ├── SKILL.md            # prescriptive, pattern-focused
│       └── references/
│           ├── api-catalogue.md      # symbols + upstream file paths
│           ├── examples-expanded.md  # full runnable examples
│           ├── pitfalls-deep-dive.md # root-cause + repro + fix per pitfall
│           └── <topic>.md            # optional topical deep-dives
├── dist/                       # generated per-target output (do not hand-edit)
├── tools/
│   ├── port-skills.mjs         # zero-dep ESM, emits Cursor/Windsurf/etc.
│   └── README.md
├── README.md
└── CLAUDE.md                   # this file
```

`SKILL.md` is the agent-loaded entry point. References are loaded on demand by
agents that support lazy loading (Claude Code, Cursor, Windsurf, Continue,
Cline). Copilot has no description-based skill activation: the generator
emits one `.github/instructions/<slug>.instructions.md` per skill with
`applyTo: '**'` (so all of them apply on every prompt) and copies references
alongside under `docs/eclipse-store/<slug>/`. Aider has no per-skill
mechanism in the conventional setup; the generator concatenates every
`SKILL.md` into a single `CONVENTIONS.md` and drops references.

## Skill anatomy — `SKILL.md`

### Frontmatter

```yaml
---
name: <skill-name>             # must match the directory name
description: >                  # rich, multi-paragraph; this is what the agent matches against
  One-sentence summary in the indicative ("Guide Claude on …").

  **Apply this skill whenever <design-time scenario>** — call out that the
  skill activates *before* an explicit keyword is uttered. State the cost of
  retrofitting the pattern later so the agent loads it eagerly at design time.

  Also use this skill when the user asks to "<keyword 1>", "<keyword 2>", … —
  list 10-30 quoted trigger phrases including class names, method names, and
  natural-language paraphrases. Cover both reactive and design-time wording.
version: <semver>               # bump when behavior or triggers change
---
```

The description is the only thing the agent sees when deciding whether to load
the skill. **Triggers must cover design-time wording**, not only the obvious
keywords (see `memory/feedback_skill_triggers_design_time.md`). If the skill
exists to influence model design, the description should say so explicitly and
list the design-time scenarios.

### Body sections (in this order)

1. **One-paragraph framing** — the central insight that the rest of the file
   stems from. Often a "the library does not do X for you" rule.
2. **When to use this skill** — bullet list. Split into **Design-time triggers**
   and **Reactive triggers** when the skill applies at design time.
3. **Do NOT use this skill** — list 3-6 sibling skills with the routing rule
   ("→ `<sibling>`"). This prevents skill overlap and keeps each one focused.
4. **Mental model** — 1-3 short paragraphs. Ground the agent in *what is
   actually happening* before showing API.
5. **Core API** — Markdown table: `Symbol | Purpose`. Keep it terse; the full
   catalogue lives in `references/api-catalogue.md`.
6. **Maven / Gradle setup** — only if the skill introduces new artifacts.
7. **Idiomatic patterns** — `Pattern A`, `Pattern B`, … Each pattern is a
   complete, copy-pasteable code block, optionally with numbered annotations
   `(1)` `(2)` walked through underneath.
8. **Anti-patterns (do NOT do this)** — `WRONG` comment in code, then a
   1-2 sentence explanation of why it fails and what to do instead.
9. **Pitfalls & gotchas (ranked by frequency of failure)** — numbered list,
   most common first. Each pitfall is one paragraph; deep analysis goes in
   `references/pitfalls-deep-dive.md`.
10. **Interactions with other skills** — bullet list of `<sibling>` references
    explaining when to hand off.
11. **Recipes** — Q&A pairs ("How do I X?" → one-sentence answer). Optional
    but highly valued by users skimming.
12. **Deeper lookups (on-demand)** — bullet list pointing to each
    `references/*.md` with a one-line description.
13. **Upstream sources** — file paths into the upstream Eclipse Store /
    Serializer repos. Paths under `org/eclipse/store/…` are relative to
    `eclipse-store/store`; paths under `org/eclipse/serializer/…` are relative
    to `eclipse-serializer/serializer`.

Sections may be omitted when not applicable, but do not reorder.

## Reference files — `skills/<name>/references/`

Each reference is independently loadable. Keep them topical and self-contained
so an agent that loads one does not need to load another to make sense of it.

| File | Purpose |
|---|---|
| `api-catalogue.md` | Every public symbol grouped by concern; one row per method with a one-line purpose. Includes upstream file path so an agent can verify signatures. |
| `examples-expanded.md` | 2-5 full runnable examples that complete the patterns in `SKILL.md`. Imports included. |
| `pitfalls-deep-dive.md` | One section per pitfall in `SKILL.md`: minimal reproducer, root cause, fix. |
| `<topic>.md` | Optional. Use for any deep-dive that does not fit the three above (e.g. `query-dsl.md`, `vector-deep-dive.md`, `s3.md`, `properties-reference.md`). One topic per file. |

Reference files do not have frontmatter.

## File-size rules

These keep loading costs predictable across agents — Cursor / Windsurf attach
rules per chat, Copilot loads every `.github/instructions/*.instructions.md`
on every prompt (so total skill volume matters, even though files are split),
and Aider concatenates every `SKILL.md` into a single `CONVENTIONS.md`.
Oversized files blow context budgets on the leanest targets.

| File | Target | Hard ceiling |
|---|---|---|
| `SKILL.md` | 300-500 lines | 600 lines — split into a sibling skill above this |
| `references/api-catalogue.md` | 100-200 lines | 400 lines |
| `references/examples-expanded.md` | 150-250 lines | 400 lines |
| `references/pitfalls-deep-dive.md` | 150-250 lines | 400 lines |
| `references/<topic>.md` | 80-200 lines | 350 lines |

If a `SKILL.md` is approaching the ceiling, prefer one of:

- **Split into two skills** along a natural seam (e.g. design-time vs.
  troubleshooting). Each gets its own description with focused triggers.
- **Move material into a new topical reference file** and leave a one-line
  pointer in `SKILL.md` under "Deeper lookups".

## Writing conventions

- **Tone is prescriptive, not exploratory.** "Do this. Don't do that. Here's
  why." Skills are not tutorials.
- **Code blocks are tagged** (`java`, `xml`, `properties`, `yaml`, `bash`).
- **Annotate non-obvious code** with `(1)` `(2)` `(3)` markers and a numbered
  walkthrough underneath. Don't paraphrase the code — explain the *why*.
- **Anti-patterns use a `// WRONG` comment** on the offending line. Always
  follow with the corrected version or a routing rule.
- **No emojis.** No marketing language. No "simply" / "just" / "easily".
- **Cross-reference siblings by skill name in backticks**, e.g. `` `spring-boot` ``.
  The port script rewrites these for non-Claude targets.
- **Upstream paths are exact**: `storage/embedded/src/main/java/...`. Don't
  invent paths — open the upstream repo if you're unsure.
- **No invented APIs.** If you don't know whether a method exists, search the
  upstream source. Hallucinated symbols in skill files poison every downstream
  agent.

## Editing workflow

1. Edit `skills/<name>/SKILL.md` and/or its references.
2. If you renamed a skill, update:
   - the directory name,
   - the `name:` frontmatter,
   - cross-references in other skills,
   - `README.md` skill table,
   - `.claude-plugin/marketplace.json` if the skill list shifted.
3. Bump the `version:` in frontmatter for any behavioral change (new triggers,
   reorganized sections, corrected API). Patch for typos / wording.
4. Regenerate the dist tree:
   ```bash
   node tools/port-skills.mjs --target all
   ```
   Inspect `dist/<target>/` to confirm output is sane. The script is
   zero-dependency Node ESM — no `npm install` needed.
5. Commit `skills/`, `dist/`, and any updated docs together so consumers of
   any one target get a consistent set.

## When to add a new skill vs. extending an existing one

Add a new skill when:

- The trigger surface is genuinely distinct (different keywords, different
  user intent) — e.g. `cache-jcache` vs. `gigamap`.
- The existing skill is approaching the size ceiling and there is a clean
  topical seam.
- The new material would dilute the existing skill's "when to use" section.

Extend an existing skill when:

- The material is a natural expansion of the same mental model.
- It would be a topical deep-dive — add `references/<topic>.md` and link from
  "Deeper lookups". Do not inline 200 lines into `SKILL.md` to avoid creating
  a reference file.

When in doubt, prefer a topical reference file over a new top-level skill.
A new skill costs trigger-surface coordination across every other skill.

## What NOT to do

- Don't add narrative prose, marketing copy, or "introduction to X" sections.
  Skills are tools for agents, not tutorials for humans.
- Don't duplicate content across skills. Cross-reference instead.
- Don't write speculative / "it might also be possible to" guidance. If it's
  not in the upstream code, it doesn't go in.
- Don't write keyword-only descriptions (a bare list of quoted phrases). The
  description must also articulate the design-time scenario in prose so the
  agent picks the skill up before any keyword is typed.
- Don't hand-edit `dist/`. Always regenerate via `tools/port-skills.mjs`.
- Don't put example code in `SKILL.md` that doesn't compile. If you can't
  verify it against the upstream API, don't include it.
