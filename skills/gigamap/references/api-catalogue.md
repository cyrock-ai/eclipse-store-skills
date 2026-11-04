# API catalogue — gigamap

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally. Verified against Eclipse Store 4.3.0.

## `GigaMap<E>`

File: `gigamap/gigamap/src/main/java/org/eclipse/store/gigamap/types/GigaMap.java`.

### Factory / builder

| Method | Purpose |
|---|---|
| `GigaMap.New()` | Empty map, identity equality, no indexes. |
| `GigaMap.New(Equalator)` | With custom equalator (e.g., `XHashing.hashEqualityValue()`). |
| `GigaMap.<E>Builder()` | Fluent builder. |
| `builder.withBitmapIdentityIndex(indexer)` / `withBitmapIdentityIndices(...)` | Identity index — defines how entities are looked up. Not a uniqueness guarantee. |
| `builder.withBitmapUniqueIndex(indexer)` / `withBitmapUniqueIndices(...)` | Uniqueness constraint (backed by a bitmap index). |
| `builder.withBitmapIndex(indexer)` / `withBitmapIndices(...)` | Non-unique bitmap. Also the registration path for `SpatialIndexer`. |
| `builder.withCustomConstraint(constraint)` | `CustomConstraint<E>` validated on every write (persisted with the map — use a named class, not a lambda). |
| `builder.withValueEquality()` / `withIdentityEquality()` | Control CRUD equalator. |
| `builder.build()` | Finalize and return the map. |

Lucene and vector indexes are **not** declared on the builder — they're
registered post-build on `map.index()` (see sections below).

### CRUD

| Method | Notes |
|---|---|
| `long add(E e)` | Add an entity. Throws if null or a constraint is violated. Returns the new entity id. |
| `long addAll(E... entities)` / `addAll(Iterable<? extends E>)` | Batch add; traverses the `Iterable` exactly once. All-or-nothing on a constraint violation. |
| `long remove(E e)` | Uses the identity index (or a compound fallback). Returns the removed entity id. |
| `long remove(E e, IndexIdentifier<E,?>... discriminators)` | Explicit lookup. `Indexer` is a subtype of `IndexIdentifier`, so passing an indexer works. |
| `E removeById(long entityId)` | Index-free removal. |
| `void removeAll()` / `clear()` | Remove everything. |
| `E update(E e, Consumer<? super E> mutator)` / `update(long entityId, mutator)` | Wrap an in-place mutation so indices update; schedules the entity for storing. The id overload needs no bitmap index. |
| `<R> R apply(E e, Function<? super E, R> logic)` / `apply(long entityId, logic)` | Same, returning the function's result. A **constraint** violation removes the entity and throws `ConstraintViolationException`; an **index** failure (indexer throws, wrong vector dimension, stale index) keeps the entity and rethrows — repair with `reindex()`. |
| `E set(long entityId, E replacement)` / `long replace(E current, E replacement)` | Install a *different* instance under the id and re-index it. Passing the instance the map already holds throws `IllegalArgumentException`. |
| `E get(long entityId)` / `E peek(long entityId)` | By internal id. |
| `long size()` / `boolean isEmpty()` / `long highestUsedId()` | Counters. |
| `void reindex()` | Rebuild every index (bitmap, Lucene, vector) from the current entity state; re-validates unique constraints. Repairs indices after a direct mutation or class evolution of an indexed field. Does not store the entities. |
| `void markReadOnly()` / `unmarkReadOnly()` / `isReadOnly()` | Read-only mode: every mutation is rejected. |

### Iteration

| Method | Notes |
|---|---|
| `GigaIterator<E> iterator()` | Closeable. Try-with-resources. |
| `iterate(consumer)` / `forEach(action)` | Internal iteration; no structural modification inside. |
| `iterateIndexed((id, entity) -> …)` | Id + entity per element. |

### Query

| Method | Returns |
|---|---|
| `GigaQuery<E> query()` | All entities. |
| `GigaQuery<E> query(Condition<E>)` | Filtered. |
| `GigaQuery<E> query(IterationThreadProvider)` | Multithreaded execution (then `.and(condition)`). |
| `query(String indexName, K key)` / `query(indexIdentifier, key)` | Equality query on an index resolved by name. |

