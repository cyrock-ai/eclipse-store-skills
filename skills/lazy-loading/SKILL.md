---
name: lazy-loading
description: >
  Guide Claude on deferred (lazy) loading of object graphs in Eclipse Store using
  `Lazy<T>` references and lazy collections (`LazyArrayList`, `LazyHashMap`,
  `LazyHashSet`).

  **Apply this skill whenever a new field, collection, or sub-aggregate is
  added to the persistent model**, or whenever an existing aggregate is being
  reviewed for memory/startup behavior. `Lazy<T>` placement is a field-level
  model decision: deciding *not* to wrap a field is itself a decision (the
  whole subgraph loads at startup), and retrofitting `Lazy<>` later requires
  touching every reader of that field. Audit logs, history, attachments,
  blobs, "all events", "all orders ever", time-series data — these are
  textbook lazy candidates that should be marked at design time, not
  retrofitted when startup goes slow. Load this skill when sketching entities
  with potentially large sub-graphs.

  Also use this skill when the user asks to "use Lazy<T>", "lazy load a list",
  "defer loading", "on-demand load", "memory efficient graph", "clear a Lazy
  reference", "LazyReferenceManager", "unload data from memory", "Lazy.Reference",
  "LazyArrayList", "LazyHashMap", "lazy collections", or needs help deciding
  which subgraphs to wrap in `Lazy<>` to speed up startup and cap RAM usage.
version: 0.2.0
---

# Eclipse Store — Lazy Loading with `Lazy<T>` and Lazy Collections

Eclipse Store loads the root object and everything reachable from it on startup by
default. For large graphs that means slow start and high memory. `Lazy<T>` and the lazy
collections are how you defer loads until needed — and how you let the JVM GC reclaim
loaded subgraphs when memory is tight.

## Do NOT use this skill

- Deferred **storing** is a different concept; lazy storer strategies → `storing-data`.
- Whole subgraph is small and `Lazy<>` won't help → `root-and-object-graph`.
- JCache / cross-process caching → `cache-jcache`.

## Mental model

`Lazy<T>` is a **reference intermediary**. It holds one of two things at any moment:

- a loaded Java reference to a `T` (in-memory, ready to use), or
- an object id (not loaded; the `T` is on disk).

`.get()` returns the `T`, transparently reloading from storage if necessary.
`.clear()` discards the in-memory reference but keeps the id, so the next `.get()`
reloads.

There is **no proxy, no bytecode magic, no annotation**. `Lazy<T>` is a plain class
that holds the id and the optional hard reference. That's why the field type must
*actually be* `Lazy<ArrayList<Turnover>>`, not `@Lazy ArrayList<Turnover>` — the field
type is the extension point.

### Similar but distinct things

- `Lazy<T>` — one lazy reference to one T. For collections or subgraphs.
- `LazyArrayList<E>` / `LazyHashMap<K,V>` / `LazyHashSet<E>` — collections stored in
  segments, where segments are themselves lazy. You use them like normal collections;
  they load segments on demand.
- Lazy *storing* (`createLazyStorer`) — **different concept that shares a word**.
  Lazy *loading* (this skill) defers reading objects from storage into RAM until
  they are accessed. Lazy *storing* controls how `store()` traverses the object
  graph when *writing* — specifically, whether already-registered child
  references are descended into or skipped. Two unrelated mechanisms; do not
  conflate them. See `storing-data` for the storing-side treatment.

## Core API

From `org.eclipse.serializer.reference`:

| Symbol | Purpose |
|---|---|
| `Lazy<T>` | The reference intermediary. |
| `Lazy.Reference(T value)` | Factory — wraps an existing value. Value may be null. |
| `lazy.get()` | Returns T. Loads from storage if cleared. NPE if `lazy` itself is null. |
| `Lazy.get(Lazy<T>)` | Static null-safe variant — returns null if the lazy is null. |
| `lazy.clear()` | Drops the hard reference, keeps the id. Returns the previous hard reference (or `null` if not loaded). |
| `lazy.isLoaded()` | Whether the hard reference is currently held. |
| `lazy.isStored()` | Whether the value has ever been persisted (has an id). |
| `lazy.peek()` | Returns the current hard reference without loading (may be null). |
| `LazyReferenceManager` | Background timeout-based clearer. |
| `LazyReferenceManager.set(LazyReferenceManager)` | Install a custom manager. |
| `Lazy.Checker(long millisTimeout, double memoryQuota)` | Pre-built checker. |

