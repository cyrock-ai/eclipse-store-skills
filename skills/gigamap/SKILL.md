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
  "gigaMap.query", "sub-query", "Lucene full-text search", "vector similarity
  search", "jvector", "spatial index", "geo query", "near(lat, lon)",
  "withinBox", "SpatialIndexer", "Vectorizer", "VectorIndexConfiguration",
  "DocumentPopulator", "LuceneContext", "IndexerString", "IndexerLocalDate",
  "BinaryIndexerUUID", "ByteIndexer", "IndexerMultiValue", "update a GigaMap
  entity", "gigaMap.store", "billions of rows", or asks why
  `storageManager.store(gigaMap)` is unsafe.
version: 0.1.0
---

# Eclipse Store — GigaMap (Indexed, Queryable, Lazy Large Collections)

`GigaMap<E>` is Eclipse Store's answer to "I have hundreds of millions of entities
and I want real queries". It is a segmented, index-backed, lazily-loaded collection
that supports:

- Multiple index types per entity (bitmap, identity, unique, spatial, Lucene, vector).
- A fluent query DSL with AND/OR/NOT/range/predicate.
- Sub-queries that intersect across index types.
- Automatic lazy segment loading — memory cost is proportional to working set, not
  total size.
- Built-in integration with Eclipse Store persistence.

## When to use this skill

**Design-time triggers (apply proactively, before "billions of rows" is the question):**

- User is **designing a new entity collection** (e.g. `Order`, `Event`,
  `Document`, `Sensor`, `Customer`) that will accumulate over time. Even if
  the current size is small, plan for promotion to `GigaMap` if growth is
  plausible — the choice of container shape is hard to change later.
- User is **adding a new entity type** that will need lookups by anything
  other than identity — by date range, by foreign key, by string field, by
  geographic position, by similarity. Each of those points to an indexer
  configuration that should be sketched at design time.
- User is **scaling up** an existing aggregate from in-memory `List`/`Map` to
  something query-capable.
- User is **designing query / search / filter capabilities** in the service
  layer — GigaMap's index types determine which queries are cheap.

**Reactive triggers:**

- User has or expects > 100,000 entities and wants indexed access.
- User asks for queries, search, filtering.
- User mentions any GigaMap-specific API: `GigaMap`, `GigaQuery`, indexer classes,
  `SubQuery`, Lucene / vector indices.
- User is updating entities and asks how to propagate changes to the indices.

**Route elsewhere** when:

- User has a small collection (< 100K) — a plain `ArrayList` / `HashMap` is
  simpler. Maybe wrap in `Lazy<>` if size bothers startup.
- User wants a SQL-like query → GigaMap has a different API; be explicit.
- User wants to cache values across processes → `cache-jcache`.

## Mental model

A `GigaMap<E>` holds entities of type `E` in segments. Each entity has an
internal `entityId`. For each declared **indexer**, GigaMap maintains an **index**
that maps index keys to entity ids.

A **query** is a boolean combination of index conditions. Execution resolves the
boolean to a set of entity ids, then materializes the entities lazily (only the
segments containing hits are loaded).

Mutations go through GigaMap's own `add`/`remove`/`update` methods so the indices
stay in sync. Bypassing them (mutating the entity directly) leaves the indices
stale.

## Maven setup

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>gigamap</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>

<!-- Optional: full-text -->
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>gigamap-lucene</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>

<!-- Optional: vector similarity -->
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>gigamap-jvector</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

Spatial (point/lat-lon) is part of the core `gigamap` artifact — no extra
dependency.

## Core API

From `org.eclipse.store.gigamap.types`:

| Symbol | Purpose |
|---|---|
| `GigaMap<E>` | The collection. |
| `GigaMap.<E>Builder()` | Fluent builder. |
| `.withBitmapIdentityIndex(indexer)` | Identity index (unique id, fastest lookup). |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. |
| `.withBitmapIndex(indexer)` | Non-unique bitmap index (also used for `SpatialIndexer`). |
| `.build()` | Create the map. |
| `map.index().register(LuceneIndex.Category(ctx))` | Attach a Lucene full-text index post-build. |
| `map.index().register(VectorIndices.Category())` then `vectorIndices.add(name, cfg, vectorizer)` | Attach a jvector similarity index. |
| `GigaQuery<E>` | Fluent query. |
| `GigaMap.SubQuery` | Abstraction for things that contribute id sets to a query. |

