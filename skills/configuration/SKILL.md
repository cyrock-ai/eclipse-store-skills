---
name: configuration
description: >
  Guide Claude on configuring an Eclipse Store embedded storage — directories, channel
  count, backup, deletion, housekeeping intervals/budgets, file size thresholds,
  read-only mode, and external configuration loading from INI/XML/YAML/JSON/HOCON. Use
  this skill when the user asks to "configure storage", "set the storage directory",
  "use INI config", "load config from XML", "change channel count", "backup directory",
  "deletion directory", "truncation directory", "housekeeping budget", "data file
  minimum size", "read-only storage", "EmbeddedStorageConfiguration", "storage-embedded-
  configuration", "ConfigurationLoader", "StorageChannelCountProvider",
  "StorageFileProvider", or needs help sizing channels/budgets or picking a config file
  format.
version: 0.2.0
---

# Eclipse Store — Configuration

Eclipse Store is configured in one of three ways. Pick the right one for the job:

1. **Factory method arguments** — `EmbeddedStorage.start(root, path)`. For trivial apps.
2. **`EmbeddedStorageConfiguration` fluent builder** — programmatic, typed. Covers ~95%
   of real apps.
3. **External config files** (INI/XML/YAML/JSON/HOCON) — when ops owns the config and
   wants to edit it without redeploying. Requires `storage-embedded-configuration`.

For **deep** customization (custom file providers, custom housekeeping controllers,
custom channel-count providers) use the `EmbeddedStorageFoundation` directly — one
layer under the fluent builder.

## Do NOT use this skill

- Just getting started / wiring the bootstrap → `getting-started`.
- Tuning housekeeping beyond interval/budget → `housekeeping-and-deletion`.
- Using cloud storage (S3/Azure/Redis) → `storage-targets-afs`.
- Spring Boot `application.properties` → `spring-boot` (uses a different key prefix).

## Mental model

The fluent builder `EmbeddedStorageConfiguration.Builder()` is a convenience layer over
a `StorageConfiguration`. Each setter corresponds to a property name used in external
config files. The builder builds a config → the config builds a foundation → the
foundation builds the manager.

```
builder.setX(...) ─▶ StorageConfiguration ─▶ EmbeddedStorageFoundation ─▶ Manager
```

External loaders (`EmbeddedStorageConfiguration.load(...)`) produce the same builder
from a properties file.

## Core API — fluent builder

From `org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration`:

```java
EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data")                 // base dir
    .setStorageDirectoryInUserHome("app/data")   // resolves to ~/app/data
    .setChannelCount(4)                          // must be power of 2
    .setBackupDirectory("backup")
    .setDeletionDirectory("deleted-files")       // move instead of delete
    .setTruncationDirectory("truncated-files")
    .setHousekeepingInterval(Duration.ofSeconds(1))
    .setHousekeepingTimeBudget(Duration.ofMillis(10))
    .setEntityCacheTimeout(Duration.ofHours(1))
    .setDataFileMinimumSize(ByteSize.MB(1))
    .setDataFileMaximumSize(ByteSize.MB(8))
    .setDataFileMinimumUseRatio(0.75)
    .setDataFileCleanupHeadFile(false)
    .setTransactionFileMaximumSize(ByteSize.MB(100))
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
```

(Exact setter names are listed in `references/api-catalogue.md`.)

## Core API — external config loading

```java
// From a classpath resource (auto-detects XML vs INI by extension).
EmbeddedStorageConfiguration.load("META-INF/eclipsestore/storage.xml")
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();

// From the default location (classpath `eclipsestore.properties`,
// or the path in system property `org.eclipse.store.storage.configuration.path`)
EmbeddedStorageConfiguration.load()
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();

// YAML (requires `configuration-yaml`)
EmbeddedStorageConfiguration.load(
    ConfigurationLoader.New("META-INF/eclipsestore/storage.yaml"),
    ConfigurationParserYaml.New()
).createEmbeddedStorageFoundation().createEmbeddedStorageManager();

// JSON / HOCON (requires `configuration-hocon`)
EmbeddedStorageConfiguration.load(
    ConfigurationLoader.New("META-INF/eclipsestore/storage.json"),
    ConfigurationParserHocon.New()
).createEmbeddedStorageFoundation().createEmbeddedStorageManager();
```

**Path resolution order** (`EmbeddedStorageConfiguration.load(String)`):
1. **Classpath** via `ClassLoader.getResource(path)` — `path` must **not**
   begin with `/` (ClassLoader strips it and treats it as missing).
