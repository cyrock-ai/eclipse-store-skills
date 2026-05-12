# API catalogue — lazy-loading

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `org.eclipse.serializer.reference.Lazy<T>`

### Factories (instance)

| Factory | Purpose |
|---|---|
| `Lazy.Reference(T value)` | Wraps `value` (may be null). |

### Instance methods

| Method | Notes |
|---|---|
| `T get()` | Returns the value, loading if necessary. NPE if `this == null`. |
| `T peek()` | Returns the current hard reference without loading. May be null. |
| `T clear()` | Releases the hard reference; keeps the object id. Returns the previous hard reference (or null if not loaded). |
| `boolean isLoaded()` | Whether a hard reference is currently held. |
| `boolean isStored()` | Whether the value has ever been persisted. |
| `long lastTouched()` | Timestamp (epoch ms) of the last `.get()`. |

### Static null-safe variants

| Method | Purpose |
|---|---|
| `static <T> T Lazy.get(Lazy<T>)` | Returns null if the argument is null; else `.get()`. |
| `static <T> T Lazy.peek(Lazy<T>)` | Returns null if the argument is null; else `.peek()`. |
| `static boolean Lazy.isLoaded(Lazy<?>)` | Returns false if the argument is null; else `.isLoaded()`. |
| `static boolean Lazy.isStored(Lazy<?>)` | Returns false if the argument is null; else `.isStored()`. |

### Other static factories

| Method | Purpose |
|---|---|
| `static <T> Lazy<T> Lazy.UnregisteredReference(T value)` | Like `Reference(value)` but does NOT auto-register with the global `LazyReferenceManager`. Use for short-lived or test-scoped Lazy instances that should not be subject to automatic clearing. |

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
| `static LazyReferenceManager New(Checker c, long milliCheckInterval, long nanoTimeBudget)` | With custom interval / budget. |
| `static LazyReferenceManager set(LazyReferenceManager)` | Install as the global manager. Must happen **before** any storage starts. |
| `static LazyReferenceManager get()` | Current global manager. |
| `LazyReferenceManager start()` / `stop()` | Control the background daemon. Returns `this` for chaining. |
| `void register(Lazy<?>)` | Register a Lazy reference (normally done automatically). |

The default manager uses `Lazy.Checker(1_000_000L)` — 1 M ms ≈ 16.6 min.

## Lazy collections

Package: `org.eclipse.serializer.collections.lazy` (in `serializer/base`).

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
