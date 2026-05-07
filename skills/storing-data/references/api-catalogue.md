# API catalogue — storing-data

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `EmbeddedStorageManager` — store methods

File: `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorageManager.java` (inherits from `StorageConnection`).

| Signature | Returns | Semantics |
|---|---|---|
| `long store(Object instance)` | object id | Stores `instance` + newly-encountered children (lazy). |
| `long[] storeAll(Object... instances)` | object ids | Same, for each element. The array itself is not stored. |
| `void storeAll(Iterable<?> instances)` | — | Same, for each element. The iterable itself is not stored. **Returns `void`** — no objectIds. |
| `long storeRoot()` | object id | Stores the root instance. |
| `Storer createStorer()` | `Storer` | Default (lazy) storer. |
| `Storer createLazyStorer()` | `Storer` | Explicit lazy. |
| `Storer createEagerStorer()` | `Storer` | Eager — stores every reachable object, even if previously persisted. |
| `BatchStorer.Builder batchStorerBuilder()` | builder | For high-throughput ingest. |

## `Storer`

File: `serializer/persistence/persistence/src/main/java/org/eclipse/serializer/persistence/types/Storer.java`
(in the *serializer* repo). Declaration: `interface Storer extends PersistenceStoring`.

| Method | Purpose |
|---|---|
| `long store(Object)` | Enqueue (does **not** write yet). Returns the assigned objectId. |
| `long[] storeAll(Object...)` | Enqueue many; returns objectIds in order. |
| `void storeAll(Iterable<?>)` | Enqueue many. Returns `void`. |
| `Object commit()` | Flush atomically. Implementation-specific status info, may be `null`. |
| `void clear()` | Discard accumulated state since the last `commit()` (pending stores + skips). |
| `long size()` / `boolean isEmpty()` | Unique instances/skips registered so far. |
| `long currentCapacity()` / `long maximumCapacity()` | Internal capacity tuning. |
| `Storer reinitialize()` / `Storer reinitialize(long initialCapacity)` | Discard previous state; reset for reuse. |
| `Storer ensureCapacity(long)` | Best-effort capacity hint. |
| `boolean skip(Object)` / `boolean skipMapped(Object, long)` / `boolean skipNulled(Object)` | Mark instances skipped during traversal — advanced (ID re-mapping, migrations). |
| `void registerCommitListener(PersistenceCommitListener)` | Post-commit hook. |
| `void registerRegistrationListener(PersistenceObjectRegistrationListener)` | Per-object id-assignment hook (lives on `Storer` — no cast needed). |

A `Storer` is **not** thread-safe. Use one per thread, or serialize access.

## `BatchStorer`

File: `serializer/persistence/persistence/src/main/java/org/eclipse/serializer/persistence/types/BatchStorer.java`
(in the *serializer* repo). Declaration:
`interface BatchStorer extends PersistenceStorer, AutoCloseable`
(with `PersistenceStorer extends Storer`).

### Builder

Obtain via `storageManager.batchStorerBuilder()` (default method on `Persister`).

| Method | Default | Notes |
|---|---|---|
| `maxSize(long)` | — | Flush after this many pending objects. Must be `> 0`. |
| `flushCycle(Duration)` | — | Flush after this much time since last flush. Must be `> 0ms`. |
| `checkInterval(Duration)` | `1s` | How often the daemon checks whether to flush. |
| `build()` | — | Throws `IllegalStateException` if neither `maxSize` nor `flushCycle` is set. |

### Runtime

| Method | Purpose |
|---|---|
| `long store(Object)` | Enqueue; may trigger a flush based on thresholds. |
| `long[] storeAll(Object...)` | Enqueue many. |
| `void storeAll(Iterable<?>)` | Enqueue many. Returns `void`. |
| `void flush()` | Force flush now. |
| `boolean hasPendingData()` | Inspect. |
| `Object commit()` | Inherited from `Storer` — flush + release; impl-specific status (may be `null`). |
| `void close()` | `AutoCloseable` — flushes remaining and stops the daemon. |

Implements `AutoCloseable`. Always use try-with-resources.

## Eager field evaluation

Interface: `PersistenceEagerStoringFieldEvaluator` in `persistence/base`.

```java
@FunctionalInterface
public interface PersistenceEagerStoringFieldEvaluator {
    boolean isEagerStoring(Class<?> entityType, Field field);
}
```

Set on the connection foundation:

```java
EmbeddedStorage.Foundation(cfg)
    .onConnectionFoundation(cf -> cf.setReferenceFieldEagerEvaluator(
        (type, field) -> field.isAnnotationPresent(StoreEagerly.class)
    ))
    .start(root);
```

Must be set before `.start()`.

## Object registration listener

File: `serializer/persistence/persistence/src/main/java/org/eclipse/serializer/persistence/types/PersistenceObjectRegistrationListener.java`.

```java
public interface PersistenceObjectRegistrationListener {
    void onObjectRegistration(long objectID, Object object);
}
```

Register on the `Storer` interface directly — no cast to `BinaryStorer` needed:

```java
Storer s = storage.createStorer();
s.registerRegistrationListener(listener);
s.store(thing);
s.commit();
```

Performance-sensitive; only use when you need to track persisted ids for auditing or
migration.

## Thread-safety reference

| Component | Thread-safe? | Notes |
|---|---|---|
| `EmbeddedStorageManager` | Yes for `start`/`shutdown`/`store` | Application must serialize **mutation + store** under a single lock. |
| Individual `Storer` instance | No | One per thread. |
| `BatchStorer` | No | One per thread. |
| Object graph itself | N/A | Your problem — use application locks. |

## Exceptions

- `org.eclipse.serializer.persistence.exceptions.PersistenceException` — thrown on
  type-dictionary mismatches, IO errors, etc. Root of most store failures.
- `java.lang.IllegalStateException` — misconfigured builders (e.g., BatchStorer without
  thresholds).
- `java.util.ConcurrentModificationException` — collection mutated during
  serialization; sign that locking is missing.