### Persistence

| Method | Notes |
|---|---|
| `long store()` | **Use this.** Acquires the internal lock and stores only dirty segments. Returns the storage object id. |
| `long store(PersistenceStoring)` | Pass a `Persister` (e.g. the storage manager) to store and commit at once, or a `Storer` (`storageManager.createStorer()`) to register the changes and commit several maps / the root in one `storer.commit()`. |

Do not call `storageManager.store(gigaMap)` without external `synchronized(map)`.

## `GigaQuery<E>`

| Method | Returns |
|---|---|
| `GigaQuery<E> and(Condition)` / `and(SubQuery)` | Intersection. |
| `GigaQuery<E> or(Condition)` | Union with condition. |
| `List<E> toList()` / `toList(int limit)` / `toList(int offset, int limit)` | Materialize all / first `limit` / a page. |
| `Set<E> toSet()` / `toSet(limit)` / `toSet(offset, limit)` | Set collectors. |
| `long count()` | Count hits without loading entities. |
| `Optional<E> findFirst()` | First hit. |
| `Stream<E> stream()` / `GigaIterator<E> iterator()` | Closeable. |
| `iterateIndexed((id, e) -> …)` / `executeWithId(entryConsumer)` | Hits with their entity id (needed for `update(id, …)` on maps without a bitmap index). |
| `idStart(long)` / `idBound(long)` / `idRange(start, bound)` | Restrict to an entity-id window. |
| `execute(Consumer<? super E>... consumers)` | Parallel execution, one consumer per thread (needs `query(IterationThreadProvider)`). |

There is no `skip(n)` / `limit(n)`: paginate with `toList(offset, limit)`.
`GigaQuery` itself implements `GigaMap.SubQuery`, so queries combine with
`.and(subQuery)`.

## Index lifecycle — `map.index()`

`GigaIndices<E>` (file `.../types/GigaIndices.java`):

| Method | Notes |
|---|---|
| `bitmap()` | The `BitmapIndices<E>` group (always present). |
| `register(IndexCategory)` | Create and attach a group (`LuceneIndex.Category(ctx)`, `VectorIndices.Category()`). Returns `null` if the category is already attached (e.g. after loading from storage) — use `get(...)` first. |
| `get(Class<C>)` / `get(IndexCategory)` | The attached group, or `null`. |
| `remove(IndexCategory)` / `remove(Class)` | Drop a whole group (closes it first). The bitmap group cannot be removed. |

`BitmapIndices<E>` (file `.../types/BitmapIndices.java`) — registering on a
populated map back-fills the new index from the existing entities;
registration is all-or-nothing (a throwing indexer registers nothing):

| Method | Notes |
|---|---|
| `add(indexer)` / `addAll(...)` | Register a new index (throws if the name is taken). |
| `ensure(indexer)` / `ensureAll(...)` | Get-or-create; an existing index is returned unchanged. |
| `update(indexer)` | Replace the logic of a registered index (same name); rebuilt before the old one is dropped, keeps unique / identity membership. |
| `removeIndex(name)` / `removeIndex(identifier)` | Drop one index. |
| `setIdentityIndices(...)` / `identityIndices()` | Promote registered indices to identity. |
| `addUniqueConstraint(indexer)` / `uniqueConstraints()` | Unique constraint (also via `map.constraints().unique()`). |
| `get(keyType, name)` / `getIndexerString(name)` / `getIndexerLocalDate(name)` / `getIndexerUUID(name)` / `getSpatialIndexer(name)` / `getBinaryIndexerString(name)` / `getByteIndexerNumber(keyType, name)` / … | Look up a registered index by name (annotation-generated indices). |

## Indexer base classes

All in `org.eclipse.store.gigamap.types`. Every getter is `protected abstract`;
overriding it as `public` compiles but is not required.

