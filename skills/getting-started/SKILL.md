---
name: getting-started
description: >
  Guide Claude on initializing, starting, and shutting down an Eclipse Store embedded database.
  This skill should be used when the user asks to "start EmbeddedStorage", "initialize StorageManager",
  "set up Eclipse Store", "bootstrap a database", "create an Eclipse Store application",
  "use EmbeddedStorageFoundation", "shut down storage", "add the storage-embedded dependency",
  or needs help with the storage lifecycle, Maven/Gradle coordinates, the difference between
  `EmbeddedStorage.start()` and the Foundation builder, or running multiple databases in one JVM.
version: 0.1.0
---

# Eclipse Store — Getting Started (Embedded Storage Lifecycle)

This skill covers how to bootstrap an Eclipse Store embedded database: Maven setup, the two
entry-point styles (`EmbeddedStorage.start(...)` vs. `EmbeddedStorageFoundation`), what
"starting" really does, shutdown semantics, and running multiple databases in the same JVM.

## When to use this skill

Use this skill when the user is:

- Creating a new Eclipse Store application from scratch.
- Asking how to wire `EmbeddedStorageManager` into a non-Spring / non-CDI app.
- Adding the Maven dependency and not sure which artifact (`storage-embedded` vs.
  `storage-embedded-configuration`).
- Confused about `shutdown()` — whether it's required, when to call it.
- Running more than one database inside a single JVM.
- Migrating from another persistence mechanism and needs the minimal viable bootstrap.

**Do NOT use this skill** (route to a sibling skill instead) when the user asks to:

- Wire storage into Spring Boot → `spring-boot`.
- Design the root object or decide between default and custom root →
  `root-and-object-graph`.
- Store data, pick eager vs. lazy storing, or use `BatchStorer` → `storing-data`.
- Load configuration from INI/XML files or tune channel count → `configuration`.
- Deploy against S3 / Azure / Redis / Kafka → `storage-targets-afs`.

## Mental model

An Eclipse Store "database" is just three things:

1. **A directory on some file system** (local, S3 bucket, Azure container, …) holding the
   binary storage files.
2. **The database-managing threads** (channels) that read and write those files.
3. **The `EmbeddedStorageManager` instance** — the Java-side handle the application uses
   to access the database.

There is no JVM-wide registry, no static state, no singleton. The manager is just an
object. Starting it spins up the channel threads; shutting it down stops them. Data is
physically on disk after each `.store()` call returns; a process crash between stores
cannot corrupt the database — the next startup truncates any partially-written tail.

The consequence: **`shutdown()` is optional by design**. Call it only when you need to
release file locks while the JVM stays alive (e.g., reconfigure, copy files, restart with
different settings). For "application exits → database stops", `System.exit(0)` is fine.

## Core API

All entry points live in `org.eclipse.store.storage.embedded.types` from the
`org.eclipse.store:storage-embedded` artifact.

| Symbol | Purpose |
|---|---|
| `EmbeddedStorage.start()` | Boot with defaults — root is null, directory is `./storage`. Smallest possible call. |
| `EmbeddedStorage.start(Path directory)` | Directory only; root is null. |
| `EmbeddedStorage.start(Object root)` | Root only; directory is `./storage`. |
| `EmbeddedStorage.start(Object root, Path directory)` | **The canonical form** — root + directory. |
| `EmbeddedStorage.start(Object root, StorageConfiguration config)` | Programmatic config. |
| `EmbeddedStorage.start(Object root, StorageConfiguration.Builder<?> builder)` | Fluent builder config. |
| `EmbeddedStorage.Foundation(...)` | Returns `EmbeddedStorageFoundation<?>` for full customization (custom type handlers, connection foundation, etc.). Call `.start(root)` on the foundation. |
| `EmbeddedStorageManager.root()` | Returns the root instance (always non-null after the first store). |
| `EmbeddedStorageManager.setRoot(Object)` | Replace the root instance. |
| `EmbeddedStorageManager.ensureRoot(Supplier)` | If `root()` is null, invokes the supplier and persists the result; if already loaded, returns the loaded root unchanged. |
| `EmbeddedStorageManager.storeRoot()` | Store the current root. |
| `EmbeddedStorageManager.store(Object)` | Store any other object in the graph. |
| `EmbeddedStorageManager.shutdown()` | Stop managing threads; release file locks. |

The complete JavaDoc lives at `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorage.java`.
Full method catalogue in `references/api-catalogue.md`.

## Maven / Gradle setup

The `storage-embedded` artifact pulls in everything needed for a local-filesystem
database. If you also want INI/XML config loading, add `storage-embedded-configuration`.

