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
  "gigaMap.store", "reindex", "stale index", "@Index", "@FullText",
  "IndexerGenerator", "register an index later", "billions of rows", or asks
  why `storageManager.store(gigaMap)` is unsafe.

  **Vector / embedding triggers (apply at design time too).** Apply when the
  user is designing or building anything involving embeddings or similarity:
  "vector similarity search", "kNN" / "ANN" / "HNSW", "embeddings", "vector
  index" / "vector store" / "vector database", "jvector", "VectorIndex",
  "VectorIndices", "VectorIndexConfiguration", "Vectorizer",
  "VectorSearchResult", "COSINE / DOT_PRODUCT / EUCLIDEAN", "PQ compression",
  "NVQ", "ApproximateScoring", "on-disk vector index", "vector file",
  "eventual indexing", "embedded vs computed vectors", "allowsNullVectors",
  "@Vector", "IndexLocation", "named index location", "IndexLocations.bind".
  Eclipse Store ships an HNSW vector index via the `gigamap-jvector` artifact
  (Java 25+) that integrates with bitmap / Lucene via sub-queries.
version: 0.6.0
---

# Eclipse Store — GigaMap (Indexed, Queryable, Lazy Large Collections)

Segmented, index-backed, lazily-loaded collection. Multiple index types
(bitmap, identity, unique, spatial, Lucene, vector), composable via
sub-queries. Mutations must go through `add`/`remove`/`update`/`apply`/
`set`/`replace` — direct entity mutation leaves indices stale. Verified
against Eclipse Store 4.3.0.

## Do NOT use this skill

- Small collection (< 100K) → plain `ArrayList` / `HashMap`, optionally
  `Lazy<>`-wrapped.
- SQL-like query semantics → not this API.
- Cross-process value cache → `cache-jcache`.

## Maven setup

All under `groupId=org.eclipse.store`, `version=${eclipse-store.version}`:

| `artifactId` | Required for |
|---|---|
| `gigamap` | Core + bitmap + spatial + annotations + `IndexLocation`. Java 17+. |
| `gigamap-lucene` | Full-text. Add `lucene-core` + `lucene-queryparser` 9.8.0 yourself (they are `provided`). |
| `gigamap-jvector` | HNSW vector similarity. **Java 25+** (compiled with release 25). |
| `gigamap-codegen` | Optional annotation processor: compile-time `Entity_` metamodel. |

## Core API

From `org.eclipse.store.gigamap.types`:

