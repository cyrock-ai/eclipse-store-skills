# Pitfalls deep-dive — gigamap

## 1. `storageManager.store(gigaMap)` races with CRUD

**Reproducer.**

```java
new Thread(() -> map.add(newPerson)).start();
storageManager.store(map);   // can throw
```

**Symptom.** `BinaryPersistenceException: Inconsistent element count`.

**Root cause.** `storageManager.store` doesn't acquire GigaMap's internal lock.
A concurrent mutation changes element count mid-serialize.

**Fix.** Use `map.store()` instead. It takes the lock.

## 2. Mutating entities without `update`/`apply`

**Reproducer.**

```java
Person p = map.query(lastName.is("Smith")).findFirst().orElseThrow();
p.setLastName("Brown");
map.store();
```

**Symptom.** Queries for "Brown" return nothing; queries for "Smith" still
return `p`.

**Root cause.** Indices didn't learn about the change.

**Fix.** `map.update(p, x -> x.setLastName("Brown"))`.

## 3. Forgetting to close iterators

**Reproducer.**

```java
Iterator<Person> it = map.query(...).iterator();
while (it.hasNext()) process(it.next());
// no close; next store() blocks
```

**Symptom.** Deadlock or very long waits on subsequent `store()` / writes.

**Fix.** Always try-with-resources.

## 4. Null insertion

**Reproducer.**

```java
map.add(null);
```

**Symptom.** NPE or `IllegalArgumentException`.

**Root cause.** GigaMap disallows nulls by design.

**Fix.** Don't pass null. Use an `Optional` at the call site if you need
"maybe".

## 5. Identity vs. value equality

**Reproducer.**

```java
GigaMap<Order> map = GigaMap.New();   // identity

Order a = new Order("ord-1", "alice");
Order b = new Order("ord-1", "alice");
map.add(a);
map.add(b);   // succeeds — identity sees them as different

map.remove(b);   // works because b was added
map.remove(a);   // works because a is present
```

**Symptom.** Two "same" orders coexist.

**Root cause.** Default identity equality. `a != b` even though `.equals()` may
say true.

**Fix.** If your domain wants value equality:

```java
GigaMap<Order> map = GigaMap.New(XHashing.hashEqualityValue());
```

And make sure `Order` implements `equals`/`hashCode`.

## 6. No identity index on a large map

**Reproducer.** Map with 10 M entries, no identity index. Call
`map.remove(person)`.

**Symptom.** Slow — Eclipse Store builds a compound index on the fly.

**Fix.** Always declare `.withBitmapIdentityIndex(...)` for the stable id.

## 7. Unique constraint violation silently swallowed

**Reproducer.**

```java
try { map.add(dup); } catch (UniqueConstraintViolationException e) { /* ignore */ }
map.store();
```

**Symptom.** Business logic proceeds as if the add succeeded; data integrity
problem.

**Fix.** Handle the exception at the domain level — either update the existing
entity or fail the operation.

## 8. Wrapping GigaMap in `Lazy<>`

**Reproducer.**

```java
private Lazy<GigaMap<Person>> people = Lazy.Reference(GigaMap.<Person>Builder()...build());
```

**Symptom.** Works but is pointless — GigaMap is internally lazy. You've added a
layer that blocks external access patterns (`Lazy.get()` hides the internal
iteration semantics).

**Fix.** Use GigaMap as a direct field. It handles lazy segments itself.

## 9. Modifying indexer after build

You can't. The index structure is fixed at `build()`. Adding an index later
requires scanning the entire dataset.

**Fix.** Plan indices up front. If you must add later, do a migration: build a
new GigaMap with the desired indices, copy entries over via `addAll`, swap the
root reference.

## 10. Segmented iteration vs. eager `.toList()`

**Reproducer.** `map.query(...).toList()` on a 100 M map with broad condition.

**Symptom.** OOM.

**Fix.** Use `.stream()` / `.iterator()` and process in chunks; or use
`.count()` if you only need size; or narrow the query with more conditions.

## 11. Queries across multiple `GigaMap` instances

**Reproducer.**

```java
q1 = mapA.query(...)
q2 = mapB.query(...)
q1.and(q2)   // undefined
```

**Symptom.** Invalid.

**Fix.** Sub-query combination is within one GigaMap. Cross-map intersection
means joining at the application level.

## 12. Lucene / vector dependencies not on classpath

**Reproducer.**

```java
builder.withLuceneIndex(...)
```

…without `gigamap-lucene`.

**Symptom.** `NoClassDefFoundError` at build time.

**Fix.** Add the optional artifact.

## 13. Vectorizer returns null

**Reproducer.**

```java
public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) {
        return d.embedding();   // can be null for newly-ingested docs
    }
}

map.add(new Doc("draft", null));
```

**Symptom.** `IllegalStateException: Vectorizer returned null for entity ...`
at `add` time.

**Root cause.** The `Vectorizer.vectorize()` contract forbids returning
`null` for an entity the caller is asking the index to handle.

**Fix.** Don't insert entities without a vector. Either compute the vector
before `add()`, or guard the call site:

```java
if (doc.embedding() != null) {
    map.add(doc);
}
```

If "missing embedding" is a domain-meaningful state, hold those entities in
a separate collection (or in the GigaMap with a bitmap "has-embedding" flag)
and only register them with the vector index once the embedding is filled in.

## 14. Vectorizer is not thread-safe

**Reproducer.**

```java
public class StatefulVectorizer extends Vectorizer<Doc> {
    private float[] buffer = new float[768];      // shared mutable state!
    @Override public float[] vectorize(Doc d) {
        for (int i = 0; i < 768; i++) buffer[i] = d.value(i);
        return buffer;
    }
}
```

