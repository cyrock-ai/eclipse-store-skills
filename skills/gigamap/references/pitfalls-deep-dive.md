# Pitfalls deep-dive — gigamap

Verified against Eclipse Store 4.3.0.

## 1. `storageManager.store(gigaMap)` races with CRUD

**Reproducer.**

```java
new Thread(() -> map.add(newPerson)).start();
storageManager.store(map);   // can throw
```

**Symptom.** `BinaryPersistenceException: Inconsistent element count`.

**Root cause.** `storageManager.store` doesn't acquire GigaMap's internal lock.
A concurrent mutation changes element count mid-serialize.

**Fix.** Use `map.store()` instead. It takes the lock. For one commit across
several maps, `map.store(storer)` + `storer.commit()`.

## 2. Mutating entities without `update`/`apply`

**Reproducer.**

```java
Person p = map.query(lastName.is("Smith")).findFirst().orElseThrow();
p.setLastName("Brown");
map.store();
```

**Symptom.** Queries for "Brown" return nothing; queries for "Smith" still
return `p`. A later `map.update(p, …)` does not help (the old keys are gone),
and a later `set` / `update` may throw `StaleIndexException`.

**Root cause.** Indices are a derived cache keyed by the values the indexer
saw at `add` / `update` time; nothing tracks direct field writes.

**Fix.** `map.update(p, x -> x.setLastName("Brown"))`. If it already happened:
`storageManager.store(p); map.reindex(); map.store();`.

## 3. Forgetting to close iterators

**Reproducer.**

```java
Iterator<Person> it = map.query(...).iterator();
process(it.next());
// loop abandoned before exhaustion, no close → read lock stays held
```

**Symptom.** Writes (`add` / `remove` / `update` / `apply`) from other threads
block indefinitely; a write from the thread that holds the iterator throws
`IllegalStateException` ("Self-deadlock detected"). `store()` is not affected —
it does not take the read lock.

