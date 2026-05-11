---
name: gigamap
description: >
  Guide Claude on using GigaMap — Eclipse Store's indexed, lazily-loaded,
  query-capable collection for very large datasets (millions to billions of
  entities).

  **Apply this skill whenever a new entity collection is being designed, or an
  existing `List` / `Map` / `Set` of persisted entities is being scaled or
  reviewed for query needs.** Choosing between a plain collection, a `Lazy`
  collection, and a `GigaMap` is a **model-design decision**, not a tuning
  knob: promoting `List<X>` → `GigaMap<X>` later involves a data migration and
  a refactor of every reader/query. If the user is sketching an aggregate that
  holds entities that may grow into the 100K+ range, or that will need any of
  indexed lookup / filtering / spatial / full-text / vector search, evaluate
  GigaMap *now*. Also load this skill whenever the user mentions queries,
  search, or filtering against persisted entities — even before any size
  threshold is hit.

  Also use this skill when the user asks to "use GigaMap", "index entities",
  "bitmap index", "unique index", "identity index", "run a query", "GigaQuery",
  "sub-query", "Lucene full-text search", "spatial index", "geo query",
  "near(lat, lon)", "withinBox", "SpatialIndexer", "DocumentPopulator",
  "IndexerString", "IndexerLocalDate", "BinaryIndexerUUID", "IndexerMultiValue",
  "gigaMap.store", "billions of rows", or asks why `storageManager.store(gigaMap)`
  is unsafe.

  **Vector / embedding triggers (apply at design time too).** Apply when the
  user is designing or building anything involving embeddings or similarity:
  "vector similarity search", "kNN" / "ANN" / "HNSW", "embeddings", "vector
  index" / "vector store" / "vector database", "jvector", "VectorIndex",
  "VectorIndices", "VectorIndexConfiguration", "Vectorizer",
  "VectorSearchResult", "COSINE / DOT_PRODUCT / EUCLIDEAN", "PQ compression",
  "on-disk vector index", "eventual indexing", "embedded vs computed vectors".
  Eclipse Store ships an HNSW vector index via the `gigamap-jvector` artifact
  that integrates with bitmap / Lucene via sub-queries.
version: 0.4.1
---

# Eclipse Store — GigaMap (Indexed, Queryable, Lazy Large Collections)

Segmented, index-backed, lazily-loaded collection. Multiple index types
(bitmap, identity, unique, spatial, Lucene, vector), composable via
sub-queries. Mutations must go through `add`/`remove`/`update`/`apply` —
direct entity mutation leaves indices stale.

## Do NOT use this skill

- Small collection (< 100K) → plain `ArrayList` / `HashMap`, optionally
  `Lazy<>`-wrapped.
- SQL-like query semantics → not this API.
- Cross-process value cache → `cache-jcache`.

## Maven setup

All under `groupId=org.eclipse.store`, `version=${eclipse-store.version}`:

| `artifactId` | Required for |
|---|---|
| `gigamap` | Core + bitmap + spatial. |
| `gigamap-lucene` | Full-text. |
| `gigamap-jvector` | HNSW vector similarity. |

## Core API

From `org.eclipse.store.gigamap.types`:

