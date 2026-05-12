# Pitfalls deep-dive — lazy-loading

## 1. `@Lazy` annotation doesn't exist

**Reproducer.**

```java
public class BusinessYear {
    @Lazy
    private ArrayList<Turnover> turnovers = new ArrayList<>();
}
```

**Symptom.** Compile error (no such annotation in the Eclipse Store import set) — or,
if the developer defined a local `@Lazy`, silent no-op at runtime: the list is eagerly
loaded because there is no `Lazy<>` wrapper.

**Root cause.** Eclipse Store uses a type-based marker, not an annotation. The field
type itself must be `Lazy<ArrayList<Turnover>>`.

**Fix.**

```java
private Lazy<ArrayList<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());
```

## 2. `this.turnovers.get()` NPE when the Lazy field is null

**Reproducer.**

```java
private Lazy<ArrayList<Turnover>> turnovers;   // not initialized
public ArrayList<Turnover> turnovers() { return this.turnovers.get(); }
```

**Symptom.** `NullPointerException` on first access.

**Root cause.** The Lazy reference itself is null (distinct from Lazy wrapping null).

**Fix.** Use `Lazy.get(this.turnovers)` — returns null if the wrapper is null.

```java
public ArrayList<Turnover> turnovers() { return Lazy.get(this.turnovers); }
```

## 3. Storing the Lazy wrapper instead of the inner collection

**Reproducer.**

```java
year.turnovers().add(t);
storage.store(year.turnoversLazy());   // stores the Lazy wrapper's id
```

**Symptom.** New turnover not persisted.

**Root cause.** The Lazy wrapper's fields (id, target reference) are unchanged. The
*inner collection* is what grew.

**Fix.**

```java
storage.store(year.turnovers());   // stores the ArrayList
```

## 4. Generic type is an interface instead of a concrete class

**Reproducer.**

```java
private Lazy<List<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());
```

**Symptom.** Larger on-disk footprint; slower load; may miss the specialized
`ArrayList` handler.

**Root cause.** Eclipse Store's specialized handlers are registered for concrete
classes like `ArrayList`, `HashMap`. Interface types fall back to generic analysis.

**Fix.**

```java
private Lazy<ArrayList<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());
```

The generic type of the Lazy parameter should match the concrete class you actually
store.

## 5. Lazy wrapper getting cleared in the middle of a long operation

**Reproducer.** A 20-minute batch job calls `year.turnovers()` at the start and assumes
the list stays loaded.

**Symptom.** Halfway through, the default `LazyReferenceManager` clears references
untouched for 15 minutes; subsequent field reads trigger re-loads.

**Root cause.** The default timeout is 15 min. `.get()` resets the touched-timestamp;
if the job doesn't call `.get()` often, the reference can be cleared.

**Fix.** Either install a longer-timeout `LazyReferenceManager` for the duration of
the job (Pattern D in SKILL.md), or re-fetch via `.get()` when you need the
collection — it's idempotent if loaded, cheap if not.

## 6. Memory quota clearing while the graph is "active"

**Reproducer.** JVM heap is small; the memory-quota-based checker
(`Lazy.Checker(timeout, 0.75)`) is triggered even during interactive work.

**Symptom.** Subsequent field accesses reload from disk — visible slowness.

**Root cause.** Memory quota is a last-resort clear; it fires even for recently-touched
references if the heap is pressured. Either the heap is too small or the domain is
bigger than expected.

**Fix.** Raise the heap (`-Xmx`), raise the quota toward 1.0 (meaning only on true
pressure), or move more data behind Lazy so less is in memory at once.

## 7. Using `Lazy<>` on primitive or tiny fields

**Reproducer.**

```java
private Lazy<Integer> count = Lazy.Reference(0);
```

**Symptom.** Slower than a plain `Integer count;`; larger on-disk footprint.

**Root cause.** Each Lazy wrapper is itself an entity stored separately, with an id.
The overhead exceeds any loading savings for small values.