**Symptom.** Sporadically wrong vectors. `NaN` distances. `NullPointerException`
or `AssertionError` from JVector's SIMD kernels under load.

**Root cause.** HNSW build/search and (in embedded mode) the optimize-time
ForkJoinPool workers all call `vectorize()` concurrently on the **same**
`Vectorizer` instance. Sharing mutable state corrupts vectors.

**Fix.** Make `vectorize()` allocate a fresh array per call (or return an
already-immutable reference owned by the entity). No shared mutable state.

```java
@Override public float[] vectorize(Doc d) {
    return d.embedding();        // entity-owned, immutable
}
```

If you really must reuse buffers, use a `ThreadLocal<float[]>` — but
allocating per call is fine for typical embedding sizes.

## 15. Dimension mismatch on add

**Reproducer.**

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration.builder()
    .dimension(768)
    .build();
// ...
map.add(new Doc("oops", new float[1024]));   // wrong dim
```

**Symptom.** Throws on `add()`.

**Root cause.** `dimension` is fixed at index build time. Every vector must
match.

**Fix.** Pin `dimension` to the embedding model you use (`768` for BERT base,
`1536` for `text-embedding-ada-002`, `3072` for `text-embedding-3-large`,
etc.). If you migrate to a different model, register a **second** vector
index under a new name and re-vectorize. Don't try to "extend" the first.

## 16. The 2.1 billion ordinal limit

**Reproducer.** Insert > `Integer.MAX_VALUE` entities into a single
`VectorIndex`.

**Symptom.** Search becomes unreliable; ordinal arithmetic overflows.

**Root cause.** JVector uses `int` for graph node ordinals — ordinals are
the GigaMap entity ids cast to `int`, so the 32-bit ceiling is hard.

**Fix.** Shard. Multiple `VectorIndex` instances per map (e.g.
`embeddings-shard-0`, `embeddings-shard-1`), or multiple maps. Route
inserts and searches at the application layer (consistent hashing on
entity id is the simplest scheme; gather-and-merge top-k from all shards).

## 17. Forgetting `--add-modules jdk.incubator.vector`

**Reproducer.** Run on Java 20+ without the flag.

**Symptom.** Index works, but search and indexing are noticeably slower than
benchmarks suggest. No error.

**Root cause.** JVector's SIMD kernels need the Panama Vector incubator
module enabled. Without the flag, it falls back to scalar Java.

**Fix.**

```
java --add-modules jdk.incubator.vector -jar app.jar
```

For Surefire/Failsafe:

```xml
<configuration>
    <argLine>--add-modules jdk.incubator.vector</argLine>
</configuration>
```

## 18. PQ compression silently overrides `maxDegree`

**Reproducer.**

```java
VectorIndexConfiguration.builder()
    .dimension(768)
    .maxDegree(64)
    .enablePqCompression(true)
    .build();
```

**Symptom.** No error, but `configuration.maxDegree() == 32`. Memory and
recall numbers don't match what you set.

**Root cause.** FusedPQ requires `maxDegree=32`. The configuration builder
silently overrides when PQ is enabled.

**Fix.** Accept the override (don't try to fight it), or disable PQ if you
genuinely need a different `maxDegree`. Document the choice in code.

## 19. `eventualIndexing=true` makes search briefly stale

**Reproducer.**

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration.builder()
    .dimension(768)
    .eventualIndexing(true)
    .build();

map.add(newDoc);
embeddings.search(newDoc.embedding(), 10);   // newDoc may be missing
```

**Symptom.** A just-added document doesn't show up in search results for a
few hundred ms.

**Root cause.** With `eventualIndexing=true`, the **vector store** is updated
synchronously (the data is durable) but the **HNSW graph** mutation is
queued onto a background thread. Search runs against the graph, not the
store.

**Fix.** Either accept the staleness (the trade-off is much lower add
latency under load), or:

- Call `embeddings.optimize()` / `embeddings.persistToDisk()` — both drain
  the queue first.
- Use `eventualIndexing=false` (default) for write paths where the next
  search must see the change.

## 20. Embedded-mode update temporarily degrades recall

**Reproducer.**

```java
// Embedded vectorizer — vector lives on the entity
map.update(doc, d -> d.replaceEmbedding(newVector));
// search before the next optimize() / persistToDisk()
```

**Symptom.** Searches return the entity, but not necessarily as the top
match for `newVector` — the graph edges still reflect `oldVector`.

**Root cause.** In embedded mode the inline update path **skips**
JVector's `removeDeletedNodes()`. That cleanup runs on a ForkJoinPool whose
workers call back into `parentMap.get()`, which would deadlock against
the GigaMap monitor we hold during a synchronous mutation. Skipping is
safe (correctness preserved — `EntityBackedVectorValues` always reads the
latest vector), but the graph edges are slightly stale until the next
`optimize()` or `persistToDisk()` rebuilds them outside the monitor.

**Fix.** Schedule periodic `optimize()` (manual or via
`optimizationIntervalMs`) for write-heavy embedded-mode workloads.
Computed mode does not have this issue — its update path replaces the
`VectorEntry` in `vectorStore` and the graph is updated normally.

## 21. `storageManager.store(gigaMap)` with a vector index

Same root cause and fix as Pitfall 1 — vector indices are part of the
structure being serialized, so `map.store()` (not `storageManager.store(map)`)
is required. The vector index's binary handlers integrate with GigaMap's
incremental store pipeline; only changed indices are written.

To force a vector index's on-disk file to flush separately, call
`vectorIndex.persistToDisk()` — different mechanism (writes `{name}.graph`
+ `{name}.meta`), independent of the EclipseStore `storage/` directory.