| Symbol | Purpose |
|---|---|
| `GigaMap<E>` | The collection. |
| `GigaMap.New()` | No-index map, identity equality. |
| `GigaMap.New(Equalator<? super E>)` | No-index map with custom equality. |
| `GigaMap.<E>Builder()` | Fluent builder for indexed map. |
| `.withBitmapIdentityIndex(indexer)` | Identity index (unique id, fastest lookup). |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. |
| `.withBitmapIndex(indexer)` | Non-unique bitmap index (also used for `SpatialIndexer`). |
| `.withIdentityEquality()` / `.withValueEquality()` | Equality mode for the indexed map (default: identity). |
| `.build()` | Create the map. |
| `map.index().register(LuceneIndex.Category(ctx))` | Attach a Lucene full-text index post-build. |
| `map.index().register(VectorIndices.Category())` then `vectorIndices.add(name, cfg, vectorizer)` | Attach a jvector similarity index. |
| `map.add(e)` / `map.remove(e)` / `map.update(e, mutator)` / `map.apply(e, fn)` | The only safe entry points for mutation. |
| `map.store()` | Persist (acquires GigaMap's internal lock). Never use `storageManager.store(map)` directly. |
| `GigaQuery<E>` | Fluent query — `.toList()`, `.count()`, `.iterator()` (try-with-resources). |
| `GigaMap.SubQuery` | Abstraction for things that contribute id sets to a query. |

Indexer base classes (in `org.eclipse.store.gigamap.types`) and the
abstract method each one demands:

| Indexer | For type | Override |
|---|---|---|
| `IndexerString.Abstract<E>` | `String` | `public String getString(E)` |
| `BinaryIndexerUUID.Abstract<E>` | `UUID` | `protected UUID getUUID(E)` |
| `IndexerLocalDate.Abstract<E>` | `LocalDate` | `protected LocalDate getLocalDate(E)` |
| `IndexerLocalDateTime.Abstract<E>` | `LocalDateTime` | `protected LocalDateTime getLocalDateTime(E)` |
| `IndexerInteger.Abstract<E>` | `Integer` | `protected Integer getInteger(E)` |
| `IndexerLong.Abstract<E>` | `Long` | `protected Long getLong(E)` |
| `IndexerByte.Abstract<E>` | `Byte` | `protected Byte getByte(E)` |
| `IndexerFloat.Abstract<E>` | `Float` | `protected Float getFloat(E)` |
| `IndexerDouble.Abstract<E>` | `Double` | `protected Double getDouble(E)` |
| `IndexerBoolean.Abstract<E>` | `Boolean` | `protected Boolean getBoolean(E)` |
| `IndexerMultiValue.Abstract<E, K>` | `Collection<K>` | `public Iterable<K> indexEntityMultiValue(E)` + `public Class<K> keyType()` |

Annotations (for simple cases):

| Annotation | Effect |
|---|---|
| `@Index` | Declare an implicit index on a field. |
| `@Identity` | Identity index (single unique id field). |
| `@Unique` | Uniqueness constraint. |

## Index types in depth

### Bitmap — exact + range, the default

Off-heap bit sets keyed by entity value; equality, `in`-list, range, and
predicate queries on scalar or collection-valued fields. Three registration
variants:

| Builder method | Semantics |
|---|---|
| `.withBitmapIdentityIndex(indexer)` | Unique **and** used internally for `remove` / `update` lookup. |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. Duplicate → `UniqueConstraintViolationException`. |
| `.withBitmapIndex(indexer)` | Non-unique; many entities per key. Also the path for `SpatialIndexer`. |

Operator catalogue (`is`, `in`, `not`, `notIn`, `is(Predicate)`, range and
temporal operators, multi-value `.all`) → `references/query-dsl.md`.

### Lucene — full-text search with scoring

Separate artifact (`gigamap-lucene`). Use when you need analyzer-driven
tokenization, phrase, wildcard, fuzzy, or score-ranked results — anything
beyond exact/range on a string. Wire post-build with the restart-safe
get-or-register idiom (after deserialization the category is already
attached, so `register(...)` would return `null`):

```java
LuceneIndex<E> lucene = map.index().get(LuceneIndex.class);
if (lucene == null) lucene = map.index().register(LuceneIndex.Category(ctx));
```

`ctx` is a `LuceneContext` bound to a `DocumentPopulator<E>` and an
on-disk directory. `lucene.query(q)` returns `List<E>`; `lucene.search(q, k)`
returns a `LuceneSearchResult<E>` that's sub-queryable via `.and(...)`
(Pattern H). **`LuceneIndex` is `Closeable`** and holds an on-disk
write lock that `storageManager.close()` does **not** cascade — call
`luceneIndex.close()` before reopening storage in the same JVM. The
Lucene directory is owned by Lucene — back it up **separately** from
EclipseStore's `storage/`. Detail (provided Maven deps, query syntax,
score handling) in `references/lucene.md`.

### Spatial — latitude / longitude, part of core

No extra artifact. `SpatialIndexer.Abstract<E>` is a specialized bitmap
indexer that buckets lat/lon pairs under the hood, so it registers via
`.withBitmapIndex(...)`.