**Fix.** Remove the wrapper. Use Lazy only for collections or heavy subgraphs.

## 8. Iterating a `LazyArrayList` eagerly

**Reproducer.**

```java
for (Event e : root.events()) {   // forces segment loads in sequence
    process(e);
}
```

**Symptom.** Memory fills up; first run OK, second run slower.

**Root cause.** Full iteration walks every segment, loading each before moving on.
Without a `LazyReferenceManager` that clears aggressively, loaded segments linger.

**Fix.** Either tune the `LazyReferenceManager` to clear quickly, or process in
index ranges:

```java
int n = root.events().size();
int step = 10_000;
for (int i = 0; i < n; i += step) {
    for (int j = i; j < Math.min(n, i + step); j++) {
        process(root.events().get(j));
    }
    // drop loaded segments — simplest: install a short-timeout checker for this job
}
```

For true streaming without holding segments, a different data structure (like
`GigaMap`) may be more appropriate.

## 9. Crossing storages with a Lazy reference

**Reproducer.**

```java
EmbeddedStorageManager a = EmbeddedStorage.start(rootA, dirA);
EmbeddedStorageManager b = EmbeddedStorage.start(new RootB(), dirB);

// grab a lazy from A
Lazy<ArrayList<Turnover>> lz = ...;

// try to stash it in B
b.createStorer().store(lz).commit();
```

**Symptom.** `IllegalStateException` — "already bound to a different storage".

**Root cause.** A Lazy instance is bound to its storage on first persistence.

**Fix.** Copy the value out: `ArrayList<Turnover> copy = new ArrayList<>(lz.get());`,
then wrap a fresh Lazy in storage B.

## 10. Holding a `.peek()` reference that gets cleared

**Reproducer.**

```java
ArrayList<Turnover> hard = lazy.peek();   // might be null
// ... long operation ...
hard.size();   // works if peek returned non-null, hazardous otherwise
```

**Symptom.** Hard to predict — `.peek()` may return null if never loaded, or a valid
reference that the JVM GC can still clean if Lazy is cleared externally.

**Root cause.** `.peek()` is intentionally weak — it does not keep the reference alive
once Lazy is cleared. The Swizzle Registry holds only a weak reference.

**Fix.** Use `.get()` if you actually want the value. Use `.peek()` only for
observational tests ("is this currently loaded?") — it's not for holding across long
operations.

## 11. Storing `Lazy.Reference(null)` and then reassigning

```java
private Lazy<ArrayList<X>> lst = Lazy.Reference(null);
// ...
lst = Lazy.Reference(new ArrayList<>());
storage.store(containing);   // new Lazy wrapper; old one orphaned
```

**Symptom.** Over time, orphaned Lazy wrappers accumulate in storage (GC'd eventually
by housekeeping).

**Root cause.** Replacing the wrapper creates a fresh entity; the old wrapper is
unreferenced.

**Fix.** `Lazy` exposes no public setter (only `$setLoader`, which is framework-
internal). Don't go through the `Reference(null) → Reference(value)` path at all.
Either pattern works:

**Pattern 1 — initialize with an empty collection, mutate in place:**

```java
private Lazy<ArrayList<X>> lst = Lazy.Reference(new ArrayList<>());
// later:
ArrayList<X> inner = lst.get();
inner.addAll(newData);
storage.store(inner);            // store the inner collection, see SKILL Pattern A
```

**Pattern 2 — leave the FIELD null until first use, assign once:**

```java
private Lazy<ArrayList<X>> lst;   // null until first use
// later:
if (lst == null) {
    lst = Lazy.Reference(new ArrayList<>(newData));
    storage.store(containing);    // store the parent so its Lazy field is recorded
} else {
    lst.get().addAll(newData);
    storage.store(lst.get());
}
```

`Reference(null)` is the worst of both: a real persisted wrapper that holds no
value, which then forces the orphaning reassignment.