| Class | Override | Extract type |
|---|---|---|
| `IndexerString.Abstract<E>` | `getString(E)` | `String` — also `contains`, `startsWith`, `endsWith` (+ `IgnoreCase`), `isEmpty`, `isBlank` conditions |
| `BinaryIndexerUUID.Abstract<E>` | `getUUID(E)` | `UUID` (high-cardinality, equality only) |
| `BinaryIndexerLong.Abstract<E>` / `BinaryIndexerString.Abstract<E>` | `getLong(E)` / `getString(E)` | High-cardinality ids, equality only |
| `IndexerLocalDate.Abstract<E>` / `IndexerLocalDateTime` / `IndexerLocalTime` / `IndexerYearMonth` / `IndexerInstant` / `IndexerZonedDateTime` | `getLocalDate(E)` etc. | `java.time` types; `before` / `after` / `between` / `isYear(int)` / `isMonth(int)` / `isDay(int)` |
| `IndexerByte` / `IndexerShort` / `IndexerInteger` / `IndexerLong` / `IndexerFloat` / `IndexerDouble` `.Abstract<E>` | `getInteger(E)` etc. | Low-cardinality numerics; `lessThan` / `greaterThan` / `between` via `IndexerComparing` |
| `ByteIndexerInteger` / `ByteIndexerLong` / … `.Abstract<E>` | `getInteger(E)` etc. | High-cardinality numerics **with** range queries (byte-decomposed) |
| `IndexerBoolean.Abstract<E>` | `getBoolean(E)` | `Boolean` (`null` indistinguishable from `false`) |
| `IndexerCharacter.Abstract<E>` | `getCharacter(E)` | `Character` |
| `IndexerMultiValue.Abstract<E, K>` | `indexEntityMultiValue(E)` + `keyType()` | Any `Iterable<K>`; adds `.all(...)` |
| `Indexer.Abstract<E, K>` | `index(E)` + `keyType()` | Any key type with `equals` / `hashCode` |
| `SpatialIndexer.Abstract<E>` | `getLatitude(E)` + `getLongitude(E)` | Lat / lon pairs (see below) |

Indexer names default to `{declaring class FQCN}.{field}`; override `name()`
for anonymous instances or to decouple the persisted name from the Java
identifier. Names must be unique within a map.

For `IndexerString`: `.is(...)`, `.in(...)`, `.not(...)`, `.notIn(...)`,
`.is(predicate)`. For temporal / numeric: `.greaterThan`, `.lessThan`,
`.between`, `.isYear`, `.before`, `.after`. For `IndexerMultiValue`:
`.is(key)` (contains), `.in(...)` (any-of), `.all(...)` (all-of), `.not(...)` /
`.notIn(...)`.

## Spatial indexer

Part of the core `gigamap` artifact.
File: `gigamap/gigamap/src/main/java/org/eclipse/store/gigamap/types/SpatialIndexer.java`.

```java
public class LocationIndex extends SpatialIndexer.Abstract<Store> {
    @Override protected Double getLatitude (Store s) { return s.lat(); }
    @Override protected Double getLongitude(Store s) { return s.lon(); }
}
GigaMap<Store> map = GigaMap.<Store>Builder().withBitmapIndex(new LocationIndex()).build();
```

Operators on `SpatialIndexer` (all return `Condition<S>` — index-driven):

| Operator | Meaning |
|---|---|
| `at(lat, lon)` | Exact coordinate match. |
| `near(lat, lon, radiusKm)` | **Bounding-box approximation** of the radius (`cos(lat)` longitude correction). Includes corner points up to ~√2 × `radiusKm`. |
| `withinBox(minLat, maxLat, minLon, maxLon)` | Axis-aligned bounding box. |
| `latitudeBetween(min, max)` / `longitudeBetween(min, max)` | 1-D range. |
| `latitudeAbove(v)` / `latitudeBelow(v)` / `longitudeAbove(v)` / `longitudeBelow(v)` | 1-D bound. |
| `isNull()` | Missing coordinates. |

On `SpatialIndexer.Abstract<E>`: `withinRadius(lat, lon, radiusKm)` returns a
`Predicate<E>` — **exact** haversine filter, not index-driven; apply as a stream
`filter` after a `near` pre-select. Static helper:
`SpatialIndexer.haversineDistance(lat1, lon1, lat2, lon2)` (km). Points only.
Annotation form: class-level `@SpatialIndex(latitude = "lat", longitude = "lon")`.

