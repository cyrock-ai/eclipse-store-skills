# API catalogue — gigamap

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `GigaMap<E>`

File: `gigamap/src/main/java/org/eclipse/store/gigamap/types/GigaMap.java`.

### Factory / builder

| Method | Purpose |
|---|---|
| `GigaMap.New()` | Empty map, identity equality, no indexes. |
| `GigaMap.New(Equalator)` | With custom equalator (e.g., `XHashing.hashEqualityValue()`). |
| `GigaMap.<E>Builder()` | Fluent builder. |
| `builder.withBitmapIdentityIndex(indexer)` | Identity index — unique id per entity. |
| `builder.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. |
| `builder.withBitmapIndex(indexer)` | Non-unique bitmap. Also the registration path for `SpatialIndexer`. |
| `builder.withValueEquality()` / `withIdentityEquality()` | Control CRUD equalator. |
| `builder.build()` | Finalize and return the map. |

Lucene and vector indexes are **not** declared on the builder — they're
registered post-build on `map.index()` (see sections below).

### CRUD

| Method | Notes |
|---|---|
| `long add(E e)` | Add an entity. Throws if null or unique constraint violated. |
| `long[] addAll(E... entities)` | Batch add. |
| `long[] addAll(Iterable<E>)` | Batch add. |
| `boolean remove(E e)` | Uses identity index (or compound fallback). |
| `boolean remove(E e, Indexer... discriminators)` | Explicit lookup. |
| `void update(E e, Consumer<E> mutator)` | Wrap mutation so indices update. |
| `void apply(E e, Consumer<E> reader)` | Read-only version. |
| `E get(long entityId)` | By internal id. |
| `long size()` | Entity count. |
| `void clear()` | Remove all. |

### Iteration

| Method | Notes |
|---|---|
| `Iterator<E> iterator()` | Closeable. Try-with-resources. |
| `Stream<E> stream()` | Closeable. Try-with-resources. |

### Query

| Method | Returns |
|---|---|
| `GigaQuery<E> query()` | All entities. |
| `GigaQuery<E> query(Condition)` | Filtered. |

### Persistence

| Method | Notes |
|---|---|
| `void store()` | **Use this.** Acquires internal lock and stores only dirty segments. |
| `void store(StorageConnection)` | Same, with explicit connection. |

Do not call `storageManager.store(gigaMap)` without external `synchronized(map)`.

## `GigaQuery<E>`

| Method | Returns |
|---|---|
| `GigaQuery<E> and(Condition)` / `and(SubQuery)` | Intersection. |
| `GigaQuery<E> or(Condition)` | Union with condition. |
| `List<E> toList()` | Materialize all hits. |
| `long count()` | Count hits without loading entities. |
| `Stream<E> stream()` | Closeable. |
| `Iterator<E> iterator()` | Closeable. |
| `Optional<E> findFirst()` | First hit. |
| `GigaQuery<E> skip(long n)` / `limit(long n)` | Pagination. |

`GigaQuery` itself implements `GigaMap.SubQuery`, so queries combine with
`.and(subQuery)`.

## Indexer base classes

All in `org.eclipse.store.gigamap.types`.

| Class | Extract type |
|---|---|
| `IndexerString.Abstract<E>` | `String` |
| `BinaryIndexerUUID.Abstract<E>` | `UUID` |
| `IndexerLocalDate.Abstract<E>` | `LocalDate` |
| `IndexerLocalDateTime.Abstract<E>` | `LocalDateTime` |
| `IndexerInstant.Abstract<E>` | `Instant` |
| `IndexerByte.Abstract<E>` | `byte` |
| `IndexerShort.Abstract<E>` | `short` |
| `IndexerInteger.Abstract<E>` | `int` / `Integer` |
| `IndexerLong.Abstract<E>` | `long` / `Long` |
| `IndexerFloat.Abstract<E>` | `float` / `Float` |
| `IndexerDouble.Abstract<E>` | `double` / `Double` |
| `IndexerBoolean.Abstract<E>` | `boolean` / `Boolean` |
| `IndexerEnum.Abstract<E, K extends Enum<K>>` | Enum |
| `IndexerMultiValue.Abstract<E, K>` | Collection of K per entity |

Pattern:

```java
public static final IndexerString<Person> lastName = new IndexerString.Abstract<>() {
    @Override public String getString(Person p) { return p.lastName(); }
};
```

Each indexer produces a set of query operators. For `IndexerString`: `.is(...)`,
`.in(...)`, `.not(...)`, `.notIn(...)`, `.is(predicate)`.

For temporal / numeric: `.greaterThan`, `.lessThan`, `.between`, `.isYear`,
`.before`, `.after`.

For `IndexerMultiValue`: `.is(key)` (contains), `.in(...)` (any-of), `.all(...)`
(all-of), `.not(...)` / `.notIn(...)`.

## Spatial indexer

Part of the core `gigamap` artifact.

File: `gigamap/gigamap/src/main/java/org/eclipse/store/gigamap/types/SpatialIndexer.java`.

```java
public class LocationIndex extends SpatialIndexer.Abstract<Store> {
    @Override protected Double getLatitude (Store s) { return s.lat(); }
    @Override protected Double getLongitude(Store s) { return s.lon(); }
}
```

Register via the bitmap path — `SpatialIndexer` is a specialized bitmap
indexer.

```java
GigaMap<Store> map = GigaMap.<Store>Builder()
    .withBitmapIndex(new LocationIndex())
    .build();
