# API catalogue — housekeeping-and-deletion

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## Manual housekeeping — `StorageConnection` / `EmbeddedStorageManager`

File: `storage/storage/src/main/java/org/eclipse/store/storage/types/StorageConnection.java`.

### Garbage collection

| Method | Blocks? | Notes |
|---|---|---|
| `void issueFullGarbageCollection()` | Yes, to completion | Walks the entire persistent graph. Expensive on large graphs. |
| `boolean issueGarbageCollection(long nanoTimeBudget)` | Yes, up to budget | Returns true if GC completed within the budget. Call repeatedly. |

### Cache check

| Method | Blocks? | Notes |
|---|---|---|
| `void issueFullCacheCheck()` | Yes | Full pass using the default `StorageEntityCacheEvaluator`. |
| `void issueFullCacheCheck(StorageEntityCacheEvaluator)` | Yes | With a custom evaluator. |
| `boolean issueCacheCheck(long nanoTimeBudget)` | Yes, up to budget | Returns `true` **iff the used cache size is or became 0**, NOT "did it finish within budget". On a non-empty live cache, expect `false` even after a complete pass. |
| `boolean issueCacheCheck(long nanoTimeBudget, StorageEntityCacheEvaluator)` | Yes, up to budget | Same semantics as above with a custom evaluator. |

### File check (compaction)

| Method | Blocks? | Notes |
|---|---|---|
| `void issueFullFileCheck()` | Yes | Full pass using the configured `StorageDataFileEvaluator`. |
| `boolean issueFileCheck(long nanoTimeBudget)` | Yes, up to budget | Time-boxed; returns true if done. |

All `issue*` calls run on the calling thread via a connection. Don't call from an HTTP
or message-handler thread you care about blocking.

## Evaluators (custom housekeeping policy)

### `StorageEntityCacheEvaluator`

File: `storage/storage/.../StorageEntityCacheEvaluator.java`.

Decides whether a cached entity's data should be evicted. Factory:

```java
StorageEntityCacheEvaluator.New(long timeoutMs, long threshold);
```

Default thresholds: timeout `86_400_000` ms (24 h), threshold `1_000_000_000`.

### `StorageDataFileEvaluator`

File: `storage/storage/.../StorageDataFileEvaluator.java`.

Decides whether a data file should be retired (compacted). Factory:

```java
StorageDataFileEvaluator.New(
    int     fileMinimumSize,   // default 1 MiB
    int     fileMaximumSize,   // default 8 MiB
    double  minimumUseRatio,   // default 0.75
    boolean cleanUpHeadFile    // default false
);
```

Use a custom one when you want to suppress compaction for specific files (e.g., very
large reports) or apply different thresholds at different times (e.g., during off-peak
hours).

### `StorageHousekeepingController`

File: `storage/storage/.../StorageHousekeepingController.java`.

Supplies interval + budget. Factory:

```java
StorageHousekeepingController.New(long intervalMs, long timeBudgetNs);
StorageHousekeepingController.Adaptive(...);
```

Units differ: interval in **milliseconds**, budget in **nanoseconds**. The
`Duration.toNanos()` / `Duration.toMillis()` helpers avoid mistakes.

The adaptive variant raises the budget when GC persistently falls behind. Wire via the
foundation:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf ->
        cf.setHousekeepingController(StorageHousekeepingController.Adaptive(...))
    )
    .start(root);
```

## Deletion — the non-API

There is **no** delete method on `EmbeddedStorageManager`. Deletion is always
"modify the graph, store the parent". The pattern table:

| Situation | Idiom |
|---|---|
| Remove from a collection | `parent.coll().remove(x); storage.store(parent.coll());` |
| Clear a collection | `parent.coll().clear(); storage.store(parent.coll());` |
| Null a field | `parent.setField(null); storage.store(parent);` |
| Remove a `Lazy<T>` | `Lazy.clear(lz); // optional`<br>`parent.setLz(null); storage.store(parent);` |
| Remove from `Map<K, Lazy<V>>` | `Lazy<V> removed = parent.map().remove(k); Lazy.clear(removed); storage.store(parent.map());` |

## `Lazy.clear(Lazy<?>)` — static null-safe helper

```java
public static void clear(Lazy<?> lazy) {
    if (lazy != null) lazy.clear();
}
```

Use this instead of `lz.clear()` when the reference might be null.

## Monitoring hooks (optional)

For observability, wrap `StorageConnection.issueGarbageCollection(...)` with timing
logs during maintenance jobs — Eclipse Store does not ship built-in metrics. REST
interface (`storage-rest`) exposes some counters.
