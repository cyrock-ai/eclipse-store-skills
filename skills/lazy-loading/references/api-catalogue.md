# API catalogue — lazy-loading

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `org.eclipse.serializer.reference.Lazy<T>`

### Factories (instance)

| Factory | Purpose |
|---|---|
| `Lazy.Reference(T value)` | Wraps `value` (may be null). |
| `Lazy.New(T value)` | Alias of `Reference`. |

### Instance methods

| Method | Notes |
|---|---|
| `T get()` | Returns the value, loading if necessary. NPE if `this == null`. |
| `T peek()` | Returns the current hard reference without loading. May be null. |
| `void clear()` | Releases the hard reference; keeps the object id. |
| `boolean isLoaded()` | Whether a hard reference is currently held. |
| `boolean isStored()` | Whether the value has ever been persisted. |
| `long objectId()` | Storage id of the referenced entity; 0 if never stored. |
| `long lastTouched()` | Timestamp (epoch ms) of the last `.get()`. |

### Static null-safe accessor

| Method | Purpose |
|---|---|
| `static <T> T Lazy.get(Lazy<T>)` | Returns null if the argument is null; else `.get()`. |

### Static checker factory

| Method | Purpose |
|---|---|
| `static Checker Lazy.Checker(long timeoutMs)` | Time-based. |
| `static Checker Lazy.Checker(long timeoutMs, double memoryQuota)` | Time + memory. |

`Checker` is the policy object plugged into `LazyReferenceManager`.

## `LazyReferenceManager`

File: `persistence/binary/…` — precise path: `base/src/main/java/org/eclipse/serializer/reference/LazyReferenceManager.java`.

| Method | Notes |
|---|---|
| `static LazyReferenceManager New(Checker c)` | Build a new manager using the given checker. |
| `static LazyReferenceManager New(Checker c, Duration cycleTime)` | With custom cycle time. |
| `static void set(LazyReferenceManager)` | Install as the global manager. Must happen **before** any storage starts. |
| `static LazyReferenceManager get()` | Current global manager. |
| `void checkAll()` | Run a single check pass now. |
| `void start()` / `stop()` | Control the background daemon. |
| `void addLazy(Lazy<?>)` | Register a Lazy reference (normally done automatically). |

The default manager uses `Lazy.Checker(1_000_000L)` — 1 M ms ≈ 16.6 min.

## Lazy collections

Package: `org.eclipse.serializer.collections.lazy` / implementations under storage module.

| Class | Extends | Default segment size |
|---|---|---|
| `LazyArrayList<E>` | `java.util.AbstractList<E>` | 1000 |
| `LazyHashMap<K,V>` | `java.util.AbstractMap<K,V>` | 1000 |
| `LazyHashSet<E>` | `java.util.AbstractSet<E>` | 1000 |

### Constructors

Each has:
- `new LazyArrayList<>()` — default segment size.
- `new LazyArrayList<>(int segmentSize)` — explicit.

Rules for segment size:

- Default (1000) is a good starting point.
- `< 100` — too many segments, metadata overhead dominates.
- `> 1_000_000` — segments get large, the lazy unit is coarse.

### Notable methods

All standard `List`/`Map`/`Set` methods work. A few specifics:

- `size()` is cached; does not trigger segment loads.
- `LazyHashMap.get(key)` loads at most `log2(n_segments)` segments.
- Iteration loads segments eagerly, one after another. For very large collections,
  consider iterating in batches by index or stream with care.

### Binding

Once persisted, a lazy collection is bound to its storage manager. Attempting to store
it into a different storage throws `IllegalStateException`.

## Interaction with storers

- Default (lazy) storer: does not walk into `.get()`. Storing a `Lazy<>` wrapper only
  stores the wrapper.
- Eager storer: walks `.get()`, which loads the target if cleared. Use carefully —
  this can load the entire lazy subgraph you were trying to keep off heap.
- `BatchStorer`: lazy by default (same as the default storer).

## Relationship with the Swizzle Registry

The Swizzle Registry is a JVM-wide bijective id↔instance registry. `Lazy.clear()`
removes the hard reference but the Swizzle Registry holds a `WeakReference`; the JVM
GC is responsible for actual memory reclamation. If memory isn't pressured, cleared
Lazy references may still resolve via the registry without a disk read.

## Summary table — pick your tool

| Need | Use |
|---|---|
| Defer loading of one subgraph | `Lazy<T>` field |
| Defer loading of a huge List | `LazyArrayList<E>` |
| Defer loading of a huge Map | `LazyHashMap<K,V>` |
| Clear one subgraph from memory | `lazy.clear()` |
| Clear idle subgraphs automatically | `LazyReferenceManager` with custom `Checker` |
| Check whether a subgraph is loaded | `lazy.isLoaded()` / `peek()` |
| Null-safe read | `Lazy.get(lazy)` |
