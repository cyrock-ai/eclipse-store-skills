# Vector index deep-dive — gigamap-jvector

Companion to the SKILL.md vector section. Read this when designing the
index shape (mode, similarity, HNSW tuning) or reasoning about recall vs.
latency. For configuration parameters, lifecycle, on-disk format, PQ,
background tasks, and the operational checklist → `vector-operations.md`.

## 1. Mode selection: embedded vs computed

`Vectorizer.isEmbedded()` is the most consequential decision in the whole
vector setup. It is **not** something you change later without rebuilding
the index from scratch.

| Aspect | Embedded (`isEmbedded() == true`) | Computed (default, `false`) |
|---|---|---|
| Where the vector lives | On the entity itself (`record Doc(String text, float[] embedding)`) | In an internal `GigaMap<VectorEntry>` (the `vectorStore`) |
| When `vectorize()` runs | On every graph build/search hit (cached per-search) | Once at `gigaMap.add(entity)` |
| Storage overhead | None — vector is part of the entity | One `VectorEntry(entityId, float[])` per entity |
| API call cost on restart | None — vector reloaded with the entity | None — `vectorStore` reloads with the GigaMap |
| Right when | The embedding is part of the entity's identity (e.g. you ingest pre-computed embeddings, you stream from a Kafka topic that includes vectors) | The embedding is computed by an external service (OpenAI, sentence-transformers running in another process), or it's expensive to compute and you don't want to redo it |
| Memory profile under search load | Stable — vectors aren't duplicated | Slightly higher — `vectorStore` is paged in for the segments touched |
| Update cost | Slightly degraded recall until next `optimize()` | Clean — `VectorEntry` swapped in `vectorStore`, graph updated normally |

**Heuristic.** If your domain object would naturally carry the vector (a doc
record with `text` and `embedding`), pick embedded. If the vector is "extra
metadata bolted on by an external service", pick computed.

### Vectorizer contract