## Lucene index

Artifact: `org.eclipse.store:gigamap-lucene` (Lucene libraries are `provided`
— add `lucene-core` + `lucene-queryparser` 9.8.0 yourself). Package
`org.eclipse.store.gigamap.lucene`. Details → `lucene.md`.

| Type | Purpose |
|---|---|
| `DocumentPopulator<E>` | Abstract — override `populate(Document, E)`. Static helpers `createTextField` / `createStringField` / `createIntField` / `createLongField` / `createFloatField` / `createDoubleField`. |
| `LuceneContext<E>` | `New(populator)` — index data lives **inside the object graph** (persisted with the map). `New(Path, populator)` — MMap directory. `New(DirectoryCreator, populator)`, `New(DirectoryCreator, AnalyzerCreator, populator)`, `New(…, autoCommit)`. |
| `DirectoryCreator` | `MMap(Path)`, `MMap(IndexLocation)`, `ByteBuffers()` (in-memory, rebuilt on reopen). |
| `AnalyzerCreator` | `Standard()` or subclass with `createAnalyzer()`. |
| `LuceneIndex<E>` | `map.index().register(LuceneIndex.Category(ctx))`; `map.index().get(LuceneIndex.class)` after load. `Closeable`. |
| `LuceneSearchResult<E>` | Scored, `SubQuery`-compatible iterable of `ScoredSearchResult.Entry<E>`. |
| `LuceneAnnotationHandler` | `New()` / `New(Path)` / `New(DirectoryCreator)` / `New(IndexLocation)` for `@FullText` generation. |

Methods on `LuceneIndex<E>`:

| Method | Returns |
|---|---|
| `query(String q)` / `query(String q, int limit)` / `query(Query q[, int limit])` | `List<E>` — no scores. |
| `query(String q, SearchResultAcceptor)` / `query(q, limit, acceptor)` | Callback `(entityId, entity, score)` per hit. |
| `search(String q, int limit)` / `search(Query q, int limit)` / `search(q)` | `LuceneSearchResult<E>` — scored, combinable `SubQuery`. |
| `commit()` | Needed only with `autoCommit=false` between stores; `store()` commits anyway. |
| `changeIndexLocation(IndexLocation)` | New location from the next load (MMap directories only). |
| `close()` | Releases the directory; the index re-opens lazily on the next call. Storage shutdown calls it for you. |

Query syntax is standard Lucene: `field:term`, `AND`/`OR`/`NOT`,
`"phrase"`, `wild*`, `fuzzy~`, ranges `[a TO b]`.

## Vector index (jvector)

Artifact: `org.eclipse.store:gigamap-jvector` — **Java 25+** (compiled with
release 25; the rest of Eclipse Store stays Java 17). Package
`org.eclipse.store.gigamap.jvector`. JVM flags:

```
--add-modules jdk.incubator.vector --enable-native-access=ALL-UNNAMED
```

The first enables SIMD scoring (scalar fallback without it), the second
jvector's memory-mapped graph reader (`--enable-native-access=jvector` on
the module path). Set both in Surefire/Failsafe `<argLine>` and the launcher.

### `Vectorizer<E>`

File: `gigamap/jvector/src/main/java/org/eclipse/store/gigamap/jvector/Vectorizer.java`.

| Method | Notes |
|---|---|
| `abstract float[] vectorize(E entity)` | Must **reproduce the committed vector** of a persisted entity (the index re-vectorizes to repair its vector file). Called concurrently — a reused buffer must be per thread. |
| `long vectorKey(E entity)` | Default `NO_KEY` (compare by content). Return a cheap version key so an update with an unchanged key skips `vectorize()`. |
| `List<float[]> vectorizeAll(List<? extends E>)` | Default loops `vectorize`; override for batch APIs. Same size, positional. |
| `boolean isEmbedded()` | `true` = vector is a field of the entity; `false` (default) = computed. Both modes keep the vector in the index's vector file. |
| `boolean allowsNullVectors()` | Default `false` (`null` → `IllegalStateException`). `true` = `null` means "no embedding": entity stays in the map, excluded from the vector index. |

### `VectorSimilarityFunction`