**Root cause.** An iterator registers as a reader and holds the map's read
lock until closed. A fully drained iterator closes itself on the final
`hasNext()`; an abandoned one never does.

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
```

**Symptom.** Two "same" orders coexist.

**Root cause.** Default identity equality. `a != b` even though `.equals()` may
say true.

**Fix.** If your domain wants value equality:

```java
GigaMap<Order> map = GigaMap.New(XHashing.hashEqualityValue());
```

And make sure `Order` implements `equals`/`hashCode`. To *enforce* "one order
per id", add a unique constraint on the id — equality alone does not.

## 6. No identity index on a large map

**Reproducer.** Map with 10 M entries, no identity index. Call
`map.remove(person)`.

**Symptom.** Slow — Eclipse Store builds a compound index on the fly.

**Fix.** Always declare `.withBitmapIdentityIndex(...)` for the stable id.
Note that an identity index does not enforce uniqueness; combine it with
`.withBitmapUniqueIndex(...)` on the same indexer when both are wanted.

## 7. Unique constraint violation silently swallowed

**Reproducer.**

```java
try { map.add(dup); } catch (UniqueConstraintViolationException e) { /* ignore */ }
map.store();
```

**Symptom.** Business logic proceeds as if the add succeeded; data integrity
problem. On `update` / `apply` the violation also **removed** the entity.

**Fix.** Handle the exception at the domain level — either update the existing
entity or fail the operation. For `update` / `apply`, re-add the entity
carried by the exception after fixing the violation.

## 8. Wrapping GigaMap in `Lazy<>`

`Lazy.Reference(GigaMap...)` works but is pointless — GigaMap is internally
lazy. Use it as a direct field.

## 9. Expecting `ensure` to change an index

**Reproducer.**

```java
map.index().bitmap().ensure(newLastNameLogic);                 // same name, new logic
vectorIndices.ensure("embeddings", changedCfg, vectorizer);    // changed dimension
```

**Symptom.** No error; the old index keeps its old logic / configuration.

**Root cause.** `ensure` is get-or-create: an existing index is returned
unchanged and the arguments are ignored (a changed vector location logs a
warning). Adding an index later is fine — `add` / `ensure` back-fill from
the existing entities, all-or-nothing — but replacing one is explicit.

**Fix.** Bitmap: `bitmap().update(indexer)` (rebuilt before the old one is
dropped, keeps unique / identity membership). Vector: `removeIndex(name)` +
`add(...)` (re-indexes every entity); location only:
`changeIndexLocation(name, location)` + `store()`.

## 10. Segmented iteration vs. eager `.toList()`

**Reproducer.** `map.query(...).toList()` on a 100 M map with broad condition.

**Symptom.** OOM.

**Fix.** Use `.stream()` / `.iterator()` and process in chunks, page with
`.toList(offset, limit)`, use `.count()` if you only need the size, or narrow
the query with more conditions.

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

**Reproducer.** `map.index().register(LuceneIndex.Category(ctx))` with
`gigamap-lucene` but without `lucene-core` / `lucene-queryparser` (they are
`provided`); or `gigamap-jvector` on a JDK below 25.

**Symptom.** `NoClassDefFoundError` for `org.apache.lucene.document.Document`;
`UnsupportedClassVersionError` (class file version 69) for jvector.

**Fix.** Add the Lucene artifacts (9.8.0) yourself; run vector indices on
Java 25+.

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

**Symptom.** `IllegalStateException` at `add` / `update` / `reindex` time.

**Root cause.** By default `null` is treated as a vectorizer bug (fail fast).

**Fix.** Either compute the vector before `add()`, or opt in:

```java
@Override public boolean allowsNullVectors() { return true; }
```

Then `null` means "no embedding": the entity stays in the map and all other
indices, is excluded from the vector index, `getVector(id)` returns `null`,
and `search(entity, k)` with such an entity throws `IllegalArgumentException`.
The return value must stay constant for the index's lifetime.

## 14. Shared mutable buffer in the vectorizer

**Reproducer.**

```java
public class StatefulVectorizer extends Vectorizer<Doc> {
    private final float[] buffer = new float[768];      // shared across threads!
    @Override public float[] vectorize(Doc d) {
        for (int i = 0; i < 768; i++) buffer[i] = d.value(i);
        return buffer;
    }
}
```

**Symptom.** Sporadically wrong vectors, wrong search results.

**Root cause.** `vectorize()` is called concurrently: a search by entity runs
alongside mutations and other searches. The index copies a computed result
before calling the vectorizer again, so buffer reuse per se is allowed — but
one shared array lets a call overwrite the vector another call is still
returning. An embedded vectorizer's array is used as is (not copied).

**Fix.** Allocate per call, return the entity-owned array, or keep the
buffer in a `ThreadLocal<float[]>`.

## 15. Dimension mismatch on add

**Reproducer.**

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration.builder().dimension(768).build();
map.add(new Doc("oops", new float[1024]));   // wrong dim
```

**Symptom.** Throws on `add()` (an index failure: the entity is kept, the
vector index is stale for it until `reindex()`).

**Root cause.** `dimension` is fixed at index build time.

**Fix.** Pin `dimension` to the embedding model (`768` BERT base, `1536`
`text-embedding-3-small`, `3072` `text-embedding-3-large`). Migrating to
another model means a **second** index under a new name, or `removeIndex`
+ `add` (re-vectorizes everything).

## 16. The 2.1 billion ordinal limit

**Reproducer.** Entity ids of one `GigaMap` reach `Integer.MAX_VALUE`.

**Symptom.** `IllegalStateException: Entity ID … exceeds maximum supported value`.

**Root cause.** JVector ordinals are the GigaMap entity ids cast to `int`.
Every vector index on the same map shares those ids, so a second index on
the same map does not help.

**Fix.** Shard across **GigaMap instances** (consistent hashing on the
entity key; gather-and-merge top-k from all shards).

## 17. Missing JVM flags / wrong Java version

**Reproducer.** Run `gigamap-jvector` without `--add-modules jdk.incubator.vector`,
or without `--enable-native-access=ALL-UNNAMED`.

**Symptom.** Scalar fallback: search and indexing noticeably slower, no
error. Without native access, a warning about a restricted method from
jvector's memory-mapped reader (an error on JVMs started with
`--illegal-native-access=deny`).

**Fix.**

```
java --add-modules jdk.incubator.vector --enable-native-access=ALL-UNNAMED -jar app.jar
```

Surefire/Failsafe: the same string in `<argLine>`. On the module path use
`--enable-native-access=jvector`. Java 25+ is required.

