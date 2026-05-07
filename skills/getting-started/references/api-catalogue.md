# API catalogue — getting-started

All symbols are in `org.eclipse.store.storage.embedded.types` unless noted.

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `EmbeddedStorage` (factory)

File: `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorage.java`

### `start(...)` overloads — builds and starts a manager in one call

| Signature | Notes |
|---|---|
| `start()` | Root = null, directory = `./storage`. |
| `start(Path directory)` | Root = null. |
| `start(ADirectory directory)` | `ADirectory` from the AFS module — for S3/Azure/Redis/etc. See `storage-targets-afs`. |
| `start(StorageConfiguration config)` | Programmatic config; root = null. |
| `start(StorageConfiguration.Builder<?> builder)` | Fluent builder config. |
| `start(StorageConfiguration, EmbeddedStorageConnectionFoundation<?>)` | Advanced — custom connection foundation for custom type handlers etc. |
| `start(Object root)` | Directory = `./storage`. |
| `start(Object root, Path directory)` | **Canonical form.** |
| `start(Object root, ADirectory directory)` | AFS variant. |
| `start(Object root, StorageConfiguration config)` | |
| `start(Object root, StorageConfiguration.Builder<?> builder)` | |
| `start(Object root, StorageConfiguration, EmbeddedStorageConnectionFoundation<?>)` | |

### `Foundation(...)` overloads — returns an unstarted `EmbeddedStorageFoundation<?>`

Use when you need to customize **before** start: type handlers, root resolver,
persistence manager, etc.

| Signature | Notes |
|---|---|
| `Foundation()` | Defaults. |
| `Foundation(Path directory)` | |
| `Foundation(ADirectory directory)` | |
| `Foundation(StorageConfiguration config)` | |
| `Foundation(StorageConfiguration.Builder<?> builder)` | |
| `Foundation(StorageConfiguration, EmbeddedStorageConnectionFoundation<?>)` | |

On the foundation:

- `foundation.onConnectionFoundation(cf -> cf.registerCustomTypeHandler(...))` —
  register custom handlers.
- `foundation.setConfiguration(...)` — swap configuration.
- `foundation.start()` — build + start (manager has null root).
- `foundation.start(Object root)` — build + start with root.

## `EmbeddedStorageManager` (the runtime handle)

File: `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorageManager.java`

Extends `StorageManager`, which extends `StorageController`, `StorageConnection`, `DatabasePart`. `StorageController` extends `AutoCloseable`.

### Root access

| Method | Purpose |
|---|---|
| `Object root()` | Current root. Null if never set. |
| `<R> R setRoot(R)` | Replace the in-memory root reference. Returns the passed `newRoot` for fluent chaining. Not persisted until the next `storeRoot()`. |
| `<R> R ensureRoot(Supplier<R>)` | If `root()` is null, invokes the supplier, calls `setRoot` + `storeRoot`. If a root is already loaded, the supplier is **not** called and storage is not modified. Auto-starts the manager if not running. Returns the resulting root. |
| `long storeRoot()` | Persist the root object. Returns the storage object id. |

### General store / load (covered in `storing-data`)

| Method | Purpose |
|---|---|
| `long store(Object)` | Persist any object in the graph. |
| `long[] storeAll(Object...)` | Persist multiple. |
| `Storer createStorer()` | Create a configurable storer (eager, batch, etc.). |

### Lifecycle

| Method | Purpose |
|---|---|
| `EmbeddedStorageManager start()` | (Re)start managing threads. Already called by `EmbeddedStorage.start(...)`. |
| `boolean shutdown()` | Stop managing threads, release file locks. |
| `boolean isRunning()` | Inspect state. |
| `boolean isAcceptingTasks()` | Whether the manager accepts new operations. |
| `void close()` | `AutoCloseable` alias for `shutdown()`. |

### Maintenance (covered in `housekeeping-and-deletion`)

| Method | Purpose |
|---|---|
| `StorageConnection createConnection()` | New connection; its `issue*` methods drive manual GC / cache check / file check. |
| `void issueFullGarbageCollection()` | Run full GC now. |
| `boolean issueGarbageCollection(long nanoTimeBudget)` | Time-boxed GC. |
| `void issueFullCacheCheck()` / `issueFullCacheCheck(CacheEvaluator)` | Full cache eviction pass. |
| `void issueFullFileCheck()` / with evaluator | Full file compaction pass. |

## Configuration artifact — `storage-embedded-configuration`

Adds the INI/XML/properties loaders. Only pull this in if you plan to use them; see the
`configuration` skill for usage.

- `EmbeddedStorageConfiguration` — fluent builder and `load(...)` entry points.
- `EmbeddedStorageConfigurationBuilder` — builder interface.
- `EmbeddedStorageConfigurationPropertyNames` — constants for property keys.

## Version / Java baseline

- Minimum JDK: **17** (per `pom.xml` `maven-compiler-plugin` configuration).
- Main-line maven groupId: `org.eclipse.store`.
- Current maven artifact version: track `{maven-version}` from upstream docs at
  https://docs.eclipsestore.io.