2. **URL** — if the path parses as a `URL` (`file:`, `http:`, etc.).
3. **Filesystem** — `new File(path)` if it exists.
4. Otherwise throws `ConfigurationExceptionNoConfigurationFound`.

Relative filesystem paths resolve against the JVM working directory (e.g.
Surefire's `workingDirectory`, which defaults to the module base dir).

## Idiomatic patterns

### Pattern A — Fluent builder for a typical app

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data")
    .setBackupDirectory("backup")
    .setChannelCount(4)
    .setHousekeepingInterval(Duration.ofSeconds(1))
    .setHousekeepingTimeBudget(Duration.ofMillis(50))
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();

storage.start();      // foundation.createEmbeddedStorageManager() returns an unstarted manager
                      // (unlike EmbeddedStorage.start(...) which returns a started one).
```

**Gotcha**: `createEmbeddedStorageManager()` returns an **unstarted** manager — call
`.start()` on it (shown above). `EmbeddedStorage.start(...)` is the alternative that
returns a started one.

Root wiring (`createEmbeddedStorageManager(root)` vs `setRoot()`/`storeRoot()`)
lives in `root-and-object-graph` and `getting-started` — that decision is
orthogonal to how you configured the storage.

### Pattern B — INI file plus classpath placement

```
src/main/resources/META-INF/eclipsestore/storage.ini
```

```ini
storage-directory = data
backup-directory = backup
channel-count = 4
housekeeping-interval = 1s
housekeeping-time-budget = 50ms
data-file-minimum-size = 1 MiB
data-file-maximum-size = 8 MiB
```

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration
    .load("META-INF/eclipsestore/storage.ini")
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

### Pattern C — XML with user-home directory

```xml
<properties>
    <property name="storage-directory" value="~/my-app/data"/>
    <property name="backup-directory"  value="~/my-app/backup"/>
    <property name="channel-count"     value="4"/>
</properties>
```

`~` is expanded only for directory properties.

### Pattern D — Dependency injection via system property

Operations want to swap configs without redeploying. Keep one config at
`src/main/resources/eclipsestore.properties` (default), override with
`-Dorg.eclipse.store.storage.configuration.path=/etc/myapp/storage.ini`.

```java
// Finds the file via the system property if set, else falls back to default name on classpath
EmbeddedStorageManager storage = EmbeddedStorageConfiguration.load()
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

### Pattern E — Read-only storage

Use when you need to *read* data that another process owns, or for reporting replicas
created by copying the live directory. **Production**: only for read replicas /
snapshot inspection — see the best-practices section below for per-environment
guidance. **Limitations** (from upstream docs):

- `.store()` throws `org.eclipse.serializer.afs.types.AfsExceptionReadOnly`
  (a `RuntimeException`).
- Housekeeping does not run (otherwise it would conflict with the owning writer).
- The structure as seen at `.start()` is frozen — the manager does not pick up new
  writes from another JVM, and it will error if the writer compacts a file.
- **The read-only manager's builder settings must match the writer's structural
  settings** — in particular `setChannelCount(...)` must equal the writer's
  channel count. Otherwise `StorageExceptionStructureValidation: Found channels
  (N) don't match the configured channel count (M)` on `start()`.

```java
EmbeddedStorageFoundation<?> foundation = EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data")
    .setChannelCount(4)                   // MUST match writer's channel count
    .createEmbeddedStorageFoundation();

var roCtl = new StorageWriteControllerReadOnlyMode(foundation.getWriteController());
foundation.setWriteController(roCtl);

EmbeddedStorageManager storage = foundation.createEmbeddedStorageManager();
storage.start();                          // still unstarted at this point — see Pattern A gotcha
```

`roCtl.setReadOnly(false)` flips back to writable — only ever use this when no other
manager is writing to the directory.

### Pattern F — Deep customization via foundation

When the fluent builder doesn't cover your need (swapping the file provider, injecting
a custom `StorageChannelCountProvider`, custom data-file evaluator):

```java
NioFileSystem fs = NioFileSystem.New();
EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
    Storage.ConfigurationBuilder()
        .setChannelCountProvider(Storage.ChannelCountProvider(4))
        .setStorageFileProvider(
            StorageLiveFileProvider.Builder()
                .setDirectory(fs.ensureDirectoryPath("data"))
                .createFileProvider()
        )
        .setBackupSetup(StorageBackupSetup.New(fs.ensureDirectoryPath("backup")))
        .createConfiguration()
).start(root);
```

Use only when you need the extra knobs; for typical work the `EmbeddedStorageConfiguration`
builder is enough.