`Vectorizer.vectorize()` **must be thread-safe** — multiple build / search
threads call it concurrently on the same instance — and **must never return
`null`** for an entity that's present (throws `IllegalStateException` at
insert time). Override `vectorizeAll(List<E>)` to batch-vectorize against
APIs that support it (e.g. OpenAI's `input: ["a", "b", "c"]` form) — the
default loops one at a time.

## 2. Search API — overloads beyond `search(query, k)`

```java
// Top-k similar to an existing entity ("more like this") — convenience overload
VectorSearchResult<Doc> similar = embeddings.search(someDoc, 10);

// Override search-time beam width per query (latency vs recall)
VectorSearchResult<Doc> highRecall = embeddings.search(queryVector, 10, 200);

// Round-trip a stored vector by entity id
float[] stored = embeddings.getVector(docs.add(new Doc(...)));
```

## 3. Design-time limits

- **~2.1 billion vectors per index.** JVector uses `int` for graph node
  ordinals. Shard across multiple `VectorIndex` instances if you exceed
  it (see Sharding section below).
- **Dimension is fixed at build.** Mixing 768-dim and 1024-dim throws on
  `add`. Changing dimension means a new index name + rebuild.
- **PQ compression silently sets `maxDegree=32`** (FusedPQ requirement).
  Don't fight it — pick PQ or `maxDegree`, not both.
- **`eventualIndexing=true` decouples vector-store writes from graph
  mutations.** Search may miss recent adds until the queue drains; see
  `vector-operations.md` for consistency-checkpoint semantics.

## 4. Similarity function selection

| Function | Best for | Notes |
|---|---|---|
| `COSINE` | Text/semantic embeddings (OpenAI, Cohere, BERT, sentence-transformers); image embeddings (CLIP); any direction-based representation | Default. Range [-1, 1]; 1 = identical direction. Most robust if you're unsure. |
| `DOT_PRODUCT` | **Pre-normalized** vectors (you already divide by `‖v‖`); MIPS for recommendations | Same ranking as cosine on unit vectors, faster (skips the normalization step). |
| `EUCLIDEAN` | Geographic / spatial data, image pixels, FaceNet face embeddings, k-means clustering | Magnitude matters. Range [0, +∞); 0 = identical. |

If your model documentation doesn't say, default to `COSINE`.

## 5. HNSW parameter tuning

Two numbers dominate: `maxDegree` (graph connectivity) and `beamWidth`
(build-time fan-out).

```
recall ≈ f(maxDegree, beamWidth, search_beam_width)
build_time ∝ beamWidth · maxDegree
query_latency ∝ search_beam_width · log(N)
memory ∝ maxDegree · N
```

### Starting points by dataset size

| Size | `maxDegree` | `beamWidth` | Notes |
|---|---|---|---|
| < 10K | 8–16 | 50–100 | Lower values are sufficient. Use `forSmallDataset(dim)`. |
| 10K – 1M | 16–32 | 100–200 | Balanced. Use `forMediumDataset(dim, ...)`. |
| > 1M | 32–64 | 200–400 | Higher for better recall on a longer tail. Use `forLargeDataset(dim, dir)`. |
| Maximum recall | 48–64 | 400–500 | Pay the build cost once; queries stay fast. Use `forHighPrecision(dim)`. |

> **Rule of thumb.** Start with a preset. Measure recall on a held-out
> test set. Only change parameters when you have evidence — knob-twiddling
> without measurement just makes the index bigger or slower.

### Per-query beam width

`search(query, k, searchBeamWidth)` lets you trade recall vs latency at
query time. A common pattern is two tiers:

```java
// Cheap: 95% recall is fine
embeddings.search(q, 10, 50);

// Expensive: precision matters (e.g., billing-relevant)
embeddings.search(q, 10, 400);
```

`minSearchBeamWidth` on the configuration sets a floor.

### `alpha` and `neighborOverflow`

These tune the construction-time pruning. Defaults (`alpha=1.2`,
`neighborOverflow=1.2`) are fine for most workloads. Move them only if
you've validated against a benchmark.

## 6. Search semantics with sub-queries

`VectorSearchResult<E>` is both:

1. A **scored result** — iterable of `Entry<E>` ordered by descending
   similarity, each with `entityId()`, `score()`, and lazy `entity()`.
2. A **`GigaMap.SubQuery`** — combinable with `GigaQuery` and
   `LuceneSearchResult`.

When used as a `SubQuery`:

- `gigaQuery.and(vectorResult)` → intersection by id set, **scores dropped**.
  The result follows the `GigaQuery` order (which is unordered for bitmap
  queries, so don't rely on order).
- `vectorResult.and(gigaQuery)` → returns a `ScoredSearchResult` that
  preserves vector ordering.

```java
// Drops scores, gives you a deterministic id set
docs.query(category.is("tech")).and(embeddings.search(qv, 100));

// Keeps scores, ranking by similarity
embeddings.search(qv, 100).and(docs.query(category.is("tech")));
```

A typical RAG-style pattern: vector recall pulls a wide candidate pool,
bitmap pre-filters narrow by domain, Lucene does keyword post-filtering,
the final list is ranked by vector score:

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
| Quick prototype, < 10K vectors, in-memory | `forSmallDataset(dim)` |
| Production, 10K–1M, in-memory | `forMediumDataset(dim)` |
| Production, 10K–1M, durable across restart | `forMediumDataset(dim, indexDirectory)` |
| Production, > 1M | `forLargeDataset(dim, indexDirectory)` |
| Production, > 1M, RAM-constrained | `forLargeDataset(dim, dir, true)` (PQ) |
| Recall-critical (legal, medical, billing) | `forHighPrecision(dim)` / `(dim, dir)` |

Each has a `builderFor*(...)` variant — same defaults, returns a `Builder`
so you can override one parameter and `.build()`:

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration
    .builderForLargeDataset(768, Path.of("data/vectors"))
    .similarityFunction(VectorSimilarityFunction.DOT_PRODUCT)  // override
    .build();
```

## 8. Recall measurement

Don't assume — measure. Recall is the fraction of true top-k neighbours
your index returns; it depends on data distribution and parameters.

```java
// Generate or load a held-out test set with known ground truth.
// For each query, compare index search to a brute-force scan.
double recallAtK(VectorIndex<Doc> idx, List<Query> tests, int k) {
    double sum = 0;
    for (Query q : tests) {
        Set<Long> indexHits = idx.search(q.vector(), k).stream()
            .map(e -> e.entityId()).collect(toSet());
        Set<Long> truth = q.groundTruthTopK(k);
        sum += (double) intersect(indexHits, truth).size() / k;
    }
    return sum / tests.size();
}
```

Aim for ≥ 0.95 recall@10 in production search. If you can't get there with
the current preset, increase `beamWidth` first, then `maxDegree`, then
`searchBeamWidth` per query.

For benchmark numbers on 10K × 128-dim clustered data, see the
`gigamap-jvector` README — recall@10 ≈ 94.3% with default parameters,
~10K QPS, p99 latency < 0.2 ms.

## 9. Sharding past 2.1B

Single-index ceiling: `Integer.MAX_VALUE` ordinals. Past that, shard:

```java
// Route by entity id
int shard = (int)(Math.abs(entity.id().hashCode()) % NUM_SHARDS);
shards[shard].add(entity);

// Gather-and-merge for search
List<VectorSearchResult<E>> all = Arrays.stream(shards)
    .map(s -> s.embeddings().search(query, k))
    .toList();
// Merge top-k by score across shards
List<Entry<E>> merged = mergeTopK(all, k);
```

Either separate `VectorIndex` instances on the same `GigaMap`, or separate
`GigaMap` instances per shard — the second scales better past several
shards because GigaMap segment locks aren't shared.
