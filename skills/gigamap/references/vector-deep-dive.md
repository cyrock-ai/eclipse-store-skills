# Vector index deep-dive — gigamap-jvector

Companion to the SKILL.md vector section. Read this when designing the
index shape (mode, similarity, HNSW tuning) or reasoning about recall vs.
latency. For configuration parameters, lifecycle, files on disk,
compression, background tasks, and the operational checklist →
`vector-operations.md`. State as of Eclipse Store 4.3.0.

## 1. Mode selection: embedded vs computed

`Vectorizer.isEmbedded()` says where a vector **comes from**. In both modes
the index keeps a copy of every vector in its memory-mapped vector file
(`{name}.vec`), scores the same way, and the storage itself holds no
vectors. The mode is fixed for the lifetime of the index.

| Aspect | Embedded (`isEmbedded() == true`) | Computed (default, `false`) |
|---|---|---|
| Source of the vector | A field of the entity (`record Doc(String text, float[] embedding)`) | `vectorize()` derives it (embedding API, model) |
| Cost of reproducing it | Cheap — read the field again | Expensive — one API / model call per entity |
| In-memory index at start | Re-reads every vector from the entities (temporary vector file) | With `indexDirectory` / `indexLocation`: reloads the kept vector file, no vectorizer call. Without: re-vectorizes **every entity, blocking the map** |
| On-disk index at start | Loads segments + vector file | Same |
| `reindex()` | Re-reads from the entities | Vectorizes once, keeps the vectors on the heap during the rebuild |
| Right when | The embedding is part of the entity's identity (pre-computed vectors ingested with the data) | The embedding is derived metadata from an external service |

**Heuristic.** If your domain object naturally carries the vector, pick
embedded. If the vector is computed by a service, pick computed **and
configure a directory or named location** — otherwise every start calls the
service once per entity.

### Vectorizer contract

- `vectorize()` must **reproduce the committed vector** of a persisted
  entity. The index re-vectorizes to repair its vector file after a crash
  (chunks since the last checkpoint) or when the file is lost; a model that
  drifts returns other vectors and the index takes them as they come.
- `null` is an error (`IllegalStateException` at add / update / reindex)
  unless `allowsNullVectors()` returns `true` — then `null` means "no
  embedding": the entity stays in the map and its other indices, is excluded
  from the vector index, and `getVector(id)` returns `null`. Transitions on
  update: non-null → null removes, null → non-null adds.
- It is called **concurrently** (searches by entity run alongside mutations).
  A computed result is copied by the index before the next call, so a
  reused buffer is allowed — but it must be **one per thread**
  (`ThreadLocal`), never one shared array. An embedded vectorizer returns
  the entity's own array, which is not copied.
- Override `vectorizeAll(List<E>)` to batch against APIs that support it
  (`input: ["a", "b", "c"]`). Same size, positional order; each element
  must hold its own array when the list is returned.
- Override `vectorKey(entity)` to return a cheap version key (record
  version, id). An update whose key is unchanged skips `vectorize()`
  entirely. Default `NO_KEY` compares vectors by content.
- Change what a vector derives from only through the map (`update`,
  `apply`, `set`, `replace`). A field mutated in place is not seen; the
  index keeps serving the old vector until `reindex()` or a recovery.
- The vectorizer instance is persisted with the index: keep configuration
  (model name, URL) in fields, mark clients / model handles `transient` and
  create them on first use.

## 2. Search API — overloads beyond `search(query, k)`

```java
// Top-k similar to an existing entity ("more like this")
VectorSearchResult<Doc> similar = embeddings.search(someDoc, 10);

// Override the search-time beam width per query (latency vs recall)
VectorSearchResult<Doc> highRecall = embeddings.search(queryVector, 10, 500);

// Round-trip a stored vector by entity id (copy from the vector file)
float[] stored = embeddings.getVector(entityId);
```