| Symbol | Purpose |
|---|---|
| `GigaMap<E>` | The collection. |
| `GigaMap.New()` / `GigaMap.New(Equalator<? super E>)` | No-index map, identity / custom equality. |
| `GigaMap.<E>Builder()` | Fluent builder for indexed map. |
| `.withBitmapIdentityIndex(indexer)` | Identity index (how entities are looked up for `remove` / `update`). Not a uniqueness guarantee. |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. |
| `.withBitmapIndex(indexer)` | Non-unique bitmap index (also used for `SpatialIndexer`). |
| `.withCustomConstraint(constraint)` | Custom validation (named class — it is persisted with the map). |
| `.withIdentityEquality()` / `.withValueEquality()` | Equality mode for the indexed map (default: identity). |
| `.build()` | Create the map. |
| `map.index().bitmap().add(indexer)` / `.ensure(indexer)` / `.update(indexer)` / `.removeIndex(name)` | Register / replace / drop a bitmap index **after** build, also on a populated map (back-filled, all-or-nothing). |
| `map.index().register(LuceneIndex.Category(ctx))` | Attach a Lucene full-text index post-build. |
| `map.index().register(VectorIndices.Category())` then `vectorIndices.ensure(name, cfg, vectorizer)` | Attach a jvector similarity index. |
| `map.add(e)` / `map.remove(e)` / `map.update(e, mutator)` / `map.apply(e, fn)` | The only safe entry points for in-place mutation. |
| `map.set(entityId, replacement)` / `map.replace(current, replacement)` / `map.removeById(id)` | Install a *different* instance (records, immutable entities) / index-free removal. |
| `map.reindex()` | Rebuild every index from the current entity state (after a direct mutation or class evolution of an indexed field). |
| `map.store()` | Persist (acquires GigaMap's internal lock). Never use `storageManager.store(map)` directly. `map.store(storer)` registers into a `Storer` for a multi-map atomic commit. |
| `GigaQuery<E>` | Fluent query — `.toList()`, `.toList(offset, limit)`, `.count()`, `.findFirst()`, `.iterator()` (try-with-resources). No `skip` / `limit`. |

Indexer base classes and the method each one demands — every single-value
getter is `protected abstract` (overriding it as `public` compiles):

| Indexer | For type | Override |
|---|---|---|
| `IndexerString.Abstract<E>` | `String` | `protected String getString(E)` |
| `BinaryIndexerUUID.Abstract<E>` | `UUID` (high cardinality) | `protected UUID getUUID(E)` |
| `IndexerLocalDate` / `IndexerLocalDateTime` / `IndexerInstant` `.Abstract<E>` | `java.time` | `protected LocalDate getLocalDate(E)` etc. |
| `IndexerInteger` / `IndexerLong` / `IndexerDouble` / `IndexerFloat` / `IndexerByte` / `IndexerBoolean` `.Abstract<E>` | wrappers, low cardinality | `protected Integer getInteger(E)` etc. |
| `ByteIndexerInteger` / `ByteIndexerLong` / … `.Abstract<E>` | high-cardinality numerics **with** range queries | `protected Integer getInteger(E)` etc. |
| `IndexerMultiValue.Abstract<E, K>` | `Iterable<K>` | `public Iterable<? extends K> indexEntityMultiValue(E)` + `public Class<K> keyType()` |

Annotations — `@Index` (`kind = LOW_CARDINALITY / BINARY / BIT_SLICED`),
`@Identity`, `@Unique`, class-level `@SpatialIndex(latitude=…, longitude=…)`,
`@FullText` (`gigamap-lucene`), `@Vector(dimension = …)` (`gigamap-jvector`) on
fields or no-arg getters. They are generated at runtime by `IndexerGenerator`,
**not** discovered by the `Builder`:

```java
GeneratedIndices<Person> idx = IndexerGenerator.AnnotationBased(Person.class)
    .register(LuceneAnnotationHandler.New())     // only if @FullText is used
    .register(VectorAnnotationHandler.New())     // only if @Vector is used
    .generateIndices(map);                       // idempotent, back-fills a populated map
map.query(idx.getIndexerString("lastName").is("Smith"));
```

With the `gigamap-codegen` annotation processor the same annotations yield
a compile-time `Person_` class: `Person_.registerIndices(map)` and typed
constants `Person_.lastName`.

## Index types in depth

### Bitmap — exact + range, the default

Off-heap bit sets keyed by entity value; equality, `in`-list, range, and
predicate queries on scalar or collection-valued fields.

| Builder method | Semantics |
|---|---|
| `.withBitmapIdentityIndex(indexer)` | Used internally for `remove` / `update` lookup. **Not** unique — add `.withBitmapUniqueIndex` for that. |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. Duplicate → `UniqueConstraintViolationException`. |
| `.withBitmapIndex(indexer)` | Non-unique; many entities per key. Also the path for `SpatialIndexer`. |

High-cardinality keys (ids, UUIDs): `BinaryIndexer*` (equality only) or
`ByteIndexer*` (numerics with range queries). Operator catalogue → `references/query-dsl.md`.

### Lucene — full-text search with scoring

Separate artifact (`gigamap-lucene`). Use for analyzer-driven tokenization,
phrase, wildcard, fuzzy, or score-ranked results. Wire post-build with the
restart-safe get-or-register idiom (after deserialization the category is
already attached, so `register(...)` would return `null`):

```java
LuceneIndex<E> lucene = map.index().get(LuceneIndex.class);
if (lucene == null) lucene = map.index().register(LuceneIndex.Category(ctx));
```

`ctx` is a `LuceneContext` bound to a `DocumentPopulator<E>`:
`LuceneContext.New(populator)` keeps the index data **inside the object
graph** (persisted with the map); `LuceneContext.New(path, populator)` uses an
MMap directory; `LuceneContext.New(DirectoryCreator.MMap(IndexLocation.Named("fulltext")), populator)`
binds the directory at runtime (`references/index-locations.md`).
`lucene.query(q)` returns `List<E>`; `lucene.search(q, k)` returns a
`LuceneSearchResult<E>` that's sub-queryable via `.and(...)` (Pattern H).
**Storage shutdown closes every index of a loaded map** — no explicit
`close()` before `storage.shutdown()`. Back up an MMap directory **together
with** the storage directory. Detail (Maven deps, query syntax, commits,
repair) in `references/lucene.md`.

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
```

Index-driven `Condition`s: `at`, `near(lat, lon, radiusKm)` (**bounding
box**, corners up to √2 × radius), `withinBox`, `latitudeBetween` /
`longitudeBetween`, `latitudeAbove` / `Below`, `isNull`. Exact circle:
post-filter with the `Predicate` `loc.withinRadius(lat, lon, radiusKm)`
after a `near` pre-select; `SpatialIndexer.haversineDistance(...)` is the
public km helper. Points only. Full table → `references/query-dsl.md`.

### Vector — HNSW similarity search via jvector

Separate artifact (`gigamap-jvector`), **Java 25+**. Wraps
[JVector](https://github.com/datastax/jvector) (HNSW kNN): named vector
indices, automatic mutation broadcast, lazy results, sub-queryable with
bitmap and Lucene (Pattern H).

> **JVM flags.** `--add-modules jdk.incubator.vector` (SIMD scoring, scalar
> fallback without it) and `--enable-native-access=ALL-UNNAMED` (jvector's
> memory-mapped graph reader). Put both in the launcher and in Surefire's
> `<argLine>`.

**The storage holds no vectors.** Each index keeps them in a memory-mapped
*vector file* (`<name>.vec`), a cache the index rebuilds by calling the
vectorizer again — so `vectorize()` must reproduce the committed vector of
a persisted entity. `Vectorizer<E>.isEmbedded()` says where it comes from:
**embedded** = a field of the entity, **computed** (default) = derived by the
vectorizer (embedding API). A computed index needs `indexDirectory(...)` /
`indexLocation(...)` to keep its vector file across restarts; without one it
re-vectorizes **every entity at every start, blocking the map**. Mode is
fixed at build.

```java
public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) { return d.embedding(); }
    @Override public boolean isEmbedded()     { return true; }
}

