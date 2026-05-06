# Eclipse Store & Serializer Skills for AI Coding Agents

Opinionated, topic-focused skills for building applications with
[Eclipse Store](https://eclipsestore.io) and [Eclipse Serializer](https://github.com/eclipse-serializer/serializer),
designed to be consumed by multiple AI coding agents.

The `skills/` tree is the source of truth — plain, prescriptive Markdown with
per-topic references. From it we emit native formats for Claude Code, Cursor,
Windsurf, GitHub Copilot, Continue, Aider, and Cline so each tool loads the
same patterns instead of guessing from stale web content.

When you ask any of these tools to bootstrap a database, store a graph, add a
`Lazy<T>`, build a `GigaMap` query, wire storage into Spring Boot, or evolve a
schema, the matching skill/rule activates and drives the answer.

## Supported coding agents

| Agent | Format | Install |
|-------|--------|---------|
| Claude Code | native plugin (`.claude-plugin/` + `skills/`) | `/plugin` marketplace — see below |
| Cursor | `.cursor/rules/*.mdc` (Agent Requested) | `node tools/port-skills.mjs --target cursor` |
| Windsurf | `.windsurf/rules/*.md` (`trigger: model_decision`) | `--target windsurf` |
| GitHub Copilot | `.github/copilot-instructions.md` | `--target copilot` |
| Continue | `.continue/rules/*.md` | `--target continue` |
| Aider | `CONVENTIONS.md` | `--target aider` |
| Cline | `.clinerules/*.md` | `--target cline` |

Cursor, Windsurf, Continue, and Cline preserve the lazy-loading pattern by
emitting reference docs alongside each rule. Copilot and Aider inline only the
`SKILL.md` bodies to stay within each tool's instruction budget.

See [`tools/README.md`](tools/README.md) for per-target output layouts,
options, and how to drop the generated files into a consuming project.

## Install in Claude Code

From a Claude Code session:

```
/plugin marketplace add cyrock-ai/eclipse-store-skills
/plugin install eclipse-store-claude@eclipse-store-claude
/reload-plugins
```

After reload, `/plugin` should show `eclipse-store-claude` with all skills listed under
`eclipse-store-claude:<skill-name>`.

## Install in other tools

```bash
# One target
node tools/port-skills.mjs --target cursor

# Every target (emits under dist/<target>/)
node tools/port-skills.mjs --target all

# Custom output location — drop directly into a consuming project
node tools/port-skills.mjs --target cursor --out /path/to/my-project
```

No `npm install` step — the generator is zero-dependency Node.js ESM.

## Skills

| Skill | Covers |
|-------|--------|
| `getting-started` | `EmbeddedStorage.start`, `EmbeddedStorageFoundation`, lifecycle, shutdown |
| `root-and-object-graph` | default root, custom root, `storeRoot`, graph design |
| `storing-data` | `store()`, `storeAll()`, lazy vs eager storing, `BatchStorer`, the "store the parent" rule |
| `lazy-loading` | `Lazy<T>`, `Reference<T>`, deferred subgraph loading |
| `concurrency-and-locking` | thread safety, mutate + `store()` under same lock, `LockedExecutor` / `LockScope` / striped, Spring `@Read`/`@Write`/`@Mutex`, GigaMap concurrency |
| `configuration` | programmatic / INI / XML config, channel count, backup directory, Dev / Test / Staging / Prod best practices |
| `housekeeping-and-deletion` | GC, file compaction, cache eviction, deletes via ref removal |
| `legacy-type-mapping` | schema evolution — renamed / removed / retyped fields and classes |
| `custom-type-handlers` | `CustomBinaryHandler`, registering handlers on the foundation |
| `serializer-standalone` | using Eclipse Serializer without storage (RPC, exports, REST) |
| `storage-targets-afs` | AFS backends — NIO, S3, Azure Blob, Redis, Kafka, etc. |
| `gigamap` | `GigaMap`, indices, `GigaQuery`, bitmap/Lucene/jvector |
| `cache-jcache` | JSR-107 cache over Eclipse Store, Hibernate L2 |
| `spring-boot` | Spring Boot 3 starter, properties, `@Autowired`, `@Read`/`@Write`/`@Mutex` |

In Claude Code these appear as `eclipse-store-claude:<skill-name>`. Other
agents expose them under their own naming (e.g. Cursor rule filename,
Continue rule filename).

## Structure

```
eclipse-store-skills/
├── .claude-plugin/          # Claude Code plugin descriptor
│   ├── plugin.json
│   └── marketplace.json
├── skills/                  # source of truth
│   └── <skill-name>/
│       ├── SKILL.md
│       └── references/
│           ├── api-catalogue.md
│           ├── examples-expanded.md
│           └── pitfalls-deep-dive.md
├── tools/
│   ├── port-skills.mjs      # emits rule files for non-Claude agents
│   └── README.md
└── README.md
```

Each `SKILL.md` is prescriptive and pattern-focused. Long-form API tables,
full code examples, and deep-dive pitfall walkthroughs live in `references/`
and are loaded by the agent on demand (or inlined by the generator for tools
that don't support lazy loading).

## Upstream source references

The `references/api-catalogue.md` in each skill cites file paths into the
upstream source repos to anchor API signatures. Paths under `org/eclipse/store/…`
are relative to [`eclipse-store/store`](https://github.com/eclipse-store/store);
paths under `org/eclipse/serializer/…` are relative to
[`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer).

Agents don't need the repos checked out to use the skills — the paths are
pointers, not requirements. But if you clone either repo next to your
project, your agent can open the cited files directly for verification.