Indexer base classes (in `org.eclipse.store.gigamap.types`):

| Indexer | For type |
|---|---|
| `IndexerString.Abstract<E>` | `String` |
| `BinaryIndexerUUID.Abstract<E>` | `UUID` |
| `IndexerLocalDate.Abstract<E>`, `IndexerLocalDateTime.Abstract<E>` | `java.time.*` |
| `IndexerByte.Abstract<E>`, `IndexerInteger.Abstract<E>`, `IndexerLong.Abstract<E>` | primitives/wrappers |
| `IndexerFloat.Abstract<E>`, `IndexerDouble.Abstract<E>` | floats |
| `IndexerBoolean.Abstract<E>` | boolean |
| `IndexerEnum.Abstract<E>` | enum types |
| `IndexerMultiValue.Abstract<E, K>` | collections of K per entity |

Annotations (for simple cases):

| Annotation | Effect |
|---|---|
| `@Index` | Declare an implicit index on a field. |
| `@Identity` | Identity index (single unique id field). |
| `@Unique` | Uniqueness constraint. |

## Index types in depth

Four index families. Pick by the query shape you need — they compose via
`SubQuery.and(...)`.

### Bitmap — exact + range, the default

The workhorse. Off-heap bit sets keyed by entity value; scales to billions
of entries. Use for equality, `in`-list, range, and predicate queries on
scalar or collection-valued fields.

Three registration variants on the builder:

| Builder method | Semantics |
|---|---|
| `.withBitmapIdentityIndex(indexer)` | Unique **and** used internally for `remove` / `update` lookup. Declare one on a stable id field for any large map. |
| `.withBitmapUniqueIndex(indexer)` | Uniqueness constraint. Adding a duplicate throws `UniqueConstraintViolationException`. |
| `.withBitmapIndex(indexer)` | Non-unique; many entities per key. Also the path for `SpatialIndexer` (see below). |

Indexer shapes (all in `org.eclipse.store.gigamap.types`, abstract-class
pattern — override a single getter):

- **Regular** — one key per entity (`IndexerString`, `IndexerLocalDate`,
  `IndexerBoolean`, `IndexerEnum`, …).
- **Binary** — fixed-width opaque ids (`BinaryIndexerUUID`). Stored as raw
  bytes; cheaper than treating a UUID as a string.
- **Byte-decomposed** — numerics internally split across byte positions so
  range queries are bitmap unions (`IndexerInteger`, `IndexerLong`,
  `IndexerDouble`, `IndexerFloat`, `IndexerByte`, `IndexerShort`).
- **Multi-value** — `IndexerMultiValue.Abstract<E, K>` for entities whose
  indexed field is a `Collection<K>` (tags, roles, interests). Adds
  `.all(k1, k2, …)` alongside `.is` / `.in`.

Operators: `is`, `in`, `not`, `notIn`, `is(Predicate)`; numeric/temporal add
`greaterThan`, `greaterThanEqual`, `lessThan`, `lessThanEqual`, `between`,
`before`, `after`, `isYear`, `isMonth`.

Performance rule of thumb. Identity-index lookup ≈ O(1). Bitmap intersection
scales linearly in the union of selected postings (not in the map size), so
selective `.and` chains stay fast even at 10⁹ entries. Broad queries without
a selective clause defeat the point.

### Lucene — full-text search with scoring

Separate artifact. Use when you need analyzer-driven tokenization, phrase,
wildcard, fuzzy, or score-ranked results — anything beyond exact/range on a
string.

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>gigamap-lucene</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

Register **after** building the map, via `map.index().register(...)`:

```java
public class ArticlePopulator extends DocumentPopulator<Article> {
    @Override public void populate(Document doc, Article a) {
        doc.add(createTextField("title",   a.title()));
        doc.add(createTextField("content", a.content()));
    }
}

LuceneContext<Article> ctx = LuceneContext.New(
    Paths.get("lucene-index"), new ArticlePopulator());

GigaMap<Article> articles = GigaMap.New();
LuceneIndex<Article> lucene = articles.index()
    .register(LuceneIndex.Category(ctx));

articles.add(new Article("Python Guide", "…"));

// List result
List<Article> matches = lucene.query("title:Python");

// Scored, sub-query-able
LuceneSearchResult<Article> hits = lucene.search("content:\"best practices\"", 100);
```