```

Operators on the `SpatialIndexer` interface (all return
`Condition<S>` — index-driven, combinable in `map.query(...)`):

| Operator | Meaning |
|---|---|
| `at(lat, lon)` | Exact coordinate match. |
| `near(lat, lon, radiusKm)` | **Bounding-box approximation** of the given radius. Uses Earth-radius conversion with `cos(lat)` longitude correction. Includes points up to ~√2 × `radiusKm` in the box corners. |
| `withinBox(minLat, maxLat, minLon, maxLon)` | Axis-aligned bounding box. |
| `latitudeBetween(min, max)` / `longitudeBetween(min, max)` | 1-D range. |
| `latitudeAbove(v)` / `latitudeBelow(v)` / `longitudeAbove(v)` / `longitudeBelow(v)` | 1-D bound. |
| `isNull()` | Missing coordinates. |

On `SpatialIndexer.Abstract<E>` (concrete subclass) there's also:

| Method | Returns | Meaning |
|---|---|---|
| `withinRadius(lat, lon, radiusKm)` | `Predicate<E>` | **Exact** haversine distance filter. Not a `Condition` — not index-driven. Use as a stream `filter` after a `near` pre-select. |

And a static helper on the `SpatialIndexer` interface:

| Method | Returns | Meaning |
|---|---|---|
| `SpatialIndexer.haversineDistance(lat1, lon1, lat2, lon2)` | `double` | Great-circle distance in km. |

Exact-radius idiom:

```java
var exact = loc.withinRadius(lat, lon, radiusKm);
List<E> hits = map.query(loc.near(lat, lon, radiusKm))
    .stream()
    .filter(exact)
    .toList();
```

Points only; no polygons or linestrings.

## Lucene index

Artifact: `org.eclipse.store:gigamap-lucene`.

Relevant types (in `org.eclipse.store.gigamap.lucene`):

| Type | Purpose |
|---|---|
| `DocumentPopulator<E>` | Abstract — override `populate(Document, E)` to map an entity into a Lucene `Document`. |
| `LuceneContext<E>` | Holds the index directory + populator. Create via `LuceneContext.New(Path, DocumentPopulator<E>)`. |
| `LuceneIndex<E>` | Handle for queries. Obtained via `map.index().register(LuceneIndex.Category(ctx))`. |
| `LuceneSearchResult<E>` | Scored, `SubQuery`-compatible iterable of `ScoredSearchResult.Entry<E>`. |

Methods on `LuceneIndex<E>`:

| Method | Returns |
|---|---|
| `query(String q)` | `List<E>` — plain list. |
| `query(String q, int limit)` | `List<E>` — bounded. |
| `query(String q, Consumer<ScoredSearchResult.Entry<E>>)` | Streamed with scores. |
| `search(String q, int limit)` | `LuceneSearchResult<E>` — combinable `SubQuery`. |

Query syntax is standard Lucene: `field:term`, `AND`/`OR`/`NOT`,
`"phrase"`, `wild*`, `fuzzy~`, ranges `[a TO b]`.

## Vector index (jvector)

Artifact: `org.eclipse.store:gigamap-jvector`.

Relevant types (in `org.eclipse.store.gigamap.jvector`):

| Type | Purpose |
|---|---|
| `Vectorizer<E>` | Abstract — override `vectorize(E)` returning `float[]`, and `isEmbedded()` returning `boolean`. |
| `VectorIndexConfiguration` | Immutable config. Build via `VectorIndexConfiguration.builder().dimension(int).similarityFunction(VectorSimilarityFunction).build()`. |
| `VectorSimilarityFunction` | Enum: `COSINE`, `DOT_PRODUCT`, `EUCLIDEAN`. |
| `VectorIndices<E>` | Category registered on the map; holds named `VectorIndex<E>` instances. |
| `VectorIndex<E>` | Handle for queries. |
| `VectorSearchResult<E>` | Scored, `SubQuery`-compatible iterable. |

Registration and search:

```java
VectorIndices<Doc> vi = map.index().register(VectorIndices.Category());
VectorIndex<Doc>   idx = vi.add("embeddings", cfg, new DocVectorizer());
VectorSearchResult<Doc> top = idx.search(queryVec, 10);
```

`VectorIndices.add(name, cfg, vectorizer)` allows multiple named vector
indexes per map.

## Sub-queries

| Type | Source |
|---|---|
| `GigaQuery<E>` | `gigaMap.query(...)` |
| `LuceneSearchResult<E>` | `luceneIndex.search("...", n)` |
| `VectorSearchResult<E>` | `vectorIndex.search(vec, n)` |
| `EntityIdMatcher.Ascending(long... sortedIds)` | Ad-hoc fixed set |

All combine via `.and(SubQuery)` (logical AND).

## Equality

- Default: identity equality — two distinct instances are different even with
  equal fields.
- Value equality: `GigaMap.New(XHashing.hashEqualityValue())`.

## Annotations (simple cases)

Declarative indexing without an `Indices` class:

```java
public class Person {
    @Identity private UUID id;
    @Index    private String lastName;
    @Unique   private String email;
}
```

The `GigaMap.Builder` will discover these via reflection. For non-trivial
indices (multi-value, derived keys) use explicit indexers.

## Exceptions

- `UniqueConstraintViolationException` — adding duplicate to unique index.
- `BinaryPersistenceException: Inconsistent element count` — concurrent
  modification during serialization (caused by `storageManager.store(map)`
  without sync).
