# GigaQuery DSL reference

## Basic conditions

| Operator | All indexers? | Example |
|---|---|---|
| `.is(key)` | Yes | `lastName.is("Smith")` |
| `.is(predicate)` | Yes | `lastName.is(n -> n.length() > 5)` |
| `.in(k1, k2, ...)` | Yes | `lastName.in("Smith", "Jones")` |
| `.not(key)` | Yes | `lastName.not("Smith")` |
| `.notIn(k1, k2, ...)` | Yes | `lastName.notIn("Smith", "Jones")` |

## Numeric / temporal conditions

| Operator | Indexers | Example |
|---|---|---|
| `.greaterThan(key)` | numeric/temporal | `price.greaterThan(100)` |
| `.greaterThanEqual(key)` | numeric/temporal | `age.greaterThanEqual(18)` |
| `.lessThan(key)` | numeric/temporal | `price.lessThan(50)` |
| `.lessThanEqual(key)` | numeric/temporal | `price.lessThanEqual(50)` |
| `.between(low, high)` | numeric/temporal | `price.between(10, 100)` |
| `.before(moment)` | temporal | `birthDate.before(LocalDate.of(2000,1,1))` |
| `.after(moment)` | temporal | `birthDate.after(LocalDate.of(1990,1,1))` |
| `.isYear(y)` | LocalDate/LocalDateTime | `birthDate.isYear(1990)` |
| `.isMonth(m)` | LocalDate/LocalDateTime | `birthDate.isMonth(Month.JUNE)` |

## Multi-value conditions

Indexers based on `IndexerMultiValue`:

| Operator | Meaning |
|---|---|
| `.is(key)` | Collection contains key. |
| `.in(k1, k2, ...)` | Collection contains any. |
| `.all(k1, k2, ...)` | Collection contains all. |
| `.not(key)` | Collection does not contain. |
| `.notIn(k1, k2, ...)` | Collection contains none. |

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

## Sub-query combination

`GigaQuery`, `LuceneSearchResult`, `VectorSearchResult`, and `EntityIdMatcher`
all implement `GigaMap.SubQuery`. Chain with `.and(SubQuery)` on a `GigaQuery`:

```java
map.query(status.is("PUBLISHED"))
   .and(luceneHits)
   .and(vectorHits)
   .and(EntityIdMatcher.Ascending(42, 99));
```

All combinations are logical AND.

## Query result methods

| Method | Returns | Notes |
|---|---|---|
| `toList()` | `List<E>` | Materialize. |
| `count()` | `long` | No entity load. |
| `findFirst()` | `Optional<E>` | First hit. |
| `stream()` | `Stream<E>` | Close! |
| `iterator()` | `Iterator<E>` | Close! |
| `skip(n).limit(m)` | `GigaQuery<E>` | Pagination. |

## Scored results (Lucene, vector)

`ScoredSearchResult<E>` is a `SubQuery` but also iterable with scores:

```java
for (var entry : luceneIndex.search("eclipse", 20)) {
    System.out.println(entry.score() + ": " + entry.entity());
}
```

`ScoredSearchResult.and(GigaQuery)` returns another `ScoredSearchResult` — the
score order is preserved.

## Use patterns

### Open query, no condition

```java
map.query().toList();   // all entries
```

Discouraged for large maps — prefer an explicit condition or use `iterator()`.

### Unused result

`map.query(...)` without consuming is harmless — nothing is computed until a
terminal method (`.toList`, `.count`, `.iterator`).

### Static import

Importing indexer fields makes queries concise:

```java
import static app.PersonIndices.*;
...
map.query(lastName.is("Smith").and(birthDate.isYear(1990)));
```

Common across examples.
