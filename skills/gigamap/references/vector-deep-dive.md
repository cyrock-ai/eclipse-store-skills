# Vector index deep-dive — gigamap-jvector

Companion to the SKILL.md vector section. Read this when designing the index
shape (mode, on-disk, PQ, eventual indexing) or tuning recall vs. latency.

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
| Update cost | Slightly degraded recall until next `optimize()` (see Pitfall 20) | Clean — `VectorEntry` swapped in `vectorStore`, graph updated normally |

**Heuristic.** If your domain object would naturally carry the vector (a doc
record with `text` and `embedding`), pick embedded. If the vector is "extra
metadata bolted on by an external service", pick computed.

## 2. Similarity function selection

| Function | Best for | Notes |
|---|---|---|
| `COSINE` | Text/semantic embeddings (OpenAI, Cohere, BERT, sentence-transformers); image embeddings (CLIP); any direction-based representation | Default. Range [-1, 1]; 1 = identical direction. Most robust if you're unsure. |
| `DOT_PRODUCT` | **Pre-normalized** vectors (you already divide by `‖v‖`); MIPS for recommendations | Same ranking as cosine on unit vectors, faster (skips the normalization step). |
| `EUCLIDEAN` | Geographic / spatial data, image pixels, FaceNet face embeddings, k-means clustering | Magnitude matters. Range [0, +∞); 0 = identical. |

If your model documentation doesn't say, default to `COSINE`.

## 3. HNSW parameter tuning

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

## 4. On-disk lifecycle

Two files per index, named after the index:

- `{name}.graph` — JVector `OnDiskGraphIndex` payload. Memory-mapped on load.
- `{name}.meta` — 24-byte sidecar: format version, dimension, expected count,
  highest entity id.

### Restart behaviour

On startup with `onDisk=true` and existing files:

1. `tryLoad()` checks both files.
2. Read `.meta` and verify all four fields against the live state.
3. Any mismatch → return `false`, fall back to a full rebuild from
   `vectorStore` (computed mode) or by iterating `parentMap` (embedded mode).
4. On match → memory-map the `.graph`, mark PQ as trained if `FusedPQ` is
   embedded, enter **incremental on-disk mode**.

### Incremental on-disk mode

After a successful disk load:

- The disk graph serves searches.
- New mutations go to a fresh in-memory builder (delta graph).
- Removed/updated ordinals are tracked in `diskDeletedOrdinals` so disk-side
  search filters them out.
- Searches **merge** results from the disk graph and the in-memory delta,
  taking the global top-k.

The next `persistToDisk()` exits incremental mode (full rebuild from source
into a single in-memory graph), writes that graph to disk, and re-enters
incremental mode for the next batch of mutations.

This is invisible to user code — it's transparently efficient when
mutation volume is low between persists.

### Format version migrations

`{name}.meta` carries a format version. Bumping it (e.g. from v1 to v2,
which added `highestEntityId` to catch count-collision corruption) silently
invalidates older files: they are rebuilt on first load. **One-time
cold-start cost, no data loss.** Plan for it on upgrade.

## 5. PQ compression

Product Quantization compresses each vector into a sequence of small
codebook indices. A 768-float vector (3 KB) collapses to ~192 bytes.

- HNSW operates on **compressed** codes for fast candidate scoring.
- A reranking pass over the **exact** vectors — pulled from `InlineVectors`
  embedded in the `.graph` file — produces the final top-k.

Trade-offs:

| Aspect | Without PQ | With PQ |
|---|---|---|
| Memory (graph) | Full vectors loaded for distance | Compressed codes; ~16× smaller |
| Recall | Highest | Slightly lower (depends on `pqSubspaces`) |
| Search latency | Lower per node | Faster scan, slower rerank |
| Build time | Faster | Slower (codebook training) |
| `maxDegree` | Free | Forced to 32 by FusedPQ |
| When to use | < 1M vectors, RAM headroom | > 1M vectors, RAM-constrained |

`pqSubspaces` defaults to `dimension / 4`. It must divide the dimension
evenly. Higher = larger codebook, more memory, better recall.

## 6. Background tasks

`gigamap-jvector` runs three optional workloads on a single daemon thread
named `VectorIndex-Background-{name}`:

- **Indexing queue** (eventual indexing): drains the deferred-mutation
  queue, applying graph adds/updates/removes.
- **Optimization**: runs `cleanup()` periodically — removes excess
  neighbours accumulated during construction, improves query latency.
- **Persistence**: writes the on-disk graph + meta files.

Each is enabled by setting its interval to `> 0`:

```java
.eventualIndexing(true)
.optimizationIntervalMs(60_000)        // 1 min
.minChangesBetweenOptimizations(1000)
.persistenceIntervalMs(30_000)         // 30 s
.minChangesBetweenPersists(100)
```

The thresholds (`minChangesBetween*`) prevent thrash: if nothing has changed
since the last run, the periodic check is a no-op.

### Eventual indexing — consistency model

With `eventualIndexing=true`:

- `gigaMap.add(entity)` updates `vectorStore` synchronously (data is
  durable; restart sees it).
- Graph mutation is **queued** for the background thread.
- Search may not see the change for the queue-drain interval.

`optimize()`, `persistToDisk()`, and `close()` all drain the queue first
before doing their main work — they're consistency checkpoints.

If you need read-your-write semantics on every search, leave
`eventualIndexing` at the default `false`. The trade-off is higher add
latency under sustained write load.

### `persistOnShutdown` corner case

If you have **no background features enabled** (no `eventualIndexing`, no
background optimize, no background persist) but `persistOnShutdown=true`
and `onDisk=true`, `close()` falls through to a direct `persistToDisk()`
call. Without that fall-through, in-memory changes would be silently
dropped. This was a real bug fixed in upstream commit `fa189228`.

## 7. Search semantics with sub-queries

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

## 8. Choosing the right preset

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

## 9. Recall measurement

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

## 10. Sharding past 2.1B

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

## 11. Operational checklist

Before shipping a vector index to production:

- [ ] JVM started with `--add-modules jdk.incubator.vector`.
- [ ] Java 20+ (21 LTS recommended) for full SIMD acceleration.
- [ ] `dimension` matches the embedding model exactly.
- [ ] `Vectorizer.vectorize()` is thread-safe (no shared mutable state).
- [ ] `Vectorizer.vectorize()` cannot return `null` for entities you'll add.
- [ ] If `> 1M` vectors, `onDisk=true` with a backed-up `indexDirectory`.
- [ ] If RAM-constrained, `enablePqCompression(true)` (accept `maxDegree=32`).
- [ ] Background `persistenceIntervalMs` set if you can't tolerate restart
      cold-start cost.
- [ ] Recall measured on a held-out set, not assumed.
- [ ] Backup strategy covers the `indexDirectory` alongside the EclipseStore
      `storage/` directory.
- [ ] Monitoring on add latency and search latency p50/p99.
