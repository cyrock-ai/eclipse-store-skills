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
| `long add(E e)` | Add an entity. Throws if null or unique constraint violated. Returns the new entity id. |
| `long addAll(E... entities)` | Batch add. Returns the last assigned id. |
| `long addAll(Iterable<? extends E>)` | Batch add. Returns the last assigned id. |
| `long remove(E e)` | Uses identity index (or compound fallback). Returns the removed entity id. |
| `long remove(E e, IndexIdentifier<E,?>... discriminators)` | Explicit lookup. `Indexer` is a subtype of `IndexIdentifier`, so passing an indexer works. |
| `E update(E e, Consumer<? super E> mutator)` | Wrap mutation so indices update. Returns the same entity. |
| `<R> R apply(E e, Function<? super E, R> logic)` | Lower-level primitive that `update` is built on. Mutates the entity, updates indices, returns the function's result. Throws `ConstraintViolationException` (and removes the entity) if the post-mutation state violates a constraint. |
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
| `long store()` | **Use this.** Acquires internal lock and stores only dirty segments. Returns the storage object id. |
| `long store(Persister)` | Same, with an explicit persister (e.g. a `StorageConnection`, which is a `Persister`). |

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

Artifact: `org.eclipse.store:gigamap-jvector`. Package
`org.eclipse.store.gigamap.jvector`.

Required JVM flag for SIMD acceleration:

```
--add-modules jdk.incubator.vector
```

Without it the index works, but distance kernels run scalar — measurably
slower for both build and search on Java 20+. Set in Surefire/Failsafe
`<argLine>` or your launcher script.

### `Vectorizer<E>`

File: `gigamap-jvector/src/main/java/org/eclipse/store/gigamap/jvector/Vectorizer.java`.

Abstract class. Subclasses extract a `float[]` from an entity.

| Method | Notes |
|---|---|
| `abstract float[] vectorize(E entity)` | **Must be thread-safe.** Must not return `null` for a present entity (throws `IllegalStateException` at insert). |
| `List<float[]> vectorizeAll(List<? extends E>)` | Default loops `vectorize(...)`. Override for batch APIs. |
| `boolean isEmbedded()` | `true` = vector lives on the entity (no separate storage). `false` (default) = stored in an internal `GigaMap<VectorEntry>`. Stable for the lifetime of the index. |

### `VectorSimilarityFunction`

Enum.

| Value | Use |
|---|---|
| `COSINE` | Default. Direction-only. Text/semantic embeddings (OpenAI, Cohere, BERT, sentence-transformers). |
| `DOT_PRODUCT` | Pre-normalized vectors; MIPS / recommendation. Cheaper than `COSINE` (no normalization) and gives identical ranking once vectors are unit-length. |
| `EUCLIDEAN` | Magnitude matters: spatial, image pixels, FaceNet, time-series, k-means clustering. |

### `VectorIndexConfiguration`

Immutable. Build via `VectorIndexConfiguration.builder()...build()` or via a
factory preset.

#### HNSW parameters

| Method | Default | Notes |
|---|---|---|
| `dimension(int)` | (required) | Length of every `float[]`. Mismatch throws on `add`. |
| `similarityFunction(VectorSimilarityFunction)` | `COSINE` | See enum table above. |
| `maxDegree(int)` | 16 | "M" — neighbours per node. Higher → better recall, more memory. PQ silently overrides to 32. |
| `beamWidth(int)` | 100 | "efConstruction" — build-time fan-out. Use ≥ `2 * maxDegree`. |
| `minSearchBeamWidth(int)` | — | Floor for search-time beam width. |
| `neighborOverflow(float)` | 1.2 | Construction overflow factor. |
| `alpha(float)` | 1.2 | Pruning parameter. |

#### On-disk + compression

| Method | Default | Notes |
|---|---|---|
| `onDisk(boolean)` | `false` | Memory-map the graph from disk. Required for datasets > RAM. |
| `indexDirectory(Path)` | `null` | Mandatory if `onDisk=true`. Files: `{name}.graph` + `{name}.meta`. |
| `enablePqCompression(boolean)` | `false` | Product Quantization. **Forces `maxDegree=32`** (FusedPQ). |
| `pqSubspaces(int)` | `0` (auto: `dimension/4`) | Must divide `dimension` evenly. |
| `parallelOnDiskWrite(boolean)` | `false` | Multi-threaded persist. Faster for large indices, more resources. |

#### Background tasks

| Method | Default | Notes |
|---|---|---|
| `eventualIndexing(boolean)` | `false` | Defer graph mutations to a background thread. Vector store updated synchronously. |
| `persistenceIntervalMs(long)` | `0` (off) | Background persist check every N ms. `> 0` enables it. |
| `minChangesBetweenPersists(int)` | 100 | Persist threshold. |
| `persistOnShutdown(boolean)` | `true` | Flush pending changes on `close()` when `onDisk=true`. |
| `optimizationIntervalMs(long)` | `0` (off) | Background `cleanup()` check every N ms. |
| `minChangesBetweenOptimizations(int)` | 1000 | Optimize threshold. |
| `optimizeOnShutdown(boolean)` | `false` | Run cleanup on `close()`. |

#### Factory presets

Static methods on `VectorIndexConfiguration`:

