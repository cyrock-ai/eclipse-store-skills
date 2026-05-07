# tools/

Developer tooling for the `eclipse-store-claude` repo.

## `port-skills.mjs`

Generates per-tool rule files from `skills/` (the source of truth) so users of
AI coding tools other than Claude Code can benefit from the same guidance.

### Usage

```bash
# One target
node tools/port-skills.mjs --target cursor

# Every target (emits under dist/<target>/)
node tools/port-skills.mjs --target all

# Custom output location
node tools/port-skills.mjs --target cursor --out /path/to/my-project
```

No `npm install` step — the script is zero-dependency Node.js ESM.

### Output layout

| Target     | Emits                                                           |
|------------|-----------------------------------------------------------------|
| `cursor`   | `.cursor/rules/<slug>.mdc` (Agent Requested via `description`) + `docs/eclipse-store/<slug>/*.md` |
| `windsurf` | `.windsurf/rules/<slug>.md` (`trigger: model_decision`) + `docs/eclipse-store/<slug>/*.md` |
| `copilot`  | `.github/instructions/<slug>.instructions.md` (`applyTo: '**'`) + `docs/eclipse-store/<slug>/*.md` |
| `continue` | `.continue/rules/<slug>.md` + `docs/eclipse-store/<slug>/*.md`  |
| `aider`    | `CONVENTIONS.md` (single file; refs dropped)                    |
| `cline`    | `.clinerules/<slug>.md` + `docs/eclipse-store/<slug>/*.md`      |

`cursor`, `windsurf`, `continue`, `cline`, and `copilot` emit reference docs
as plain Markdown alongside each rule. Cursor / Windsurf / Continue / Cline
load them on demand via description-based skill activation. Copilot has no
description-based activation: every `.github/instructions/*.instructions.md`
file with `applyTo: '**'` is appended to every prompt, so the per-skill split
is for editability and diff hygiene, not selective loading. References under
`docs/eclipse-store/<slug>/` are linked from each instruction file but are
not auto-loaded by Copilot — users open them manually when needed.

`aider` is the one target that genuinely cannot do per-skill files in the
conventional setup; the generator concatenates every `SKILL.md` into a single
`CONVENTIONS.md` and drops references.

### Options

- `--target <name>` — required. One of `cursor`, `windsurf`, `copilot`,
  `continue`, `aider`, `cline`, or `all`.
- `--out <dir>` — output root. Default: `dist/<target>/` in this repo.

### How to consume the output

Copy the relevant tree from `dist/<target>/` into the root of a consuming
project. For Cursor that's the `.cursor/` directory (plus the sibling
`docs/eclipse-store/` if you want on-demand reference docs). For Copilot
it's the `.github/instructions/` directory (and optionally
`docs/eclipse-store/` so the linked reference docs resolve).

Alternatively, publish `dist/` as a release artifact and have consumers pull
it down with `curl` / `gh release download`.

### Cross-reference rewriting

Skills link to each other with the pattern `` → `<slug>` ``. The generator
rewrites these per target (e.g. to a Cursor mdc-link or a plain code span)
but only for slugs that are actually skills — non-skill tokens in backticks
(like artifact names) are left alone.