GigaMap<Doc> docs = GigaMap.New();
VectorIndexConfiguration cfg = VectorIndexConfiguration.forMediumDataset(768);   // (1)

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

(1) Presets `forSmallDataset` / `forMediumDataset` / `forLargeDataset` /
`forCompactLargeDataset` / `forHighPrecision`, each with a `builderFor*`
twin to override one parameter (e.g. `.indexDirectory(path)` for a computed
vectorizer). (2) `ensure` is the restart-safe sibling of `add` — on the
second run it returns the existing index **unchanged** (a changed `cfg` is
ignored; reconfigure via `removeIndex` + `add`).

`null` vectors throw unless the vectorizer opts in with `allowsNullVectors()`
(entity stays in the map, excluded from the index). **Storage shutdown closes
every vector index of a loaded map** — no explicit `close()`. Design-side
detail → `references/vector-deep-dive.md`; operations (parameters, files on
disk, NVQ / PQ, background tasks, 4.x upgrade) → `references/vector-operations.md`.

## Idiomatic patterns

### Pattern A — Define indices as constants

```java
public final class PersonIndices {
    public static final BinaryIndexerUUID<Person> id = new BinaryIndexerUUID.Abstract<>() {
        @Override protected UUID getUUID(Person p) { return p.id(); }       // (1)
    };
    public static final IndexerString<Person> lastName = new IndexerString.Abstract<>() {
        @Override protected String getString(Person p) { return p.lastName(); } // (2)
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

(1) `BinaryIndexerUUID` is the high-cardinality variant for ids. (2) All
single-value getters are `protected`. (3) `IndexerMultiValue` overrides two
`public` methods. The persisted index name defaults to
`{outer class FQCN}.{field}` — override `name()` to decouple it from the
Java identifier before refactoring.

### Pattern B — Build a GigaMap

```java
GigaMap<Person> map = GigaMap.<Person>Builder()
    .withBitmapIdentityIndex(PersonIndices.id)
    .withBitmapIndex(PersonIndices.lastName)
    .withBitmapIndex(PersonIndices.birthDate)
    .build();