From `org.eclipse.serializer.collections.lazy` (in the `serializer/base` module):

| Symbol | Purpose |
|---|---|
| `LazyArrayList<E>` | Segmented list; segments are lazy. |
| `LazyHashMap<K,V>` | Segmented map; segments lazy; b-tree access. |
| `LazyHashSet<E>` | Segmented set. |

## Idiomatic patterns

### Pattern A — Lazy-wrap a large child collection

From the upstream example ("business years, millions of turnovers per year, load only
the current one"):

```java
public class BusinessYear {
    private Lazy<ArrayList<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());

    public ArrayList<Turnover> turnovers() {
        return this.turnovers.get();   // loads on first call; subsequent calls are free
    }
}
```

Rules:

- The field **must** be typed `Lazy<ArrayList<Turnover>>`, not `ArrayList<Turnover>`.
  Generic type is not an annotation marker.
- Initialize with `Lazy.Reference(...)` (even `Lazy.Reference(null)` is fine — the
  outer `Lazy` is still stored).
- Store changes by storing **the inner collection**:
  `storage.store(year.turnovers())`. Storing the `Lazy` itself just stores its id — not
  what you want when the list has changed.

### Pattern B — Null-safe access with `Lazy.get(...)`

If the field can legitimately be null (some business years don't have an entry at
all), prefer the static null-safe accessor:

```java
public ArrayList<Turnover> turnovers() {
    return Lazy.get(this.turnovers);   // returns null if `this.turnovers` is null
}
```

This avoids sprinkling `== null ? null : …` all over the code.

### Pattern C — Manual `.clear()` to release memory

For a one-shot tool that walks history and can afford to drop loaded subgraphs:

```java
for (BusinessYear y : root.years().values()) {
    process(y.turnovers());
    // done with this year — let the GC reclaim it
    ((Lazy<?>) getLazyField(y)).clear();
}
```

Accessing the Lazy reference to clear it is awkward — if you do this often, expose the
Lazy field via a getter named `turnoversLazy()` or similar. Most apps rely on the
automatic `LazyReferenceManager` instead (Pattern D).

### Pattern D — Configure automatic clearing

The default `LazyReferenceManager` clears references untouched for 15 minutes. Tune it:

```java
import java.time.Duration;
import org.eclipse.serializer.reference.Lazy;
import org.eclipse.serializer.reference.LazyReferenceManager;

// Must be set BEFORE any storage starts.
LazyReferenceManager.set(LazyReferenceManager.New(
    Lazy.Checker(
        Duration.ofMinutes(30).toMillis(),   // clear after 30 min idle
        0.75                                  // or when heap is 75% full
    )
));

EmbeddedStorageManager storage = EmbeddedStorage.start(root, dir);
```

The checker combines timeout with memory quota. Either condition will clear stale
references.

### Pattern E — Lazy collections (segmented)

When one collection is itself so huge that wrapping it in `Lazy<>` would still mean
loading the whole thing on first access, use the segmented implementations:

```java
public class AppRoot {
    private final LazyArrayList<Event> events = new LazyArrayList<>();
    private final LazyHashMap<String, Customer> customers = new LazyHashMap<>();

    public LazyArrayList<Event> events() { return events; }
    public LazyHashMap<String, Customer> customers() { return customers; }
}
```

They implement `List` / `Map` / `Set`, so call sites look normal:

```java
Customer c = root.customers().get("alice@acme.com");   // loads only the segment
```

Rules:

- Default segment size is 1000. Pass an int to the constructor to override. **Do not**
  go below 100 or above 1,000,000 — both hurt performance.
- `.size()` is cached, so it is free even if nothing is loaded.
- `LazyHashMap.get(key)` loads at most `log2(numSegments)` segments (b-tree lookup).

### Pattern F — Checking load state

```java
if (year.turnoversLazy().isLoaded()) {
    // in memory; work quickly
}
T hard = year.turnoversLazy().peek();   // current reference without loading
```

Use sparingly — it's often a sign that you're fighting the library instead of just
calling `.get()`.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Wrong field type

```java
// WRONG
@Lazy
private ArrayList<Turnover> turnovers = new ArrayList<>();
```

There is no `@Lazy` annotation. The field type must literally be `Lazy<ArrayList<T>>`.

### Anti-pattern 2 — Calling `.get()` on a null `Lazy`

```java
// WRONG
public ArrayList<Turnover> turnovers() {
    return this.turnovers.get();   // NPE if `this.turnovers == null`
}
```

Use `Lazy.get(this.turnovers)` unless you know the field is never null.

### Anti-pattern 3 — Storing the `Lazy` when the inner collection changed

```java
// WRONG
year.turnovers().add(t);
storage.store(year.turnoversLazy());   // only stores the lazy wrapper (its id)
```

The Lazy wrapper's state (id) didn't change; only the inner list did. Store the
inner list instead, same rule as `storing-data`:

```java
storage.store(year.turnovers());   // stores the modified ArrayList
```

### Anti-pattern 4 — Wrapping too finely

```java
// WRONG
public class Customer {
    private Lazy<String>  email;
    private Lazy<Integer> age;
}
```

`Lazy<>` has an overhead per instance (one extra entity in storage, one id, one
wrapper object). Wrapping primitives or small strings is all cost, no benefit.

Wrap **collections or heavy subgraphs**. Anything smaller than a few KB isn't worth
it.

### Anti-pattern 5 — Replacing a Lazy field

```java
// WRONG
year.turnovers = Lazy.Reference(new ArrayList<>());   // throws away the loaded data
```

You've orphaned the old Lazy (and the collection it points to). On the next store
round, that old chain becomes garbage. If you meant to empty the list, call
`year.turnovers().clear()` and store `year.turnovers()`.

### Anti-pattern 6 — Sharing a `Lazy` across two storages

From the upstream docs: a `Lazy` instance is bound to its storage on first
persistence. Passing it to a second, different storage manager throws.

## Pitfalls & gotchas

1. **`Lazy<>` typed as interface** — wrap concrete types: `Lazy<ArrayList<Turnover>>`,
   not `Lazy<List<Turnover>>`. You lose the specialized type handler for `ArrayList`
   otherwise, and serialization becomes less efficient.
2. **Lazy wrappers are not transparent to Eclipse Store's eager cascade.** An eager
   storer walks through `.get()` — it will trigger a load if the lazy is cleared. If
   you do not want that, don't use an eager storer on that subgraph.
3. **`.clear()` doesn't immediately free memory.** The Swizzle Registry keeps a weak
   reference; the JVM GC is still the one that actually frees memory. Under memory
   pressure, it will.
4. **The default `LazyReferenceManager` timeout (15 min) is aggressive for
   interactive apps.** Common: tune it to 2-4 hours, or disable it and clear manually.
5. **Lazy collections and iteration.** Iterating a `LazyArrayList` loads all segments.
   If you want to iterate a million-element list, load it into a stream and process
   in chunks — or keep it in segments and access by index.
6. **Lazy collections bind to their first storage.** Serializing a
   `LazyArrayList` into a second storage throws. If you need data portability, copy
   into a plain `ArrayList` first.
7. **Forgetting `Lazy.Reference` initialization.** A bare `private Lazy<...> x;` stores
   a null slot. First `.get()` returns null (ok) — but if the field is final and you
   forgot to initialize it you get a compile error.
8. **Not wrapping the collection type you store.** If the list is a `LinkedList` but
   you wrap it as `Lazy<ArrayList<E>>`, you'll get a `ClassCastException` on load.
   Field generic types and the actual instance class must match.

## Decision guide

| Situation | Use |
|---|---|
| Large per-item subgraph (customer → order history) | `Lazy<ArrayList<Order>>` on the parent |
| Top-level collection that dominates memory | `LazyArrayList` / `LazyHashMap` |
| Individual heavy object (a blob, report, image) | `Lazy<BigObject>` |
| Small field (primitive, String) | Don't wrap |
| Want to avoid loading N-th business year | `Lazy<ArrayList<Turnover>>` per year |
| Want to stream through millions of records without holding all in RAM | `LazyArrayList` + targeted index lookup |

## Interactions with other skills

- **`storing-data`** — storing a Lazy subgraph follows the same "store the modified
  object" rule. The inner collection is the modified object.
- **`root-and-object-graph`** — `Lazy<>` fields on the root are the main tool for
  keeping startup fast.
- **`housekeeping-and-deletion`** — clearing a Lazy doesn't delete anything from
  storage; it frees heap. Deletion is a separate topic.
- **`gigamap`** — a very different tool: a single indexed collection for billions of
  entries with query semantics. Use GigaMap when you need index-based access;
  Lazy/LazyCollections when you just need deferred loading.
- **`cache-jcache`** — JCache is about cross-process / cross-session caching on top of
  storage. Lazy is for intra-process heap management.

## Recipes

**"My startup takes 30 seconds."** → Find the top-level fields and wrap the biggest
ones in `Lazy<>`. Typical targets: audit log, message history, old business year,
attachments, event stream.

**"What's the minimal Lazy-wrapping?"**

```java
private Lazy<ArrayList<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());
public ArrayList<Turnover> turnovers() { return Lazy.get(this.turnovers); }
```

**"Does calling `.get()` twice load twice?"** → No. Once loaded, the reference is held.
Only `.clear()` + GC drops it.

**"How do I test Lazy behavior?"** → Tests often want deterministic loading — either
avoid `LazyReferenceManager` in tests (install a no-op checker) or call `.clear()`
explicitly between operations.

**"Can I wrap a `Map` as `Lazy<HashMap<K,V>>`?"** → Yes — but if the map is large and
most accesses hit only a few keys, `LazyHashMap` is a better choice because it only
loads the relevant segments.

**"Does Eclipse Store load Lazy children on eager store?"** → Yes — the eager storer
walks `.get()` which loads them. Plan accordingly.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a `Lazy` method not in the
  in-line Core API table (e.g. `Lazy.peek(Lazy<?>)` / `Lazy.isStored(Lazy<?>)` /
  `Lazy.isLoaded(Lazy<?>)` static null-safe variants, `Lazy.UnregisteredReference`,
  the full `LazyReferenceManager.New(...)` overload set, or the segmented-collection
  constructor rules.
- **Load `references/examples-expanded.md`** when you want a complete runnable
  template — canonical per-year lazy list, null-safe accessor, custom
  `LazyReferenceManager` bootstrap, `LazyArrayList` ingest with `BatchStorer`, batch
  scanner with explicit clearing, lazy-collection-over-`Map` done right.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a lazy bug — NPE on
  null Lazy, "modification not persisted" after storing the wrapper, default
  manager timeout clearing mid-job, `IllegalStateException` crossing storages,
  iteration eagerly loading all segments.

## Upstream sources

- `docs/modules/storage/pages/loading-data/lazy-loading/index.adoc` — primary walkthrough.
- `docs/modules/storage/pages/loading-data/lazy-loading/clearing-lazy-references.adoc`
  — manual/automatic clearing.
- `docs/modules/storage/pages/loading-data/lazy-loading/lazy-collections.adoc` —
  `LazyArrayList`, `LazyHashMap`, `LazyHashSet`.
- `docs/modules/storage/pages/loading-data/lazy-loading/touched-timestamp-null-safe-variant.adoc`
  — touched-timestamp mechanics.
- `examples/lazy-loading/` — runnable upstream example.