`COSINE` (default; text / semantic embeddings), `DOT_PRODUCT` (pre-normalized
vectors), `EUCLIDEAN` (magnitude matters).

### `VectorIndexConfiguration`

Immutable. `VectorIndexConfiguration.builder()...build()` or a preset. Full
parameter table with defaults → `vector-operations.md`. Builder methods:
`dimension`, `similarityFunction`, `maxDegree`, `beamWidth`,
`minSearchBeamWidth`, `neighborOverflow`, `alpha`, `onDisk`,
`indexDirectory(Path)`, `indexLocation(IndexLocation)`, `vectorStorage`
(`INLINE` / `NVQ`), `approximateScoring` (`NONE` / `FUSED_PQ` /
`PQ_IN_MEMORY`), `nvqSubvectors`, `pqSubspaces`, `enablePqCompression`
(deprecated alias of `FUSED_PQ`), `parallelOnDiskWrite`, `eventualIndexing`,
`persistenceIntervalMs`, `minChangesBetweenPersists`, `persistOnShutdown`,
`shutdownPersistTimeoutMillis`, `flushThreshold`, `maxSegments`,
`segmentMergeFactor`, `vectorCheckpointIntervalMs`, `vectorChunkBytes`,
`optimizationIntervalMs`, `minChangesBetweenOptimizations`,
`optimizeOnShutdown`.

Presets (static; each has a `builderFor*` twin returning a `Builder`):

| Preset | Pre-configured values |
|---|---|
| `forSmallDataset(dim)` / `(dim, similarity)` | `maxDegree=12`, `beamWidth=75`, in-memory |
| `forMediumDataset(dim)` | `maxDegree=24`, `beamWidth=150`, in-memory |
| `forMediumDataset(dim, Path)` | same, `onDisk`, `persistenceIntervalMs=30000` |
| `forLargeDataset(dim, Path)` | `maxDegree=32`, `beamWidth=300`, `onDisk`, **`FUSED_PQ` on**, persistence 30 s |
| `forLargeDataset(dim, Path, boolean pq)` | same, PQ optional |
| `forCompactLargeDataset(dim, Path)` | as large, `vectorStorage=NVQ`, `NONE` scoring, `parallelOnDiskWrite` — smallest files |
| `forHighPrecision(dim)` / `(dim, Path)` | `maxDegree=56`, `beamWidth=450`, `INLINE` + `NONE` |

### `VectorIndices<E>`

Registered on the map post-build: `map.index().register(VectorIndices.Category())`
(returns `null` when already attached — `get(VectorIndices.class)` first).

| Method | Returns | Notes |
|---|---|---|
| `add(name, cfg, vectorizer)` | `VectorIndex<E>` | Throws if `name` exists. Back-fills from existing entities before registering (all-or-nothing). |
| `ensure(name, cfg, vectorizer)` | `VectorIndex<E>` | Get-or-create. An existing index is returned **unchanged**; `cfg` and `vectorizer` are ignored. |
| `get(name)` | `VectorIndex<E>` | Or `null`. |
| `removeIndex(name)` | `boolean` | Closes and drops the index; files in a configured directory are kept. |
| `changeIndexLocation(name, IndexLocation)` | `void` | New location from the next load; store the map afterwards. |
| `accessIndices(consumer)` / `iterate(consumer)` | — | Lock-protected access. |

The name is the file prefix (`{name}.vec`, `{name}.manifest`,
`{name}.seg-{n}.graph`, …): keep it short, stable and free of path separators.

### `VectorIndex<E>`