```xml
<!-- pom.xml -->
<dependencies>
  <dependency>
    <groupId>org.eclipse.store</groupId>
    <artifactId>storage-embedded</artifactId>
    <version>${eclipse-store.version}</version>
  </dependency>

  <!-- Optional: only if you load configuration from INI/XML/properties files -->
  <dependency>
    <groupId>org.eclipse.store</groupId>
    <artifactId>storage-embedded-configuration</artifactId>
    <version>${eclipse-store.version}</version>
  </dependency>
</dependencies>
```

**Do not** pull in both `storage-embedded` and the Spring Boot starter
(`integrations-spring-boot3`) by hand — the starter is the correct dependency for Spring
apps and it transitively brings in `storage-embedded`. If the user is using Spring Boot,
route to `spring-boot` instead.

**Java version**: minimum Java 17 (enforced by the build). Java 21 works.

## Idiomatic patterns

### Pattern A — Hello-world (canonical two-liner)

```java
import java.nio.file.Paths;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class Main {
    public static void main(String[] args) {
        DataRoot root = new DataRoot();                                         // (1)
        EmbeddedStorageManager storage =
            EmbeddedStorage.start(root, Paths.get("data"));                     // (2)

        System.out.println(root);
        root.setContent("Hello World @ " + java.time.Instant.now());
        storage.storeRoot();                                                    // (3)

        // shutdown is optional — storage is crash-safe. Omit it unless you need
        // to release file locks mid-process.
    }
}
```

1. The root instance is supplied **before** `.start(...)`. Eclipse Store populates its
   fields from storage if data exists, or keeps it as-is if the database is fresh.
2. `.start(root, dir)` spins up channel threads. First run creates the directory; later
   runs load the persisted graph onto the fields of the `root` instance **in place**.
3. `storeRoot()` is shorthand for "persist the root object itself". To persist any other
   mutated object, call `storage.store(thatObject)` — see the `storing-data` skill for
   the full rules.

### Pattern B — Foundation for advanced setup

Use the foundation pattern when you need customization that `start(...)` does not expose:
custom type handlers, a custom connection foundation, replaced file systems, custom root
resolvers, etc.

```java
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageFoundation;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration;

EmbeddedStorageFoundation<?> foundation = EmbeddedStorage.Foundation(
    EmbeddedStorageConfiguration.Builder()
        .setStorageDirectory("data")
        .setChannelCount(4)
        .createConfiguration()
);

// foundation.onConnectionFoundation(cf -> cf.registerCustomTypeHandler(...));
// foundation.onConnectionFoundation(cf -> cf.setRootResolver(...));

EmbeddedStorageManager storage = foundation.start(new DataRoot());
```

Rules for the foundation:

- **Configure before `.start()`.** Once the manager is built, the foundation is frozen —
  you cannot add type handlers or change channel count afterward.
- The foundation is a single-shot builder. Do not reuse it for a second manager.
- `foundation.start()` (no root) gives you a null default root until `setRoot()` is called.

### Pattern C — Try-with-resources for short-lived managers

`EmbeddedStorageManager` implements `AutoCloseable` via `shutdown()`. When you *do* want
explicit lifecycle (tests, short-lived tools, migration scripts), this is the safest
form:

```java
try (EmbeddedStorageManager storage =
        EmbeddedStorage.start(root, Paths.get("data"))) {
    root.setContent("something");
    storage.storeRoot();
}   // shutdown() called here
```

Do NOT wrap the manager in try-with-resources in an application's `main()` — it adds
overhead and gives no safety (see Mental Model).

### Pattern D — Two databases in one JVM

Nothing stops you from running more than one. The only rule: no two live managers may
share the same directory.

```java
EmbeddedStorageManager orders =
    EmbeddedStorage.start(new OrdersRoot(), Paths.get("data/orders"));
EmbeddedStorageManager inventory =
    EmbeddedStorage.start(new InventoryRoot(), Paths.get("data/inventory"));
```

Each has its own root, its own channel threads, its own graph.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Pointing two managers at the same directory

```java
// WRONG
EmbeddedStorageManager a = EmbeddedStorage.start(rootA, Paths.get("data"));
EmbeddedStorageManager b = EmbeddedStorage.start(rootB, Paths.get("data"));  // ← fails
```

The second `start` throws because the first holds an exclusive lock on the lock file in
`data/`. If this is what the user actually wants (two views over one database), they
probably want a single manager and two application-level services on top.

### Anti-pattern 2 — Reusing a foundation after `.start()`

```java
// WRONG
var f = EmbeddedStorage.Foundation(config);
var m1 = f.start(r1);
var m2 = f.start(r2);  // ← undefined behaviour; the foundation is already consumed
```

Build a fresh foundation per manager.

### Anti-pattern 3 — Adding type handlers after the manager is started

```java
// WRONG
var m = EmbeddedStorage.start(root, dir);
m.persistenceManager().typeDictionary()... // trying to register a handler ← too late
```

All type handlers must be registered on the foundation before `.start()`. See
`custom-type-handlers`.

### Anti-pattern 4 — Calling `.start()` on a manager you already created