```java
public class LocationIndex extends SpatialIndexer.Abstract<Store> {
    @Override protected Double getLatitude (Store s) { return s.lat(); }
    @Override protected Double getLongitude(Store s) { return s.lon(); }
}

private static final LocationIndex loc = new LocationIndex();

GigaMap<Store> stores = GigaMap.<Store>Builder()
    .withBitmapIdentityIndex(StoreIndices.id)
    .withBitmapIndex(loc)
    .build();
```

Operators on the indexer:

| Operator | Kind | Meaning |
|---|---|---|
| `loc.at(lat, lon)` | `Condition` | Exact coordinate match. |
| `loc.near(lat, lon, radiusKm)` | `Condition` | **Bounding-box approximation** of the circle. Fast, index-driven, includes corner points beyond the true radius (up to √2 × `radiusKm`). Computed with Earth-radius / `cos(lat)` longitude correction. |
| `loc.withinBox(minLat, maxLat, minLon, maxLon)` | `Condition` | Axis-aligned bounding box. |
| `loc.latitudeBetween(min, max)` / `longitudeBetween(min, max)` | `Condition` | 1-D range. |
| `loc.latitudeAbove(v)` / `latitudeBelow(v)` | `Condition` | 1-D bound (likewise longitude). |
| `loc.isNull()` | `Condition` | Entities with missing coordinates. |
| `loc.withinRadius(lat, lon, radiusKm)` | `Predicate<E>` | **Exact** great-circle (haversine) filter. Not index-driven — applies per entity. Chain after `near` for index-accelerated exact results. |
| `SpatialIndexer.haversineDistance(lat1, lon1, lat2, lon2)` | static `double` | Great-circle distance in km. Public helper. |

Exact-radius idiom — `near` as the index pre-filter, `withinRadius` as the
exact post-filter:

```java
var exact = loc.withinRadius(40.7128, -74.0060, 50.0);
List<Store> hits = map.query(loc.near(40.7128, -74.0060, 50.0))
    .stream()
    .filter(exact)
    .toList();
```

Lat/lon getters return `Double` (nullable — `isNull()` matches missing
coordinates). Points only — no polygon / linestring geometry. For
cutoff-sensitive queries (billing zones, legal radii) the `withinRadius`
post-filter is mandatory; for approximate queries it's optional.

### Vector — HNSW similarity search via jvector