## Channel count — sizing guidance

Channels are IO threads with exclusive directories. Rules:

- **Must be a power of 2** (1, 2, 4, 8, …). Other values are rejected.
- Default: 1.
- 2-4 covers most workloads. Parallelism mostly helps on large multi-GB datasets with
  high write churn.
- More channels = more file handles, more lock coordination. Past 8 you rarely win.
- **Changing channel count on an existing database requires data migration.** The file
  layout encodes the count. Plan it up front.

## Directory layout

Given `storage-directory = data`, `channel-count = 4`:

```
data/
├── used.lock                         # exclusive lock file
├── PersistenceTypeDictionary.ptd     # type dictionary
├── channel_0/
│   ├── channel_0_1.dat               # data files
│   └── transactions_0.sft            # transaction log
├── channel_1/…
├── channel_2/…
└── channel_3/…
```

`deletion-directory` and `truncation-directory`, when configured, receive files that
housekeeping would otherwise delete or truncate. Useful for forensic recovery.

## Property value formats

| Type | Format | Examples |
|---|---|---|
| Duration | ISO (`PnDTnHnMn.nS`) or `amount[ns\|ms\|s\|m\|h\|d]` | `1s`, `500ms`, `30m`, `PT1H` |
| Bytes | `amount[b\|kb\|kib\|mb\|mib\|gb\|gib\|tb\|tib]` | `1 MiB`, `1.5 GB`, `64 KB` |
| Directory | String; `~` prefix expands to user home | `~/app/data`, `/var/lib/app` |

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Changing channel count on an existing database

```java
// Day 1: channelCount=1
// Day 30: change to channelCount=4 in the INI file
```

The existing `data/channel_0/` layout does not magically split. Startup may succeed but
subsequent housekeeping will behave unexpectedly. Plan channel count upfront; changing
it requires a deliberate offline migration (copy data out, reimport).

### Anti-pattern 2 — Pointing read-only at a live database for long periods

Open a RO manager → writer commits → writer housekeeping compacts → RO manager's
cached structure is now wrong → next RO read throws. Read-only is best for short-lived
replicas.

### Anti-pattern 3 — Mixing factory-method config with fluent builder

```java
// WRONG — the Path arg overrides any directory in the builder
EmbeddedStorage.start(root, Paths.get("other-dir"),
    EmbeddedStorageConfiguration.Builder()
        .setStorageDirectory("data")    // ignored
        .createConfiguration());
```

Pick one style.

### Anti-pattern 4 — Loading a file that doesn't exist without checking

```java
EmbeddedStorageConfiguration.load("missing.ini")   // ConfigurationExceptionNoConfigurationFound
```

The loader throws if the resource can't be resolved on classpath, as a URL,
or on the filesystem. For optional config, try-load-else-default with
explicit error handling.

### Anti-pattern 5 — Using `~/...` outside directory properties

```ini
backup-directory = ~/backup      # OK
lock-file-name   = ~/lock.sfl    # NOT OK — file names don't resolve ~
```

### Anti-pattern 6 — Too-small housekeeping budgets

```ini
housekeeping-time-budget = 1us
```

Housekeeping is "best effort" — it completes at least one unit per cycle. A 1µs budget
doesn't stop it from running; it just means it will exceed the budget.

## Best practices: Dev / Test / Staging / Prod

Eclipse Store ships with conservative, frictionless defaults so getting started is a
one-liner. Several operational features are intentionally **off by default** — turning
them on globally would be a breaking change for existing apps, and most carry a small
cost (extra disk, extra setup, slower startup) that is only worth paying once you
leave a developer's machine.

The columns are not interchangeable. **Test** covers tests targeting application
logic (unit, fast integration); **Staging** covers tests targeting the production
deployment itself (release validation, dress-rehearsal infrastructure). If a single
test suite mixes both goals, split it — or pick the column whose goal dominates.

| Feature | Dev | Test | Staging | Prod |
|---|---|---|---|---|
| Lock file | off | off | match prod | on, if multiple processes may share storage |
| Deletion directory | off | off | **on** | **on** |
| Truncation directory | off | off | optional | optional |
| Continuous backup | off | off | **on** | **on** |
| Full backup | ad-hoc | ad-hoc | scheduled (match prod) | scheduled (e.g. nightly) |
| Adaptive housekeeping | off | off | match prod | on for write-heavy workloads |
| Channel count | 1 | 1 | match prod | tuned up-front to CPU/IO |
| Read-only mode | n/a | optional | for replicas / snapshot inspection | for read replicas / snapshot inspection |
| JMX monitoring | auth/SSL off | auth/SSL off | **auth and SSL on** | **auth and SSL on** |
| REST interface | optional | optional | off, or behind same auth as prod | off; if needed, behind auth and network isolation |

