# Vector index operations — gigamap-jvector

Companion to `vector-deep-dive.md`. That file covers *what* the vector
index does and *how* to design around it (mode, similarity, HNSW tuning,
sub-queries, recall). This file covers *how to configure and operate* it:
parameter reference, restart-safe wiring, on-disk lifecycle, PQ,
background tasks, operational checklist.

## `VectorIndexConfiguration` — lifecycle parameters

Full parameter catalogue (HNSW: `dimension`, `maxDegree`, `beamWidth`,
`alpha`, `neighborOverflow`, `minSearchBeamWidth`, `similarityFunction`,
`enablePqCompression`, `pqSubspaces`) → `api-catalogue.md` §
*Vector index → VectorIndexConfiguration*.

The parameters below are the ones that change runtime / lifecycle
behaviour and matter for the rest of this file:

| Parameter | Default | What it controls |
|---|---|---|
| `onDisk` | `false` | Memory-map graph from disk. Required for datasets > RAM. |
| `indexDirectory` | `null` | Path for `{name}.graph` + `{name}.meta` files. Required if `onDisk=true`. |
| `parallelOnDiskWrite` | `false` | Multi-threaded persist. Faster for huge indices, more resources. |
| `eventualIndexing` | `false` | Defer graph mutations to background thread (vector store still updated synchronously). Reduces add latency, search briefly stale. |
| `persistenceIntervalMs` | 0 (off) | Background persist every N ms. |
| `minChangesBetweenPersists` | 100 | Persist threshold. |
| `persistOnShutdown` | `true` | Flush on `close()`. |
| `optimizationIntervalMs` | 0 (off) | Background `cleanup()` every N ms. |
| `minChangesBetweenOptimizations` | 1000 | Optimize threshold. |
| `optimizeOnShutdown` | `false` | Run cleanup on `close()`. |

## Lifecycle and restart-safe wiring

### Restart-safe registration

`GigaIndices.register(category)` is **not idempotent**: after the GigaMap
is deserialized from storage, the vector category is already attached and
`register(VectorIndices.Category())` returns `null`. Mirror the
get-or-register pattern from Lucene:

```java
VectorIndices<E> indices = map.index().get(VectorIndices.class);
if (indices == null) indices = map.index().register(VectorIndices.Category());

VectorIndex<E> embeddings = indices.ensure(name, cfg, vectorizer);  // restart-safe
```

`indices.ensure(name, cfg, vectorizer)` is the restart-safe sibling of
`indices.add(...)` — on the second run it returns the existing named
index instead of throwing.

### Closeable + close order

`VectorIndex extends GigaIndex, Closeable`. The on-disk graph holds file
handles (memory-mapped `.graph`, the `.meta` sidecar), and lifecycle is
**not** cascaded by `EmbeddedStorageManager.close()`. If you reopen
storage in the same JVM you must close the vector index first:

```java
try { vectorIndex.close(); } catch (IOException ignore) {}
storage.close();
```

`close()` first drains the eventual-indexing queue, flushes per
`persistOnShutdown`, optionally runs `optimize()` per `optimizeOnShutdown`,
then releases file handles. The same instance can be re-used after
`close()` — lazy reinitialization kicks in on the next call.

## On-disk lifecycle

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

## PQ compression

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

## Background tasks

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

## Operational checklist

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