```java
// WRONG
EmbeddedStorageManager m = EmbeddedStorage.start(root, dir);  // already started
m.start();                                                    // ← redundant / no-op at best
```

`EmbeddedStorage.start(...)` returns an already-started manager.

### Anti-pattern 5 — Swallowing `StorageException` at bootstrap

```java
// WRONG
try {
    EmbeddedStorage.start(root, dir);
} catch (Exception ignored) {}
```

A failed startup usually indicates a lock conflict, a corrupted channel file, or a
classpath problem. Let it propagate; log at the entry point.

## Pitfalls & gotchas (ranked by frequency of failure)

1. **Assuming `shutdown()` is mandatory.** It is not — the storage is crash-safe. Omit
   it in a normal application. Call it only for mid-process lifecycle operations.
2. **Creating the root after `.start()`.** You must pass the root instance **into**
   `.start()`. Loading populates its fields in place. If you pass a fresh instance and
   storage already exists, the fresh instance is discarded and the manager returns with
   the loaded root — retrieve it via `storage.root()`.
3. **Expecting `start()` without a root to be permanent.** A manager started without a
   root has `root() == null` until you call `setRoot(...)` and `storeRoot()`.
4. **Default directory is `./storage`, not `./data`.** If the user reads the docs' "Hello
   World" which uses `Paths.get("data")`, be explicit — no convention, just what you
   passed.
5. **Trying to change channel count on an existing database.** The channel count is
   baked into the file layout. Changing it for an existing database requires data
   migration. See the `configuration` skill.
6. **Ignoring classpath for `ModuleLayer` / Jigsaw apps.** Eclipse Store uses the classic
   classpath model. Running on the modulepath without an `automatic-module-name` kludge
   occasionally surprises people. If the user hits a `ServiceConfigurationError` at
   startup, suspect modulepath issues first.

## Interactions with other skills

- **`root-and-object-graph`** — the decision "what goes in the root?" and the
  `defaultRoot` / `customRoot` trade-off happens right around `.start()`. Route there
  once the user has the bootstrap working.
- **`configuration`** — once the user outgrows the two-argument `start(root, dir)` call.
- **`spring-boot`** — for Spring apps the bootstrap is handled by the starter; this
  skill's patterns do not apply.
- **`custom-type-handlers`** — anything that must be registered before `.start()` lives
  there.

## Recipes

**"How do I start Eclipse Store with defaults?"** → `EmbeddedStorage.start()`. No args.
Directory is `./storage`; root is null until you `setRoot()`.

**"How do I specify the data directory?"** →
`EmbeddedStorage.start(root, Paths.get("my/path"))`.

**"How do I check whether the database already has data?"** → After `.start()`, inspect
your own root object. If it came back with its `new`-constructed defaults, the database
was empty. If it came back with persisted values, it had data. There is no "is-empty"
method — that is by design; your root is the source of truth.

**"How do I write 'fresh DB → seed it; existing DB → reuse the loaded root'?"** →
`storage.ensureRoot(DataRoot::new)`. Start the manager without a root
(`EmbeddedStorage.start(dir)`), then call `ensureRoot` with a supplier — the supplier
is invoked only on the fresh-DB branch, and `setRoot + storeRoot` happen automatically.
This is the explicit form of the implicit "pass an instance to `start(root, dir)` and
let it populate fields in place" pattern.

**"How do I shut down cleanly in a test?"** → Use try-with-resources (Pattern C).

**"How do I run two databases?"** → Two managers, two distinct directories. See
Pattern D.

**"Can I `.start()` the same manager twice?"** → No. `EmbeddedStorage.start(...)`
returns an already-started manager. Don't call any re-start method on it.

**"Where is the lock file?"** → `<storage-dir>/used.lock`. Eclipse Store deletes it on
clean shutdown. If a previous run crashed, the next `.start()` recovers cleanly — you do
not need to delete it by hand. Deleting it while a manager is live breaks things.

**"How do I bootstrap from a configuration file instead of code?"** → Route to
`configuration` skill; use `EmbeddedStorageConfiguration.load(...)` from the
`storage-embedded-configuration` artifact.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — every overload of `EmbeddedStorage.start(...)` and
  every `EmbeddedStorageManager` method grouped by concern.
- `references/examples-expanded.md` — three full runnable bootstraps: minimal,
  foundation, two-database JVM.
- `references/pitfalls-deep-dive.md` — each pitfall above with root-cause analysis and
  minimal-reproducer + fix.

## Upstream sources

- `docs/modules/storage/pages/getting-started.adoc` — canonical upstream walkthrough.
- `docs/modules/storage/pages/application-life-cycle.adoc` — authoritative on crash
  safety and `shutdown()` semantics.
- `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorage.java`
  — the factory with all `start(...)` overloads.
- `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorageManager.java`
  — the manager interface.
- `examples/helloworld/` — the two-class hello world Eclipse Store ships.