Query syntax is standard Lucene: `field:term`, `AND`/`OR`/`NOT`, `"phrase"`,
`wild*`, `fuzzy~`, ranges `[a TO b]`. Results combine with bitmap queries
via `.and(...)` — see Pattern J. The Lucene index directory is owned by
Lucene, not by Eclipse Store's storage — back it up alongside your
`storage/` directory.

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

Skipping `withinRadius` is fine when the extra ≤ 41 % area in the box corners
doesn't matter (e.g. "shops roughly within 5 km"). For cutoff-sensitive
queries (billing zones, legal radii) the post-filter is mandatory.

Points only — no polygons, no linestrings, no arbitrary geometries. If you
need those, keep a full geometry object on the entity and post-filter the
same way you'd chain `withinRadius`. Lat/lon getters return `Double`
(nullable).

### Vector — approximate nearest neighbour via jvector

Separate artifact. Use for embeddings (text, image, audio) where you want
k-nearest-neighbour similarity search.

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>gigamap-jvector</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

Declare a `Vectorizer<E>`, configure dimension and similarity function,
register via `map.index().register(...)`:

```java
public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) { return d.embedding(); }
    @Override public boolean isEmbedded()     { return true; }
}

VectorIndexConfiguration cfg = VectorIndexConfiguration.builder()
    .dimension(768)
    .similarityFunction(VectorSimilarityFunction.COSINE)
    .build();

GigaMap<Doc> docs = GigaMap.New();
VectorIndices<Doc> vectorIndices = docs.index().register(VectorIndices.Category());
VectorIndex<Doc>   embeddings    = vectorIndices.add("embeddings", cfg, new DocVectorizer());

docs.add(new Doc("Hello world", vec));

VectorSearchResult<Doc> top = embeddings.search(queryVector, 10);
for (var entry : top) {
    System.out.println(entry.score() + ": " + entry.entity().title());
}
```

Supported `VectorSimilarityFunction`:

| Function | Use |
|---|---|
| `COSINE` | Text embeddings and anything else where direction matters. |
| `DOT_PRODUCT` | Already-normalized vectors — skips the normalization step. |
| `EUCLIDEAN` | Abstract geometric spaces where magnitude matters. |

`dimension` must match every `float[]` you add — mixing dimensions throws at
`add` time. Changing `dimension` or `similarityFunction` after the fact
requires rebuilding the index (new `vectorIndices.add(name, newCfg, …)` and
re-vectorize). Multiple named vector indexes per map are allowed.

Combine with bitmap or Lucene filters via `.and(...)` — `VectorSearchResult`
is a `SubQuery`. A `ScoredSearchResult` variant preserves scores across the
intersection (Pattern J).

## Idiomatic patterns

### Pattern A — Define indices as constants

Keep indexers in a dedicated class so queries can reference them:

```java
public final class PersonIndices {
    public static final BinaryIndexerUUID<Person> id = new BinaryIndexerUUID.Abstract<>() {
        @Override protected UUID getUUID(Person p) { return p.id(); }
    };
    public static final IndexerString<Person> lastName = new IndexerString.Abstract<>() {
        @Override public String getString(Person p) { return p.lastName(); }
    };
    public static final IndexerLocalDate<Person> birthDate = new IndexerLocalDate.Abstract<>() {
        @Override protected LocalDate getLocalDate(Person p) { return p.birthDate(); }
    };
    private PersonIndices() {}
}
```

### Pattern B — Build a GigaMap

```java
GigaMap<Person> map = GigaMap.<Person>Builder()
    .withBitmapIdentityIndex(PersonIndices.id)
    .withBitmapIndex(PersonIndices.lastName)
    .withBitmapIndex(PersonIndices.birthDate)
    .build();
```

**Always declare an identity index** when each entity has a unique id — otherwise
remove/update fall back to slow compound searches.

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

**Never mutate entity fields directly.** The indices won't see the change.

```java
map.update(person, p -> {
    p.setLastName("Jones");
    p.setAddress(newAddress);
});
map.store();   // persists entity AND updated indices
```

`apply` is the read-only variant: `map.apply(person, p -> doSomethingWith(p))`.

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

### Pattern G — Queries: boolean combinations, `in`/`not`/`notIn`, predicates

