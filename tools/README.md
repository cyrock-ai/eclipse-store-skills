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
| `copilot`  | `.github/copilot-instructions.md` (single file; refs link to source on GitHub) |
| `continue` | `.continue/rules/<slug>.md` + `docs/eclipse-store/<slug>/*.md`  |
| `aider`    | `CONVENTIONS.md` (single file; refs dropped)                    |
| `cline`    | `.clinerules/<slug>.md` + `docs/eclipse-store/<slug>/*.md`      |

`cursor`, `windsurf`, `continue`, and `cline` preserve the lazy-loading pattern
by emitting reference docs as plain Markdown alongside each rule — the rule
body links to them and the tool's agent loads them on demand.

`copilot` and `aider` inline only the `SKILL.md` bodies (~5k lines total) and
drop references to stay within each tool's instruction budget. Copilot's
output links each reference back to the original repo on GitHub so users can
open them directly when needed.

### Options

- `--target <name>` — required. One of `cursor`, `windsurf`, `copilot`,
  `continue`, `aider`, `cline`, or `all`.
- `--out <dir>` — output root. Default: `dist/<target>/` in this repo.
- `--repo-url <url>` — base repo URL used by `copilot` for reference-doc
  links. Default: `https://github.com/cyrock-ai/eclipse-store-claude`.

### How to consume the output

Copy the relevant tree from `dist/<target>/` into the root of a consuming
project. For Cursor that's the `.cursor/` directory (plus the sibling
`docs/eclipse-store/` if you want on-demand reference docs). For Copilot it's
the single `.github/copilot-instructions.md`.

Alternatively, publish `dist/` as a release artifact and have consumers pull
it down with `curl` / `gh release download`.

### Cross-reference rewriting

Skills link to each other with the pattern `` → `<slug>` ``. The generator
rewrites these per target (e.g. to a Cursor mdc-link or a plain code span)
but only for slugs that are actually skills — non-skill tokens in backticks
(like artifact names) are left alone.