## 18. Enabling PQ to save space

**Reproducer.**

```java
VectorIndexConfiguration.builderForLargeDataset(768, dir)
    .approximateScoring(ApproximateScoring.FUSED_PQ)   // "compression"
    .build();
```

**Symptom.** The graph files get **larger** (~`pqSubspaces × maxDegree`
bytes per node on top of the inline vectors) and recall drops a little.
`maxDegree` is **not** changed (the old "FusedPQ forces 32" rule is gone).

**Root cause.** `FUSED_PQ` stores the PQ codes of every neighbour inside
each node to save *reads* on a graph larger than the page cache; it is an
I/O optimisation, not compression. `forLargeDataset(dim, dir)` enables it
by default.

**Fix.** To shrink the index use `vectorStorage(VectorStorage.NVQ)` (~3×
smaller, exact scores) — `forCompactLargeDataset`. Keep `NONE` while the
graph fits the page cache; use `FUSED_PQ` / `PQ_IN_MEMORY` only beyond it,
and widen `minSearchBeamWidth` to hold recall. `FUSED_PQ` and `NVQ` require
`onDisk=true`; in-memory `PQ_IN_MEMORY` requires `optimizationIntervalMs > 0`
(the switch to compressed scoring is an O(n) rebuild under the map's lock).

## 19. `eventualIndexing=true` makes search briefly stale

**Reproducer.**

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration.builder()
    .dimension(768).eventualIndexing(true).build();

map.add(newDoc);
embeddings.search(newDoc.embedding(), 10);   // newDoc may be missing
```

**Symptom.** A just-added document doesn't show up for a short window; the
same window applies to removals and to a vector set to `null`.

**Root cause.** The **vector file** is written synchronously (durable), the
**graph** mutation is queued onto the background thread.

**Fix.** Accept the staleness, call `embeddings.optimize()` (drains the queue;
so does `close()` — `persistToDisk()` does **not** wait, it takes the pending
operations into the segment it writes), or leave `eventualIndexing` off.

## 20. Computed vectorizer without a directory

**Reproducer.**

```java
public class ApiVectorizer extends Vectorizer<Doc> {          // isEmbedded() == false
    @Override public float[] vectorize(Doc d) { return api.embed(d.text()); }
}
indices.ensure("embeddings", VectorIndexConfiguration.forMediumDataset(1536), new ApiVectorizer());
```

**Symptom.** Every start calls the embedding API once per entity and blocks
every read and mutation of the map until it is done. In 4.x the vectors were
persisted in the storage; after the upgrade an index like this refuses
`store()` until it gets a location.

**Root cause.** The storage holds no vectors. An in-memory index without
`indexDirectory` / `indexLocation` keeps its vector file in a temporary
location and re-vectorizes everything at each start.

**Fix.** `builderForMediumDataset(1536).indexDirectory(path)` or
`.indexLocation(IndexLocation.Named("vectors"))`. For an existing 4.x
index: `vectorIndices.changeIndexLocation("embeddings", location)` moves the
imported vectors at once, then `map.store()`. Make the vectorizer
deterministic — the index re-vectorizes after a crash and expects the same
vector back.

## 21. Index directory restored separately from the storage

**Reproducer.** Restore last night's `storage/` but keep today's vector
directory, or copy the storage to another machine without the index
directory.

**Symptom.** JVector: the manifest's state does not match the stored index →
the graph is rebuilt from the vector file (or every entity is re-vectorized
when the vector file is missing). Lucene: the index is rebuilt from the
entities on first use (warning logged), or — with a stored absolute path on
another machine — the original directory is opened and shared.

**Root cause.** On-disk index files are a derived cache tied to one storage
state; a stored absolute path is tied to one machine.

**Fix.** Back up and restore storage and index directories together, at the
same point in time. Use `IndexLocation.Named` + `IndexLocations.bind` for
anything that moves between machines (`index-locations.md`).

## 22. `close()` / `optimize()` / `persistToDisk()` under the map's monitor

`synchronized (map) { vectorIndex.optimize(); }` or calling them from
`update` / `apply` logic throws `IllegalStateException`: they wait for work
whose holders may need the monitor, so the index refuses instead of
deadlocking. Call them outside the monitor — or not at all: storage shutdown
closes every index of a loaded map.