```

Indices can also be registered later, on a populated map — the back-fill
runs the indexer over every entity, all-or-nothing:

```java
map.index().bitmap().ensure(PersonIndices.tags);     // get-or-create, restart-safe
map.index().bitmap().update(PersonIndices.lastName); // same name, new logic
```

### Pattern C — Add, query, store

```java
map.add(new Person(UUID.randomUUID(), "Alice", "Smith", LocalDate.of(1990, 1, 1)));
map.add(new Person(UUID.randomUUID(), "Bob", "Smith", LocalDate.of(1985, 6, 15)));

List<Person> smiths = map.query(PersonIndices.lastName.is("Smith")).toList();

GigaQuery<Person> adults = map.query(
    PersonIndices.birthDate.before(LocalDate.of(2005, 1, 1))
      .and(PersonIndices.lastName.is("Smith"))
);
long n = adults.count();
List<Person> page = adults.toList(200, 100);   // offset, limit

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

Both also exist as `update(entityId, …)` / `apply(entityId, …)` for maps
without a bitmap index (Lucene-only, vector-only); the id comes from
`iterateIndexed` or a scored result's `entityId()`.

**Records / immutable entities.** `update` / `apply` rely on in-place
mutation. Use `map.replace(old, newInstance)` or `map.set(entityId, newInstance)`
instead: the new instance is indexed in place of the old one. Passing the
instance the map already holds throws `IllegalArgumentException` — `set` /
`replace` are not a way to write back an entity you mutated yourself.

### Pattern E — Remove

```java
map.remove(person);                          // identity index if present
map.remove(person, PersonIndices.lastName);  // explicit index
map.removeById(entityId);                    // no bitmap index needed
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

If you forget: a mutation from the thread that still holds the open iterator
throws `IllegalStateException` ("Self-deadlock detected"); writers on other
threads wait until the iterator is closed — potentially forever.

### Pattern G — Query DSL (boolean / range / predicate / multi-value)

```java
// Boolean combinations
map.query(lastName.is("Smith").and(birthDate.isYear(1990)));
map.query(lastName.is("Smith").or(lastName.is("Jones")));
map.query(lastName.in("Smith", "Jones", "Brown"));
map.query(lastName.not("Smith"));
map.query(lastName.startsWith("Sm"));

// Range (numeric + temporal indexers)
map.query(price.between(10, 100));
map.query(birthDate.before(LocalDate.now().minusYears(18)));
map.query(birthDate.isMonth(6));          // int, not java.time.Month

// Predicate on the index key
map.query(lastName.is(n -> n.length() > 5));

// Multi-value indexer (e.g. IndexerMultiValue<Person, Interest>)
map.query(interests.is(Interest.SPORTS));         // contains SPORTS
map.query(interests.all(Interest.SPORTS, Interest.LITERATURE)); // contains both
```

Full operator catalogue (`greaterThan`, `lessThanEqual`, `isYear`, `isMonth`,
`after`, `before`, `notIn`, `contains`, multi-value `.in`/`.not`/`.notIn`, …)
lives in `references/query-dsl.md`.

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

IndexLocations.bind("vectors", dir);          // only with IndexLocation.Named, before start
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
lastNameIndex)` looks in the wrong bucket. A later `update` does **not** undo
it (the previous keys are gone).

**Fix.** `map.update(person, p -> p.setLastName("Jones"))`. If the direct
mutation already happened: `storageManager.store(person); map.reindex(); map.store();`.

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

**Fix.** `map.store()`. It acquires GigaMap's internal lock. For one commit
spanning several maps and the root, register through the map into a
`Storer` and commit once:

```java
Storer storer = storageManager.createStorer();
mapA.store(storer); mapB.store(storer); storer.store(root);
storer.commit();
```

If you must go through storage manager: `synchronized (map) { storageManager.store(map); }`.