Every search uses `max(k, minSearchBeamWidth)` (default floor 100) unless
the per-query overload says otherwise, so the top-k stays stable across `k`.

## 3. Design-time limits

- **Java 25+.** `gigamap-jvector` is compiled with release 25.
- **~2.1 billion vectors per GigaMap.** Graph ordinals are the GigaMap entity
  ids cast to `int`; an id ≥ `Integer.MAX_VALUE` is rejected at add time.
  Several vector indices on the *same* map share those ids, so sharding
  means separate `GigaMap` instances (see §9).
- **Dimension is fixed at build.** A vector of another length throws on
  `add` (an index failure: the entity is kept, the index is stale until
  `reindex()`). A new model means a new index name + re-index.
- **Entity ids drive the ordinal space.** `PQ_IN_MEMORY` costs
  `pqSubspaces` bytes per ordinal, deletion holes included.
- **`eventualIndexing=true` decouples vector-file writes from graph
  mutations.** Search may miss recent adds until the queue drains; see
  `vector-operations.md`.

## 4. Similarity function selection

| Function | Best for | Notes |
|---|---|---|
| `COSINE` | Text/semantic embeddings (OpenAI, Cohere, BERT, sentence-transformers); image embeddings (CLIP); any direction-based representation | Default. Range [-1, 1]; 1 = identical direction. |
| `DOT_PRODUCT` | **Pre-normalized** vectors (you already divide by `‖v‖`); MIPS for recommendations | Same ranking as cosine on unit vectors, skips the normalization. |
| `EUCLIDEAN` | Geographic / spatial data, image pixels, FaceNet face embeddings, k-means clustering | Magnitude matters. Converted to a similarity internally. |

If your model documentation doesn't say, default to `COSINE`. The similarity
function is not recorded in the graph files: changing it means a new index.

## 5. HNSW parameter tuning

Two numbers dominate: `maxDegree` (graph connectivity) and `beamWidth`
(build-time fan-out).

```
recall ≈ f(maxDegree, beamWidth, search_beam_width)
build_time ∝ beamWidth · maxDegree
query_latency ∝ search_beam_width · log(N)
memory ∝ maxDegree · N           (+ pqSubspaces · maxDegree per node with FUSED_PQ)
```

### Starting points by dataset size

| Size | `maxDegree` | `beamWidth` | Preset |
|---|---|---|---|
| < 10K | 8–16 | 50–100 | `forSmallDataset(dim)` → 12 / 75 |
| 10K – 1M | 16–32 | 100–200 | `forMediumDataset(dim[, dir])` → 24 / 150 |
| > 1M | 32–64 | 200–400 | `forLargeDataset(dim, dir)` → 32 / 300, on-disk, `FUSED_PQ` on |
| Maximum recall | 48–64 | 400–500 | `forHighPrecision(dim[, dir])` → 56 / 450, exact scoring |

> **Rule of thumb.** Start with a preset. Measure recall on a held-out
> test set. Only change parameters when you have evidence.

### Per-query beam width

```java
embeddings.search(q, 10, 50);    // cheap: lower recall acceptable
embeddings.search(q, 10, 400);   // precision matters (billing-relevant)
```

`minSearchBeamWidth` on the configuration sets the floor (default 100; `1`
makes the beam equal to `k`).

### `alpha` and `neighborOverflow`

Construction-time pruning. Defaults (`1.2` / `1.2`) are fine for most
workloads; move them only against a benchmark.

## 6. Search semantics with sub-queries

`VectorSearchResult<E>` is both:

1. A **scored result** — iterable of `Entry<E>` ordered by descending
   similarity, each with `entityId()`, `score()`, and lazy `entity()`.
2. A **`GigaMap.SubQuery`** — combinable with `GigaQuery` and
   `LuceneSearchResult`.

- `gigaQuery.and(vectorResult)` → intersection by id set, **scores
  dropped**; result order is the `GigaQuery` order (unordered for bitmap).