Per-feature reasoning (why each setting is recommended for each environment,
what trade-off it represents) → `references/dev-test-staging-prod.md`.

## Pitfalls & gotchas

1. **`createEmbeddedStorageManager()` returns an unstarted manager.** Call `.start()`
   on the result before use. `EmbeddedStorage.start(...)` is the alternative that
   returns a started one.
2. **Default `channel-count = 1`.** Perfectly fine for small apps. Bump to 2-4 only
   when profiling shows an IO bottleneck.
3. **Data file size limits are 2 GB hard ceilings.** `data-file-minimum-size` and
   `-maximum-size` must be under 2 GB — internal implementation limit.
4. **`data-file-minimum-use-ratio` default is 0.75.** A file with <75% live data gets
   compacted. Lower this to reduce compaction I/O at the cost of disk space; raise to
   save disk at the cost of more churn.
5. **Deletion directory fills up.** If set, the deletion directory accumulates forever
   unless the app (or ops) clears it. Useful as a safety net, not a permanent policy.
6. **Config value parsing is lenient on whitespace.** `1 MiB` and `1MiB` both parse.
   But not all ops staff know this — be explicit in examples.
7. **Property name constants** are in `EmbeddedStorageConfigurationPropertyNames`.
   Use them if you're programmatically constructing properties.

## Interactions with other skills

- **`getting-started`** — the trivial two-arg `start(root, path)` covers the simplest
  case; upgrading to a builder is this skill.
- **`housekeeping-and-deletion`** — housekeeping tuning via interval/budget/ratio is
  authored here as properties; the *semantics* live in that skill.
- **`storage-targets-afs`** — the `storage-filesystem` / `backup-filesystem` complex
  properties route storage at S3/Azure/Redis; that skill covers the full AFS config.
- **`spring-boot`** — Spring Boot uses its own property prefix (`org.eclipse.store.*`)
  and exposes most of these same settings.

## Recipes

**"How do I load config from `application.properties`?"** → You can't
directly — that file is Spring's. Either use Spring Boot (`spring-boot`
skill) or use INI/YAML/XML via `ConfigurationLoader`.

**"How do I externalize only the directory?"** → Use a system property
yourself: `Paths.get(System.getProperty("app.data.dir", "data"))`. Or rely
on the full external config file.

**"What's a sane housekeeping budget for a busy writer?"** → For
write-heavy production workloads, enable `housekeeping-adaptive` — it
raises the budget automatically when GC falls behind. The fixed default
(`interval=1s`, `time-budget=10ms`) is sufficient for read-heavy or
low-write apps.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need the **full property
  reference** — every setter mapped to its INI / YAML / XML property key,
  type, default value, description, and the internal type it configures
  (`StorageLiveFileProvider`, `StorageChannelCountProvider`,
  `StorageHousekeepingController`, etc.). Also covers foundation-level
  types (`StorageBackupSetup`, `StorageDataFileEvaluator`,
  `StorageWriteController*`, …) for deep overrides.
- **Load `references/channel-count-tuning.md`** when sizing channels for
  a real workload (CPU / IO trade-offs) or **migrating an existing
  database** to a different channel count.
- **Load `references/dev-test-staging-prod.md`** when reasoning about
  per-environment settings beyond the in-line table — *why* each row is
  set the way it is, and what the failure modes are if you deviate.
- **Load `references/examples-expanded.md`** when you want a complete
  end-to-end config file in a specific format (INI, XML, YAML, JSON,
  HOCON, programmatic).
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a config
  bug — startup failure, unexpected defaults, channel-count mismatch,
  housekeeping running too rarely, deletion directory filling up.

## Upstream sources

- `docs/modules/storage/pages/configuration/index.adoc`
- `docs/modules/storage/pages/configuration/properties.adoc`
- `docs/modules/storage/pages/configuration/using-channels.adoc`
- `docs/modules/storage/pages/configuration/housekeeping.adoc`
- `docs/modules/storage/pages/configuration/readonly.adoc`
- `docs/modules/storage/pages/configuration/storage-files-and-directories.adoc`
- `docs/modules/storage/pages/configuration/lock-file.adoc`
- `docs/modules/storage/pages/configuration/backup/`
- `docs/modules/storage/pages/configuration/best-practices.adoc` — Dev / Test
  / Staging / Prod recommendations.
- `examples/helloworld-ini/`