### Anti-pattern 4 — Leaving iterators / streams open

```java
// WRONG
Iterator<Person> it = map.query(...).iterator();
process(it.next());   // iterator never closed → read lock never released
```

**Fix.** Try-with-resources: `try (var it = map.query(...).iterator()) { ... }`.

### Anti-pattern 5 — Ignoring `UniqueConstraintViolationException`

Adding two entities that collide on a unique index throws
`UniqueConstraintViolationException`. Catching and swallowing breaks the
GigaMap's invariants. Handle the duplicate at the domain level.

### Anti-pattern 6 — Computed vectorizer without a directory

```java
// WRONG — every start calls the embedding API once per entity, under the map's lock
indices.ensure("embeddings", VectorIndexConfiguration.forMediumDataset(768), new OpenAIVectorizer());
```

**Fix.** `builderForMediumDataset(768).indexDirectory(Path.of("data/vectors")).build()`
(or `.indexLocation(IndexLocation.Named("vectors"))`) so the vector file is kept.

## Pitfalls & gotchas

1. **Direct mutations and evolved indexed fields need `reindex()`.** Indices
   are a derived cache restored verbatim from storage. A field written
   without `update` / `apply`, or renamed / retyped between releases without
   a value-preserving legacy mapping, leaves them stale (`StaleIndexException`
   on the next update). Store the entities, call `reindex()`, then `store()`.
2. **`gigaMap.store()`'s lock covers GigaMap operations only.** Stored
   *elements* can still be mutated by another thread during the store — the
   GigaMap stays consistent but the persisted element graph may not.
   Cross-aggregate atomicity needs an application-level lock spanning both.
   See `concurrency-and-locking`.
3. **Null forbidden.** `map.add(null)` throws. Use sentinels for "absent".
4. **No structural modification during iteration.** Calling `add` / `remove` /
   `update` / `apply` from inside `forEach` / `iterate` / a query consumer
   throws `IllegalStateException`. Collect matches first, mutate after the
   iteration. `store()` during iteration is allowed.
5. **Constraint violations in `update` / `apply` remove the entity.** The
   in-place mutation cannot be rolled back, so the map drops the entry and
   throws `ConstraintViolationException` (carrying the entity). Index
   failures (indexer throws, wrong vector dimension) keep the entity.
6. **Sub-queries must come from the same GigaMap.** Combining queries across
   maps is invalid.
7. **`ensure(...)` never reconfigures.** `bitmap().ensure(indexer)` and
   `vectorIndices.ensure(name, cfg, vectorizer)` return the existing index
   unchanged; use `bitmap().update(indexer)` / `removeIndex` + `add`.

## Symptom → fix

| Exception / symptom | Cause | Fix |
|---|---|---|
| `BinaryPersistenceException: Inconsistent element count` | `storageManager.store(map)` ran concurrently with a mutation. | `map.store()` (acquires internal lock). |
| `UniqueConstraintViolationException` | Duplicate on a `.withBitmapUniqueIndex(...)` field. | Handle the duplicate at the domain level; do not swallow. |
| `UniqueConstraintViolationExceptionBitmap` from `reindex()` | Two entities share a unique key (typically after class evolution). | Re-distinguish the colliding entities via `update`, call `reindex()` again. |
| Queries return stale data after a setter call. | Direct field mutation bypassed the indices. | `map.update(e, mutator)` / `map.apply(e, fn)`; already happened → `reindex()`. |
| `StaleIndexException` on `update` / `set` | Index keys predate a direct mutation or class evolution. | `map.reindex(); map.store();` |
| `IllegalArgumentException` from `set(id, entity)` / `replace(e, e)` | Passed the instance the map already holds. | `update` / `apply` for in-place changes; `set` / `replace` take a *new* instance. |
| Writers block / time out under load. | A query iterator wasn't closed → read lock held. | Try-with-resources on every iterator. |
| `IllegalStateException: Self-deadlock detected...` | Mutation on the thread that still holds an open iterator. | Close the iterator (try-with-resources) before mutating. |
| `IllegalStateException: ...must not be structurally modified during iteration.` | `add` / `remove` / `update` called inside `forEach` / `iterate` / a query consumer. | Collect first, mutate after the iteration. |
| Removes / updates are slow on a large map. | No identity index — falls back to compound search. | Add `.withBitmapIdentityIndex(idIndexer)` to the builder. |
| `map.index().register(Category())` returned `null`. | Category already attached (post-deserialization run). | Guard: `var i = map.index().get(SomeIndices.class); if (i == null) i = map.index().register(SomeIndices.Category(...));` |
| `IllegalStateException: indexDirectory or indexLocation is required when onDisk is true` | On-disk vector config without a directory. | `.indexDirectory(path)` or `.indexLocation(IndexLocation.Named(...))`. |
| Startup fails naming an index and an unbound location name. | `IndexLocation.Named` used without `IndexLocations.bind`. | Bind the name before `EmbeddedStorage.start(...)`. |
| Every start calls the embedding service once per entity / start blocks on a vector index. | In-memory computed vector index without a directory → temporary vector file. | Configure `indexDirectory` / `indexLocation`. |
| `IllegalStateException: Vectorizer returned null` | Entity without an embedding. | Opt in with `allowsNullVectors()` or don't add it. |
| `LockObtainFailedException: Lock held by this virtual machine` | Two storages / maps in one JVM share a Lucene directory (shutdown already closes indices). | One directory per index; distinct `IndexLocation.Named` names per storage. |

