# GigaQuery DSL reference

Verified against Eclipse Store 4.3.0.

## Basic conditions

| Operator | All indexers? | Example |
|---|---|---|
| `.is(key)` | Yes | `lastName.is("Smith")` |
| `.is(predicate)` | Yes | `lastName.is(n -> n.length() > 5)` |
| `.in(k1, k2, ...)` | Yes | `lastName.in("Smith", "Jones")` |
| `.not(key)` | Yes | `lastName.not("Smith")` |
| `.notIn(k1, k2, ...)` | Yes | `lastName.notIn("Smith", "Jones")` |

## String conditions (`IndexerString`)

| Operator | Example |
|---|---|
| `.contains(s)` / `.containsIgnoreCase(s)` | `lastName.contains("mit")` |
| `.startsWith(s)` / `.startsWithIgnoreCase(s)` | `lastName.startsWith("Sm")` |
| `.endsWith(s)` / `.endsWithIgnoreCase(s)` | `email.endsWith("@example.com")` |
| `.isEmpty()` / `.isBlank()` | `nickname.isBlank()` |

Predicate-based (`is(predicate)`, `contains`, …) conditions scan the index
keys; they are index-driven but not O(1). `BinaryIndexerString` supports
equality only.

## Numeric / temporal conditions

| Operator | Indexers | Example |
|---|---|---|
| `.greaterThan(key)` | numeric (`Indexer*`, `ByteIndexer*`, `IndexerComparing`) / temporal | `price.greaterThan(100)` |
| `.greaterThanEqual(key)` | numeric / temporal | `age.greaterThanEqual(18)` |
| `.lessThan(key)` | numeric / temporal | `price.lessThan(50)` |
| `.lessThanEqual(key)` | numeric / temporal | `price.lessThanEqual(50)` |
| `.between(low, high)` | numeric / temporal (inclusive) | `price.between(10, 100)` |
| `.before(moment)` | temporal (exclusive) | `birthDate.before(LocalDate.of(2000,1,1))` |
| `.after(moment)` | temporal (exclusive) | `birthDate.after(LocalDate.of(1990,1,1))` |
| `.isYear(int)` / `.isYear(IntPredicate)` | LocalDate / LocalDateTime | `birthDate.isYear(1990)` |
| `.isMonth(int)` / `.isMonth(IntPredicate)` | LocalDate / LocalDateTime | `birthDate.isMonth(6)` — an `int` 1–12, not `java.time.Month` |
| `.isDay(int)` / `.isDay(IntPredicate)` | LocalDate / LocalDateTime | `birthDate.isDay(d -> d > 15)` |

`BinaryIndexer*` (high cardinality) support equality only; use `ByteIndexer*`
for high-cardinality numerics that need ranges.

## Multi-value conditions

Indexers based on `IndexerMultiValue`:

| Operator | Meaning |
|---|---|
| `.is(key)` | Collection contains key. |
| `.in(k1, k2, ...)` | Collection contains any. |
| `.all(k1, k2, ...)` | Collection contains all. |
| `.not(key)` | Collection does not contain. |
| `.notIn(k1, k2, ...)` | Collection contains none. |
| `.is(predicate)` | Any key matches the predicate. |

## Spatial conditions

On a `SpatialIndexer.Abstract<E>` instance (e.g. `loc`). Conditions below are
index-driven and combine with `.and`/`.or` like any other bitmap condition:

| Operator | Meaning |
|---|---|
| `loc.at(lat, lon)` | Exact coordinate. |
| `loc.near(lat, lon, radiusKm)` | **Bounding-box approximation** of the radius (not a true circle — see below). |
| `loc.withinBox(minLat, maxLat, minLon, maxLon)` | Axis-aligned bounding box. |
| `loc.latitudeBetween(min, max)` / `longitudeBetween(min, max)` | 1-D range. |
| `loc.latitudeAbove(v)` / `loc.latitudeBelow(v)` / `loc.longitudeAbove(v)` / `loc.longitudeBelow(v)` | 1-D bound. |
| `loc.isNull()` | Missing coordinates. |

```java
map.query(loc.near(40.7128, -74.0060, 50))          // within ~50 km box of NYC
   .and(category.is("coffee-shop"));                // intersect with bitmap
```

### `near` is a box, not a circle