Separate artifact (`gigamap-jvector`). Eclipse Store wraps
[JVector](https://github.com/datastax/jvector) (an HNSW kNN library) so a
`GigaMap<E>` becomes a vector-searchable map: named vector indices,
automatic mutation broadcast, lazily-resolved search results, sub-queryable
with bitmap and Lucene (Pattern H).

> **JVM flag.** Add `--add-modules jdk.incubator.vector` for SIMD
> acceleration via the Panama Vector API. Java 21 LTS recommended.

`Vectorizer<E>.isEmbedded()` decides where vectors live: **embedded** =
read from the entity (`record Doc(String text, float[] embedding)`),
**computed** (default) = computed once at `add` and persisted in an
internal `GigaMap<VectorEntry>`. Mode is fixed at build — switching means
rebuilding from scratch. Pick **embedded** when the entity already carries
the vector; **computed** when the source is expensive (OpenAI, image
embedder).

```java
public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) { return d.embedding(); }
    @Override public boolean isEmbedded()     { return true; }
}

GigaMap<Doc> docs = GigaMap.New();

VectorIndexConfiguration cfg = VectorIndexConfiguration
    .forMediumDataset(768);                          // (1)

// Restart-safe — after deserialization the category is already attached,
// so register(...) would return null.
VectorIndices<Doc> indices = docs.index().get(VectorIndices.class);
if (indices == null) indices = docs.index().register(VectorIndices.Category());

VectorIndex<Doc> embeddings = indices.ensure("embeddings", cfg, new DocVectorizer());  // (2)

docs.add(new Doc("Hello world", vec));

VectorSearchResult<Doc> top = embeddings.search(queryVector, 10);
for (var entry : top) {
    System.out.println(entry.score() + ": " + entry.entity().title());
}
```

(1) `forSmallDataset` / `forMediumDataset` / `forLargeDataset` /
`forHighPrecision` factory presets cover most cases. Each has a
`builderFor*(...)` variant if you need to override one parameter.
(2) `ensure(name, cfg, vectorizer)` is the restart-safe sibling of `add(...)`
— returns the existing named index on the second run.

**`VectorIndex` is `Closeable`** (on-disk graph holds file handles). Close
it before `storage.close()` if you'll reopen storage in the same JVM.
Design-side detail (mode, similarity, HNSW tuning, sub-query semantics,
sharding, recall measurement) → `references/vector-deep-dive.md`.
Operations (full parameter table, restart-safe wiring, on-disk format, PQ,
background tasks, operational checklist) → `references/vector-operations.md`.

## Idiomatic patterns

### Pattern A — Define indices as constants

```java
public final class PersonIndices {
    public static final BinaryIndexerUUID<Person> id = new BinaryIndexerUUID.Abstract<>() {
        @Override protected UUID getUUID(Person p) { return p.id(); }       // (1)
    };
    public static final IndexerString<Person> lastName = new IndexerString.Abstract<>() {
        @Override public String getString(Person p) { return p.lastName(); } // (2)
    };
    public static final IndexerLocalDate<Person> birthDate = new IndexerLocalDate.Abstract<>() {
        @Override protected LocalDate getLocalDate(Person p) { return p.birthDate(); }
    };
    public static final IndexerMultiValue<Person, String> tags =
        new IndexerMultiValue.Abstract<Person, String>() {                   // (3)
            @Override public Iterable<String> indexEntityMultiValue(Person p) { return p.tags(); }
            @Override public Class<String> keyType()                         { return String.class; }
        };
    private PersonIndices() {}
}
```

Match the abstract base's visibility — see the **Override** column in the
Indexer base classes table above. `getString` is `public`; numeric /
temporal / UUID getters are `protected`; `IndexerMultiValue` overrides two
`public` methods.

### Pattern B — Build a GigaMap

```java
GigaMap<Person> map = GigaMap.<Person>Builder()
    .withBitmapIdentityIndex(PersonIndices.id)
    .withBitmapIndex(PersonIndices.lastName)
    .withBitmapIndex(PersonIndices.birthDate)
    .build();
```

### Pattern C — Add, query, store

```java
map.add(new Person(UUID.randomUUID(), "Alice", "Smith", LocalDate.of(1990, 1, 1)));
map.add(new Person(UUID.randomUUID(), "Bob", "Smith", LocalDate.of(1985, 6, 15)));

// Simple equality
List<Person> smiths = map.query(PersonIndices.lastName.is("Smith")).toList();

// Combined
GigaQuery<Person> adults = map.query(
    PersonIndices.birthDate.before(LocalDate.of(2005, 1, 1))
      .and(PersonIndices.lastName.is("Smith"))
);
long n = adults.count();

// Persist
map.store();
```

### Pattern D — Update via `update` / `apply`

```java
map.update(person, p -> {
    p.setLastName("Jones");
    p.setAddress(newAddress);
});
map.store();
```

`apply(E, Function<? super E, R>)` is the same but returns a value from the
lambda:

```java
String oldEmail = map.apply(person, p -> {
    String prev = p.email();
    p.setEmail("new@example.com");
    return prev;
});
```

**Records / immutable entities.** `update` / `apply` rely on in-place
mutation, so they don't fit immutable types. With a record, do `map.remove(old);
map.add(newInstance);` — combine with `.withValueEquality()` on the builder
if the new instance is value-equal to the old one (else use identity / pass
the same record reference to `remove`).

### Pattern E — Remove

```java
// By identity (uses identity index if present)
map.remove(person);

// By explicit index (faster if you know which)
map.remove(person, PersonIndices.lastName);

map.store();
```

### Pattern F — Iterate with try-with-resources

Iterators hold read locks. **Always close them.**

```java
try (var it = map.query(PersonIndices.lastName.is("Smith")).iterator()) {
    while (it.hasNext()) {
        process(it.next());
    }
}
```

Deadlock follows silently if you forget.

### Pattern G — Query DSL (boolean / range / predicate / multi-value)

```java
// Boolean combinations
map.query(lastName.is("Smith").and(birthDate.isYear(1990)));
map.query(lastName.is("Smith").or(lastName.is("Jones")));
map.query(lastName.in("Smith", "Jones", "Brown"));
map.query(lastName.not("Smith"));

// Range (numeric + temporal indexers)
map.query(price.between(10, 100));
map.query(birthDate.before(LocalDate.now().minusYears(18)));

// Predicate on the index key
map.query(lastName.is(n -> n.length() > 5));

// Multi-value indexer (e.g. IndexerMultiValue<Person, Interest>)
map.query(interests.is(Interest.SPORTS));         // contains SPORTS
map.query(interests.all(Interest.SPORTS, Interest.LITERATURE)); // contains both
```

Full operator catalogue (`greaterThan`, `lessThanEqual`, `isYear`, `isMonth`,
`after`, `before`, `notIn`, multi-value `.in`/`.not`/`.notIn`, …) lives in
`references/query-dsl.md`.

### Pattern H — Sub-queries (combine across index types)

```java
// Bitmap + Lucene
LuceneSearchResult<Article> luceneHits = luceneIndex.search("content:eclipse", 100);
List<Article> published = map.query(status.is("PUBLISHED")).and(luceneHits).toList();

// Bitmap + vector
VectorSearchResult<Doc> vectorHits = vectorIndex.search(queryVec, 50);
List<Doc> tech = map.query(category.is("tech")).and(vectorHits).toList();
```

All sub-query combinations are logical AND. When a `LuceneSearchResult` /
`VectorSearchResult` is **on the right** of `.and(...)`, scores are dropped
(id-set intersection); inverting the chain (`hits.and(query)`) returns a
`ScoredSearchResult` that preserves ordering. Sub-query helpers — bitmap +
bitmap, `EntityIdMatcher.Ascending(...)`, score-preserving idioms — in
`references/query-dsl.md`.

### Pattern I — Root wiring

GigaMap goes into your root object like any other field. Type handlers for
GigaMap are registered automatically when the `gigamap` artifact is on the
classpath.

```java
public class AppRoot {
    private final GigaMap<Person> people = GigaMap.<Person>Builder()
        .withBitmapIdentityIndex(PersonIndices.id)
        .withBitmapIndex(PersonIndices.lastName)
        .build();
    public GigaMap<Person> people() { return people; }
}

EmbeddedStorageManager storage = EmbeddedStorage.start(new AppRoot(), dir);
```

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Mutate entities directly

```java
// WRONG
person.setLastName("Jones");
map.store();
```

Indices still point to "Smith". Queries return stale results; `map.remove(person,
lastNameIndex)` looks in the wrong bucket.

**Fix.** `map.update(person, p -> p.setLastName("Jones"))`.

### Anti-pattern 2 — No identity index

```java
GigaMap<Person> map = GigaMap.<Person>Builder()
    .withBitmapIndex(PersonIndices.lastName)
    .build();
map.remove(somePerson);     // falls back to compound index — slow
```

**Fix.** Add `.withBitmapIdentityIndex(PersonIndices.id)`.

### Anti-pattern 3 — `storageManager.store(map)` without sync

```java
// WRONG — can throw BinaryPersistenceException: Inconsistent element count
storageManager.store(map);
```

**Fix.** `map.store()`. It acquires GigaMap's internal lock.

If you must go through storage manager (e.g., in a multi-object atomic store),
synchronize externally:

```java
synchronized (map) {
    storageManager.store(map);
}
```

### Anti-pattern 4 — Leaving iterators / streams open

```java
// WRONG
Iterator<Person> it = map.query(...).iterator();
process(it.next());   // iterator never closed → read lock never released
```

**Fix.** Try-with-resources:

```java
try (var it = map.query(...).iterator()) { ... }
```

### Anti-pattern 5 — Ignoring `UniqueConstraintViolationException`

Adding two entities that collide on a unique index throws
`UniqueConstraintViolationException`. Catching and swallowing breaks the
GigaMap's invariants. Handle the duplicate at the domain level.

## Pitfalls & gotchas

1. **Indices must be declared up front.** Adding an index later means a data
   migration — you cannot register a new indexer without re-scanning.
2. **`gigaMap.store()`'s lock covers GigaMap operations only.** Stored
   *elements* can still be mutated by another thread during the store — the
   GigaMap stays consistent but the persisted element graph may not.
   Cross-aggregate atomicity (GigaMap mutation + other graph changes) needs
   an application-level lock spanning both. See `concurrency-and-locking`.
3. **Null forbidden.** `map.add(null)` throws. Use sentinels for "absent".
4. **Query results are views.** Lazy iteration; don't assume stability
   across mutation.
5. **Sub-queries must come from the same GigaMap.** Combining queries across
   maps is invalid.

## Symptom → fix

| Exception / symptom | Cause | Fix |
|---|---|---|
| `BinaryPersistenceException: Inconsistent element count` | `storageManager.store(map)` ran concurrently with a mutation. | `map.store()` (acquires internal lock). |
| `UniqueConstraintViolationException` | Duplicate on a `.withBitmapUniqueIndex(...)` field. | Handle the duplicate at the domain level; do not swallow. |
| Queries return stale data after a setter call. | Direct field mutation bypassed the indices. | `map.update(e, mutator)` / `map.apply(e, fn)`. |
| Reader threads deadlock under load. | A query iterator wasn't closed → read lock held. | Try-with-resources on every iterator. |
| Removes / updates are slow on a large map. | No identity index — falls back to compound search. | Add `.withBitmapIdentityIndex(idIndexer)` to the builder. |
| `map.index().register(Category())` returned `null`. | Category already attached (post-deserialization run). | Guard: `var i = map.index().get(SomeIndices.class); if (i == null) i = map.index().register(SomeIndices.Category(...));` |
| `LockObtainFailedException: Lock held by this virtual machine` on second `EmbeddedStorage.start(...)`. | `LuceneIndex` / `VectorIndex` weren't closed before `storage.close()`; the on-disk `write.lock` survives in the same JVM. | Close them explicitly before storage close: `luceneIndex.close(); vectorIndex.close(); storage.close();` |

## Interactions with other skills

- **`lazy-loading`** — Do **not** wrap GigaMap in `Lazy<>`; it handles its own
  segment loading.
- **`storing-data`** — Use `gigaMap.store()`, not `storageManager.store(map)`.
- **`concurrency-and-locking`** — GigaMap's internal RW lock makes single
  operations atomic; cross-aggregate atomicity still needs an
  application-level lock.
- **`root-and-object-graph`** — GigaMap lives as a root-level field.
- **`legacy-type-mapping`** — Adding / removing non-indexed fields is fine;
  changing an indexed field's type requires rebuilding the index.
- **`custom-type-handlers`** — GigaMap's own types are auto-registered; only
  the entity classes may need handlers.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a method overload
  or factory variant not in the in-line tables — e.g. additional
  `GigaQuery` terminal ops, less common indexer `.Abstract<>` overloads,
  spatial operators beyond `at`/`near`/`withinBox`, `EntityIdMatcher`
  factory variants.
- **Load `references/query-dsl.md`** when writing a query that goes
  beyond the Pattern G examples — predicates on derived keys, complex
  boolean trees, `notIn` semantics, scored-result chaining order.
- **Load `references/lucene.md`** when wiring or operating Lucene full-text
  search — Maven deps, `DocumentPopulator` shape, query syntax beyond
  `field:term`, sub-query score handling, backup / lifecycle / restart.
- **Load `references/vector-deep-dive.md`** when **designing** a vector
  index — picking embedded vs computed mode, similarity function,
  HNSW tuning, recall measurement, sharding past 2.1B vectors.
- **Load `references/vector-operations.md`** when **operating** a vector
  index — full `VectorIndexConfiguration` parameter table, restart-safe
  wiring, on-disk format + incremental mode, PQ compression, background
  tasks + eventual-indexing consistency, production checklist.
- **Load `references/examples-expanded.md`** when you want a complete
  end-to-end program template — entity + indices + root wiring +
  storage start + queries, including the embedded-mode RAG retrieval
  pattern.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a bug —
  `BinaryPersistenceException`, `UniqueConstraintViolationException`,
  stale query results after a setter call, reader-thread deadlock,
  vectorizer null / thread-safety / dimension-mismatch errors.

## Upstream sources

- `docs/modules/gigamap/pages/index.adoc`, `getting-started.adoc`, `crud.adoc`,
  `persistence.adoc`.
- `docs/modules/gigamap/pages/queries/*.adoc`.
- `docs/modules/gigamap/pages/indexing/bitmap/*.adoc`,
  `.../lucene/*.adoc`, `.../jvector/*.adoc`, `.../spatial/*.adoc`.
- `gigamap/` module source tree.
- `examples/gigamap/` — upstream examples.