## Interactions with other skills

- **`lazy-loading`** — Do **not** wrap GigaMap in `Lazy<>`; it handles its own
  segment loading.
- **`storing-data`** — Use `gigaMap.store()`, not `storageManager.store(map)`;
  `gigaMap.store(storer)` for a multi-object atomic commit.
- **`concurrency-and-locking`** — GigaMap's internal RW lock makes single
  operations atomic; cross-aggregate atomicity still needs an
  application-level lock.
- **`root-and-object-graph`** — GigaMap lives as a root-level field.
- **`legacy-type-mapping`** — Adding / removing non-indexed fields is fine;
  renaming / retyping an **indexed** field needs a value-preserving mapping
  or a `reindex()` on first start.
- **`custom-type-handlers`** — GigaMap's own types are auto-registered; only
  the entity classes may need handlers.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** for method overloads and factory
  variants — `GigaQuery` terminal ops, `BitmapIndices` lifecycle, Lucene /
  vector factories, presets, `EntityIdMatcher`.
- **Load `references/query-dsl.md`** when a query goes beyond Pattern G —
  string / temporal operators, `notIn` semantics, pagination, scored-result
  chaining order.
- **Load `references/lucene.md`** when wiring or operating Lucene — Maven
  deps, `DocumentPopulator`, in-graph vs MMap directories, commits, syntax,
  repair.
- **Load `references/index-locations.md`** when a storage with on-disk
  vector or MMap Lucene indices is moved, copied, restored or deployed —
  `IndexLocation.Named`, `IndexLocations.bind`, `changeIndexLocation`.
- **Load `references/vector-deep-dive.md`** when **designing** a vector
  index — embedded vs computed, vectorizer contract, similarity function,
  HNSW tuning, recall measurement, sharding past 2.1B.
- **Load `references/vector-operations.md`** when **operating** one — full
  parameter table, where the vectors live, files on disk, NVQ / PQ,
  background tasks, 4.x upgrade, production checklist.
- **Load `references/examples-expanded.md`** for complete program
  templates — entity + indices + root wiring + storage + queries, embedded
  RAG retrieval, computed vectorizer with a kept vector file.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a bug —
  `BinaryPersistenceException`, stale results after a setter call, starved
  writers / self-deadlock, vectorizer null / buffer / dimension errors,
  re-vectorization at every start.

## Upstream sources

- `docs/modules/gigamap/pages/{index,getting-started,crud,persistence,constraints}.adoc`,
  `queries/*.adoc`, `indexing/{annotations,index-locations}.adoc`,
  `indexing/{bitmap,lucene,jvector,spatial}/*.adoc`.
- `gigamap/{gigamap,lucene,jvector,codegen}` module source trees.
- `examples/gigamap/` — upstream examples.