```java
// AND
map.query(lastName.is("Smith").and(birthDate.isYear(1990)));

// OR
map.query(lastName.is("Smith").or(lastName.is("Jones")));

// IN
map.query(lastName.in("Smith", "Jones", "Brown"));

// NOT / NOT IN
map.query(lastName.not("Smith"));
map.query(lastName.notIn("Smith", "Jones"));

// Predicate on the index key
map.query(lastName.is(n -> n.length() > 5));
```

### Pattern H — Range queries

Numeric and temporal indexers support comparisons:

```java
map.query(price.greaterThan(100));
map.query(price.lessThanEqual(50));
map.query(price.between(10, 100));
map.query(birthDate.isYear(2000));
map.query(birthDate.before(LocalDate.now().minusYears(18)));
```

### Pattern I — Multi-value indexer

One entity has multiple keys (tags, interests):

```java
public static final IndexerMultiValue<Person, Interest> interests =
    new IndexerMultiValue.Abstract<>() {
        @Override public Collection<Interest> get(Person p) { return p.interests(); }
    };

map.query(interests.is(Interest.SPORTS));         // contains SPORTS
map.query(interests.in(Interest.SPORTS, Interest.LITERATURE));  // any of
map.query(interests.all(Interest.SPORTS, Interest.LITERATURE)); // both
```

### Pattern J — Sub-queries (combine across index types)

Intersect a bitmap query with a Lucene full-text hit list:

```java
LuceneSearchResult<Article> hits = luceneIndex.search("content:eclipse", 100);
List<Article> published = map.query(status.is("PUBLISHED"))
    .and(hits)
    .toList();
```

Intersect bitmap + vector:

```java
VectorSearchResult<Doc> hits = vectorIndex.search(queryVec, 50);
List<Doc> tech = map.query(category.is("tech"))
    .and(hits)
    .toList();
```

Intersect two bitmap queries:

```java
GigaQuery<Person> adults    = map.query(age.greaterThanEqual(18));
GigaQuery<Person> berliners = map.query(city.is("Berlin"));
long n = adults.and(berliners).count();
```

Intersect with a fixed id set:

```java
EntityIdMatcher allowed = EntityIdMatcher.Ascending(42L, 58L, 91L);
List<Person> hits = map.query(firstName.is("John")).and(allowed).toList();
```

All sub-query combinations are logical AND.

### Pattern K — Persistence: use `map.store()`

```java
map.add(person);
map.update(otherPerson, p -> p.setAge(30));
map.store();    // acquires GigaMap's internal lock during serialization
```

**Do not** call `storageManager.store(map)` unless you hand-synchronize. See
Anti-pattern 3.

### Pattern L — Root wiring

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

### Anti-pattern 5 — Inserting null

```java
map.add(null);     // throws
```

GigaMap disallows nulls. Use sentinel objects or omit.

### Anti-pattern 6 — Relying on identity equality when you needed value equality

```java
GigaMap<Entity> map = GigaMap.New();   // default: identity equality
// Two separate Entity instances with same fields are treated as different
```

**Fix.**

```java
GigaMap<Entity> map = GigaMap.New(XHashing.hashEqualityValue());
```

Check your domain — identity is right for mutable entities with a stable identity
field; value equality is right for immutable value objects.

### Anti-pattern 7 — Ignoring `UniqueConstraintViolationException`

Adding two entities that collide on a unique index throws
`UniqueConstraintViolationException`. Catching and swallowing breaks the GigaMap's
invariants. Handle the duplicate at the domain level.

### Anti-pattern 8 — Huge segment size to "save memory"

Segment size is a design parameter. Default is fine. Going to 1 M per segment
means lazy loading loads 1 M entities at a time. Going to 10 per segment means
thousands of tiny segments and metadata overhead.

## Pitfalls & gotchas

1. **Indices must be declared up front.** Changing them means a migration — you
   cannot add an index without scanning the data.
2. **Updates must go through `update`/`apply`.** Direct mutation breaks indices.
3. **Always prefer `gigaMap.store()` over `storageManager.store(gigaMap)`.**
   `gigaMap.store()` acquires the GigaMap's internal lock for the duration of
   the store; `storageManager.store(gigaMap)` does **not**. Concurrent
   mutations during the latter walk a structure that is changing under the
   serializer — the GigaMap's internal state becomes inconsistent and the
   store fails. (Eclipse Store can detect this case and throw, which makes it
   easier to spot than the silent variants.)
