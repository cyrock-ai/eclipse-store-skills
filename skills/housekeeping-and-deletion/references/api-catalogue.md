# API catalogue — housekeeping-and-deletion

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## Manual housekeeping — `StorageConnection` / `EmbeddedStorageManager`

File: `storage/base/src/main/java/org/eclipse/store/storage/types/StorageConnection.java`.

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
| `boolean issueCacheCheck(long nanoTimeBudget)` | Yes, up to budget | Returns true if done. |
| `boolean issueCacheCheck(long nanoTimeBudget, StorageEntityCacheEvaluator)` | Yes, up to budget | |

### File check (compaction)

| Method | Blocks? | Notes |
|---|---|---|
| `void issueFullFileCheck()` | Yes | Full pass using the default `StorageDataFileEvaluator`. |
| `void issueFullFileCheck(StorageDataFileEvaluator)` | Yes | |
| `boolean issueFileCheck(long nanoTimeBudget)` | Yes, up to budget | |
| `boolean issueFileCheck(long nanoTimeBudget, StorageDataFileEvaluator)` | Yes, up to budget | |

All `issue*` calls run on the calling thread via a connection. Don't call from an HTTP
or message-handler thread you care about blocking.

## Evaluators (custom housekeeping policy)

### `StorageEntityCacheEvaluator`

File: `storage/base/.../StorageEntityCacheEvaluator.java`.

Decides whether a cached entity's data should be evicted. Factory:

```java
StorageEntityCacheEvaluator.New(long threshold, long timeoutMillis);
```

Default is `New(1_000_000_000L, 86_400_000L)` ≈ 24 h.

### `StorageDataFileEvaluator`

File: `storage/base/.../StorageDataFileEvaluator.java`.

Decides whether a data file should be retired (compacted). Factory:

```java
StorageDataFileEvaluator.New(
    long    fileMinimumSize,   // default 1 MiB
    long    fileMaximumSize,   // default 8 MiB
    double  minimumUseRatio,   // default 0.75
    boolean cleanupHeadFile    // default false
);
```

Use a custom one when you want to suppress compaction for specific files (e.g., very
large reports) or apply different thresholds at different times (e.g., during off-peak
hours).

### `StorageHousekeepingController`

File: `storage/base/.../StorageHousekeepingController.java`.

Supplies interval + budget. Factory:

```java
StorageHousekeepingController.New(long interval, long budget);
StorageHousekeepingController.Adaptive(...);
```

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