| Method | Returns | Notes |
|---|---|---|
| `name()` / `parent()` / `configuration()` / `vectorizer()` | — | Metadata. |
| `indexDirectory()` | `Path` | Resolved directory, or `null` for an index without files. |
| `search(float[] q, int k)` / `search(q, k, searchBeamWidth)` | `VectorSearchResult<E>` | Top-k; effective beam = `max(k, minSearchBeamWidth)` unless overridden. |
| `search(E entity, int k)` / `search(entity, k, beam)` | `VectorSearchResult<E>` | "More like this". `IllegalArgumentException` if the vectorizer returns `null`. |
| `getVector(long entityId)` | `float[]` | Copy from the vector file, or `null`. |
| `optimize()` | `void` | Cleanup of an in-memory graph (drains the eventual-indexing queue first). No-op on an on-disk index. Not inside `synchronized(map)` / `update` logic. |
| `persistToDisk()` | `void` | Writes the in-memory graph as a new segment + manifest. No-op in memory. Does **not** drain the eventual queue (pending ops go into the segment). |
| `isOnDisk()` / `keepsIndexFiles()` | `boolean` | `keepsIndexFiles`: on-disk, or in-memory computed with a directory / location. |
| `isPqCompressionEnabled()` / `isPqCompressionActive()` / `isNvqCompressionActive()` | `boolean` | Configured vs. actually trained. |
| `close()` | `void` | Drains, optionally optimizes / persists per config, releases files. **Storage shutdown closes every index of the map** — explicit `close()` is not required there. |

### `VectorSearchResult<E>`

Extends `ScoredSearchResult<E>`: `size()`, `isEmpty()`, `stream()`, `toList()`,
iterable of `Entry<E>` ordered by descending similarity, `and(SubQuery)`.
`Entry<E>`: `entityId()`, `score()`, lazy `entity()`.

### `IndexLocation` / `IndexLocations`

Core `gigamap` artifact, package `org.eclipse.store.gigamap.types`.
`IndexLocation.Absolute(Path)` stores the path; `IndexLocation.Named(String)`
stores only a name that `IndexLocations.bind(name, Path)` resolves at runtime
(JVM-wide, before the storage starts). Also `unbind(name)`, `lookup(name)`,
`resolve(name)`. Details → `index-locations.md`.

## Sub-queries

| Type | Source |
|---|---|
| `GigaQuery<E>` | `gigaMap.query(...)` |
| `LuceneSearchResult<E>` | `luceneIndex.search("...", n)` |
| `VectorSearchResult<E>` | `vectorIndex.search(vec, n)` |
| `ScoredSearchResult<E>` | `scoredResult.and(subQuery)` |
| `EntityIdMatcher.Ascending(long... sortedIds)` | Ad-hoc fixed set |

All combine via `.and(SubQuery)` (logical AND). `gigaQuery.and(scored)` drops
scores; `scored.and(gigaQuery)` returns a `ScoredSearchResult` that keeps the
original ranking.

## Annotations

Runtime generation (no classpath scanning; the `Builder` does **not** read
annotations):

```java
GigaMap<Person> map = GigaMap.New();
GeneratedIndices<Person> idx = IndexerGenerator.AnnotationBased(Person.class)
    .register(LuceneAnnotationHandler.New())    // @FullText, gigamap-lucene
    .register(VectorAnnotationHandler.New())    // @Vector, gigamap-jvector
    .generateIndices(map);                      // bitmap + spatial + full-text + vector
map.query(idx.getIndexerString("lastName").is("Smith"));
```

| Annotation | Module | Produces |
|---|---|---|
| `@Index` (`kind = LOW_CARDINALITY / BINARY / BIT_SLICED`, `creator = …`) | `gigamap` | Bitmap index on a field or getter |
| `@Unique` / `@Identity` | `gigamap` | Unique (binary) index / identity index |
| `@SpatialIndex(latitude = "lat", longitude = "lon")` | `gigamap` | Class-level spatial index |
| `@FullText(analyzed = true, store = true)` | `gigamap-lucene` | Lucene field |
| `@Vector(dimension = 384, similarity = COSINE, onDisk = false, allowNull = false)` | `gigamap-jvector` | Vector index |

Compile-time alternative: the `gigamap-codegen` annotation processor emits
`Person_` with typed constants and an idempotent `Person_.registerIndices(map)`.

## Exceptions

- `UniqueConstraintViolationException` — duplicate on a unique index (`UniqueConstraintViolationExceptionBitmap` from `reindex()` names the first colliding entity).
- `ConstraintViolationException` — custom constraint; on `update` / `apply` the entity is removed.
- `StaleIndexException` — an index does not know the entity's current key (direct mutation or class evolution); run `reindex()`.
- `BinaryPersistenceException: Inconsistent element count` — `storageManager.store(map)` without sync.