4. **The GigaMap's internal lock covers GigaMap operations only.** Stored
   *elements* (the values held in the GigaMap and any objects they reference)
   can still be mutated by another thread during `gigaMap.store()` — the
   GigaMap itself remains fine, but the persisted element graph may be
   inconsistent. If a business operation modifies a GigaMap *and* other parts
   of the object graph atomically, you still need an application-level lock
   spanning both. See `concurrency-and-locking`.
5. **Iterator lifecycle.** Read lock is held until the iterator is closed. A
   leaked iterator holds the read lock open and starves writers. Always
   try-with-resources for any iterator returned from a GigaMap (including
   query results).
6. **Null forbidden.** Use sentinel values if you need "absent".
7. **Identity index: strongly recommended, not required.** Without it, you get
   correct behaviour but far worse performance on removes/updates.
8. **Query results are views.** They iterate lazily. Don't assume stability
   across mutation.
9. **Lucene and vector indexes are separate artifacts.** They come with their own
   dependency footprint; don't pull them in "just in case".
10. **Sub-queries must come from the same GigaMap.** Combining two queries from
    two different maps is invalid.

## Interactions with other skills

- **`root-and-object-graph`** — GigaMap usually lives as a root-level field.
- **`storing-data`** — use `gigaMap.store()`; the generic `storageManager.store()`
  rules do not fully apply.
- **`concurrency-and-locking`** — the canonical treatment of thread-safety for
  Eclipse Store. GigaMap's internal RW lock makes individual operations atomic,
  but cross-aggregate atomicity (a GigaMap mutation alongside other graph
  changes) still needs an application-level lock.
- **`lazy-loading`** — GigaMap is internally lazy; you don't need `Lazy<>`
  around it. Wrapping in `Lazy<GigaMap<E>>` is wrong — GigaMap handles its own
  segment loading.
- **`configuration`** — no GigaMap-specific config; it uses storage's normal
  settings (channel count matters for write throughput).
- **`custom-type-handlers`** — auto-registered for GigaMap types; you only need
  handlers for your own entity classes if default reflection doesn't work.
- **`legacy-type-mapping`** — schema evolution of the entity class works
  normally; GigaMap's indices rebuild on start if the index definition matches.

## Recipes

**"When should I use GigaMap vs. `ArrayList`?"** → GigaMap when you need
indexed queries, or when the collection is big enough that eager loading is a
problem. `ArrayList` (possibly `Lazy<>`-wrapped) when you mainly iterate.

**"Do I need Lucene?"** → Only if you need full-text search with scoring. For
"find documents where title contains X", a plain `IndexerString` with `.is(pred)`
may suffice.

**"What's an identity index?"** → A bitmap index whose values are unique and
serve as a primary key. Eclipse Store uses it to find entities for remove/update
operations.

**"How big can a GigaMap get?"** → Billions of entries, constrained by disk
space and index memory. Queries remain fast because only hit segments load.

**"How do I paginate?"** → `GigaQuery` exposes pagination APIs
(`skip(n).limit(m)` or similar — check the `GigaQuery` javadoc).

**"Can I mutate the entity class without rebuilding the index?"** → Adding/
removing non-indexed fields is fine (normal `legacy-type-mapping`). Changing an
indexed field's type requires rebuilding the index.

**"How do I back up a GigaMap?"** → Like any other storage: configure a
`backup-directory`. GigaMap data rides along.

**"How do I test a GigaMap?"** → Build one in memory against a temp directory,
add fixtures, run queries, assert on results. Remember try-with-resources on
iterators.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — full signatures for `GigaMap`, `GigaQuery`,
  indexer abstractions, Lucene / vector / spatial APIs, sub-query helpers.
- `references/query-dsl.md` — every query operator (`is`, `in`, `between`,
  `before`, `.and`, `.or`, `.not`, `notIn`, multi-value `.all`, spatial
  operators, predicates, scored-result handling).
- `references/examples-expanded.md` — realistic end-to-end programs.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer.

## Upstream sources

- `docs/modules/gigamap/pages/index.adoc`, `getting-started.adoc`, `crud.adoc`,
  `persistence.adoc`.
- `docs/modules/gigamap/pages/queries/*.adoc`.
- `docs/modules/gigamap/pages/indexing/bitmap/*.adoc`,
  `.../lucene/*.adoc`, `.../jvector/*.adoc`, `.../spatial/*.adoc`.
- `gigamap/` module source tree.
- `examples/gigamap/` — upstream examples.