- `vectorResult.and(gigaQuery)` → a `ScoredSearchResult` that preserves the
  vector ordering.

```java
docs.query(category.is("tech")).and(embeddings.search(qv, 100));   // id set
embeddings.search(qv, 100).and(docs.query(category.is("tech")));   // ranked
```

RAG-style: vector recall pulls a wide candidate pool, bitmap pre-filters by
domain, Lucene post-filters by keyword, ranking stays by vector score:

```java
ScoredSearchResult<Doc> ranked =
    embeddings.search(queryVec, 200)
              .and(docs.query(category.is("tech")
                              .and(publishedAfter.greaterThan(cutoff))))
              .and(lucene.search("\"distributed systems\"", 200));
```

## 7. Choosing the right preset

| Workload | Preset |
|---|---|
| Prototype, < 10K vectors, in-memory | `forSmallDataset(dim)` |
| Production, 10K–1M, in-memory | `forMediumDataset(dim)` |
| Production, 10K–1M, durable across restart | `forMediumDataset(dim, indexDirectory)` |
| Production, > 1M, graph larger than the page cache | `forLargeDataset(dim, dir)` (`FUSED_PQ` on — larger files, fewer reads) |
| Production, > 1M, graph fits the page cache | `forLargeDataset(dim, dir, false)` |
| Production, > 1M, smallest files | `forCompactLargeDataset(dim, dir)` (`NVQ`, exact scoring, parallel writes) |
| Recall-critical (legal, medical, billing) | `forHighPrecision(dim)` / `(dim, dir)` |

Each has a `builderFor*(...)` variant — same defaults, returns a `Builder`:

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration
    .builderForLargeDataset(768, Path.of("data/vectors"))
    .similarityFunction(VectorSimilarityFunction.DOT_PRODUCT)
    .approximateScoring(ApproximateScoring.NONE)       // graph fits the page cache
    .build();
```

A computed vectorizer with an in-memory preset (`forSmallDataset`,
`forMediumDataset(dim)`) still needs `.indexDirectory(...)` or
`.indexLocation(...)` via the builder twin, or it re-vectorizes at every start.

## 8. Recall measurement

Don't assume — measure. Recall is the fraction of true top-k neighbours
your index returns; it depends on data distribution and parameters.

```java
double recallAtK(VectorIndex<Doc> idx, List<Query> tests, int k) {
    double sum = 0;
    for (Query q : tests) {
        Set<Long> indexHits = idx.search(q.vector(), k).stream()
            .map(e -> e.entityId()).collect(toSet());
        Set<Long> truth = q.groundTruthTopK(k);     // brute-force scan
        sum += (double) intersect(indexHits, truth).size() / k;
    }
    return sum / tests.size();
}
```

Aim for ≥ 0.95 recall@10 in production. If a preset falls short, raise the
per-query `searchBeamWidth` / `minSearchBeamWidth` first (cheapest), then
`beamWidth`, then `maxDegree`. With `FUSED_PQ`, a smaller `pqSubspaces`
needs a wider beam to hold recall.

Upstream benchmark (10K × 128-dim clustered data, `gigamap-jvector` README):
recall@10 ≈ 94.3%, ~10K QPS, p99 latency < 0.2 ms.

## 9. Sharding past 2.1B

Ordinals are entity ids, so the ceiling is per **GigaMap**, not per index.
Shard across maps:

```java
int shard = (int)(Math.abs(entity.id().hashCode()) % NUM_SHARDS);
shards[shard].map().add(entity);

List<VectorSearchResult<E>> all = Arrays.stream(shards)
    .map(s -> s.embeddings().search(query, k))
    .toList();
List<Entry<E>> merged = mergeTopK(all, k);     // by score across shards
```

Separate maps also keep the segment locks and the ordinal-sized structures
(`PQ_IN_MEMORY` codes) per shard.