`near(lat, lon, radiusKm)` translates `radiusKm` into latitude/longitude
deltas (with `cos(lat)` correction) and returns a `withinBox` condition.
That means points in the corners of the box — up to `radiusKm·√2` away —
are included. For an exact circle, post-filter with `withinRadius`:

| Method | Returns | Kind |
|---|---|---|
| `loc.withinRadius(lat, lon, radiusKm)` | `Predicate<E>` | Exact haversine filter. Applied per entity in a stream. |
| `SpatialIndexer.haversineDistance(lat1, lon1, lat2, lon2)` | `double` | Public static — km between two points. |

```java
var exact = loc.withinRadius(40.7128, -74.0060, 50.0);
List<Store> hits = map.query(loc.near(40.7128, -74.0060, 50.0))
    .and(category.is("coffee-shop"))
    .stream()
    .filter(exact)
    .toList();
```

Skip the post-filter when over-inclusion doesn't matter ("shops roughly
within 5 km"). Keep it when the cutoff is meaningful (legal radii,
billing zones, driving-range estimates).

## Combining

| Combinator | Example |
|---|---|
| `.and(condition)` | `a.is("x").and(b.greaterThan(1))` |
| `.or(condition)` | `a.is("x").or(a.is("y"))` |

Conditions combine into a single argument for `gigaMap.query(cond)`.
`and` / `or` return a new condition; the receiver is not modified.

## Sub-query combination

`GigaQuery`, `LuceneSearchResult`, `VectorSearchResult`, and `EntityIdMatcher`
all implement `GigaMap.SubQuery`. Chain with `.and(SubQuery)` on a `GigaQuery`:

```java
map.query(status.is("PUBLISHED"))
   .and(luceneHits)
   .and(vectorHits)
   .and(EntityIdMatcher.Ascending(42, 99));
```

All combinations are logical AND. Two queries on the same map intersect the
same way: `adults.and(berliners).count()`.

## Query result methods

| Method | Returns | Notes |
|---|---|---|
| `toList()` / `toList(limit)` / `toList(offset, limit)` | `List<E>` | Materialize all / first `limit` / a page. There is no `skip` / `limit` on the query. |
| `toSet()` / `toSet(limit)` / `toSet(offset, limit)` | `Set<E>` | Same, as a set. |
| `count()` | `long` | No entity load. |
| `findFirst()` | `Optional<E>` | First hit. |
| `stream()` | `Stream<E>` | Close! |
| `iterator()` | `GigaIterator<E>` | Close! (auto-closes when fully drained) |
| `iterateIndexed((id, e) -> …)` / `executeWithId(consumer)` | — | Hits with their entity id. |
| `idStart(id)` / `idBound(id)` / `idRange(start, bound)` | `GigaQuery<E>` | Restrict to an entity-id window. |
| `execute(consumer1, consumer2, …)` | — | Parallel: one consumer per thread; create the query with `map.query(IterationThreadProvider.Creating(ThreadCountProvider.Adaptive()))`. |

## Scored results (Lucene, vector)

`ScoredSearchResult<E>` is a `SubQuery` but also iterable with scores:

```java
for (var entry : luceneIndex.search("eclipse", 20)) {
    System.out.println(entry.score() + ": " + entry.entity());
}
```

`ScoredSearchResult.and(SubQuery)` returns another `ScoredSearchResult` — the
score order is preserved. `gigaQuery.and(scoredResult)` drops the scores.
`entry.entityId()` is the id for `map.update(entityId, …)` on maps without a
bitmap index.

## Use patterns

### Open query, no condition

```java
map.query().toList();   // all entries
```

Discouraged for large maps — prefer an explicit condition, `toList(offset, limit)`,
or `iterator()`.

### Unused result

`map.query(...)` without consuming is harmless — nothing is computed until a
terminal method (`.toList`, `.count`, `.iterator`).

### Query by index name

For annotation-generated indices without a constant:

```java
map.query("lastName", "Smith");                 // String index by name
map.query(idx.getIndexerString("lastName").startsWith("Sm"));   // via GeneratedIndices
```

### Static import

Importing indexer fields makes queries concise:

```java
import static app.PersonIndices.*;
...
map.query(lastName.is("Smith").and(birthDate.isYear(1990)));
```

Common across examples.