| Preset | Sizing | Notes |
|---|---|---|
| `forSmallDataset(int dim)` | < 10K | In-memory, `maxDegree=16`, `beamWidth=100`. |
| `forSmallDataset(int dim, VectorSimilarityFunction)` | < 10K | Pick a non-COSINE similarity. |
| `forMediumDataset(int dim)` | 10K – 1M | In-memory. |
| `forMediumDataset(int dim, Path indexDirectory)` | 10K – 1M | On-disk variant. |
| `forLargeDataset(int dim, Path indexDirectory)` | > 1M | On-disk. |
| `forLargeDataset(int dim, Path indexDirectory, boolean enableCompression)` | > 1M | On-disk + optional PQ. |
| `forHighPrecision(int dim)` | Maximum recall | In-memory; `maxDegree` 48-64, `beamWidth` 400-500. |
| `forHighPrecision(int dim, Path indexDirectory)` | Maximum recall | On-disk variant. |

Each has a `builderFor*(...)` counterpart that returns a `Builder` so you can
override one or two parameters and `.build()` from there.

### `VectorIndices<E>`

Index group. Registered on the map post-build.

```java
VectorIndices<E> vi = map.index().register(VectorIndices.Category());
```

| Method | Returns | Notes |
|---|---|---|
| `add(String name, VectorIndexConfiguration cfg, Vectorizer<? super E>)` | `VectorIndex<E>` | Throws if `name` already registered. Index existing entities synchronously. |
| `ensure(String name, VectorIndexConfiguration cfg, Vectorizer<? super E>)` | `VectorIndex<E>` | Idempotent — returns existing if present. Use on restart paths. |
| `get(String name)` | `VectorIndex<E>` | Or `null`. |
| `accessIndices(Consumer<XGettingTable<String, ? extends VectorIndex<E>>>)` | `void` | Lock-protected access to the table. |
| `iterate(Consumer<? super VectorIndex<E>>)` | `void` | Lock-protected iteration. |

Index name is used as the on-disk file prefix (`{name}.graph`, `{name}.meta`),
so it must be a valid filename: non-empty, ≤ 200 chars, no `/` or `\`. Names
are validated at `add`/`ensure` time.

### `VectorIndex<E>`

Handle for one named vector index.

| Method | Returns | Notes |
|---|---|---|
| `name()` | `String` | The index name. |
| `parent()` | `VectorIndices<E>` | Back-reference. |
| `configuration()` | `VectorIndexConfiguration` | Immutable. |
| `vectorizer()` | `Vectorizer<? super E>` | The user's vectorizer. |
| `search(float[] query, int k)` | `VectorSearchResult<E>` | Top-k. |
| `search(float[] query, int k, int searchBeamWidth)` | `VectorSearchResult<E>` | Per-query beam-width override. |
| `search(E queryEntity, int k)` | `VectorSearchResult<E>` | "More like this" — vectorizes `queryEntity` and searches. |
| `search(E queryEntity, int k, int searchBeamWidth)` | `VectorSearchResult<E>` | Same with beam-width override. |
| `getVector(long entityId)` | `float[]` | Stored vector for an entity. |
| `optimize()` | `void` | `cleanup()` the graph. Drains the indexing queue first if `eventualIndexing`. |
| `persistToDisk()` | `void` | No-op for in-memory indices. Drains queue, flushes graph + meta to disk. |
| `isOnDisk()` | `boolean` | |
| `isPqCompressionEnabled()` | `boolean` | |
| `close()` | `void` | Flushes per `persistOnShutdown` / `optimizeOnShutdown`, releases resources. Called automatically when the parent storage closes. |

### `VectorSearchResult<E>`

Extends `ScoredSearchResult<E>` (from the parent gigamap module). Iterable
of `Entry<E>` ordered by descending similarity.

| Method on `Entry<E>` | Returns | Notes |
|---|---|---|
| `entity()` | `E` | Lazy — calls `parentMap.get(entityId)` on first access. |
| `score()` | `float` | Similarity score (interpretation depends on `VectorSimilarityFunction`). |
| `entityId()` | `long` | The GigaMap entity id (== HNSW ordinal). |

`VectorSearchResult` is also a `GigaMap.SubQuery`, so it composes with bitmap
and Lucene via `gigaMap.query(...).and(vectorSearchResult)` (intersection by
id set, scores dropped). Inverting the chain — `vectorSearchResult.and(gigaQuery)`
— returns a `ScoredSearchResult` that preserves scores.

### Files on disk

`{name}.graph` (JVector `OnDiskGraphIndex`) + `{name}.meta` (24-byte
sidecar). On-disk format, restart / incremental mode, mismatch rebuild
semantics → `vector-operations.md § On-disk lifecycle`.

## Sub-queries

| Type | Source |
|---|---|
| `GigaQuery<E>` | `gigaMap.query(...)` |
| `LuceneSearchResult<E>` | `luceneIndex.search("...", n)` |
| `VectorSearchResult<E>` | `vectorIndex.search(vec, n)` |
| `ScoredSearchResult<E>` | `luceneSearchResult.and(gigaQuery)` / `vectorSearchResult.and(gigaQuery)` |
| `EntityIdMatcher.Ascending(long... sortedIds)` | Ad-hoc fixed set |

All combine via `.and(SubQuery)` (logical AND).

**Score handling.** Calling `gigaQuery.and(scoredSubQuery)` drops scores —
only the matching id set is intersected. To keep scores, invert the chain:
`scoredSubQuery.and(gigaQuery)` returns a `ScoredSearchResult` whose order
preserves the original ranking.

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
