# Vector index operations — gigamap-jvector

Companion to `vector-deep-dive.md`. That file covers *what* the vector
index does and *how* to design around it (mode, similarity, HNSW tuning,
sub-queries, recall). This file covers *how to configure and operate* it:
parameter reference, restart-safe wiring, files on disk, compression,
background tasks, upgrade from 4.x, operational checklist. State as of
Eclipse Store 4.3.0.

## Runtime requirements

- **Java 25+** for `gigamap-jvector` (compiled with release 25; uses the
  foreign memory API for its vector file).
- JVM flags: `--add-modules jdk.incubator.vector` (SIMD scoring) and
  `--enable-native-access=ALL-UNNAMED` (memory-mapped graph reader;
  `=jvector` on the module path).

## `VectorIndexConfiguration` — parameters

HNSW (`dimension` required, the rest default):

| Parameter | Default | What it controls |
|---|---|---|
| `similarityFunction` | `COSINE` | `COSINE` / `DOT_PRODUCT` / `EUCLIDEAN`. |
| `maxDegree` | 16 | Neighbours per node. Also multiplies the fused PQ block size. |
| `beamWidth` | 100 | Build-time fan-out (efConstruction). No effect at query time. |
| `minSearchBeamWidth` | 100 | Search floor: effective beam = `max(k, minSearchBeamWidth)`. `1` disables the floor. |
| `neighborOverflow` / `alpha` | 1.2 / 1.2 | Construction pruning. Leave alone unless benchmarked. |

Files and format:

| Parameter | Default | What it controls |
|---|---|---|
| `onDisk` | `false` | Graph as memory-mapped segment files instead of heap. Required for graphs > RAM. |
| `indexDirectory(Path)` | `null` | Directory for segments, manifest and vector file. Required with `onDisk` unless `indexLocation` is set. Also keeps the vector file of an **in-memory computed** index across restarts. |
| `indexLocation(IndexLocation)` | `null` | `Absolute(path)` = `indexDirectory`; `Named(name)` is bound at runtime → `index-locations.md`. |
| `vectorStorage` | `INLINE` | How the graph stores its vector copy. `NVQ` = 8-bit quantized, ~3× smaller file, scores stay exact. On-disk only. |
| `approximateScoring` | `NONE` | How traversal scores: `FUSED_PQ` (codes in the graph, on-disk only, **larger** file), `PQ_IN_MEMORY` (codes in heap, `pqSubspaces` bytes per ordinal; in memory needs `optimizationIntervalMs > 0`). |
| `enablePqCompression` | `false` | Deprecated alias: `true` = `FUSED_PQ`. |
| `pqSubspaces` | 0 (auto `dimension/4`) | Must divide `dimension` when set explicitly. |
| `nvqSubvectors` | 0 (auto 1) | NVQ only; each adds 28 bytes per node. |
| `parallelOnDiskWrite` | `false` | Multi-threaded segment writes. Turn on with `NVQ`. |
| `flushThreshold` | 100000 | Nodes in the in-memory graph before a background persist writes a segment. |
| `segmentMergeFactor` / `maxSegments` | 4 / 32 | Background merge width; hard cap after which a persist consolidates (blocking). |
| `vectorCheckpointIntervalMs` | 30000 | How often the vector file is forced to disk; after a crash only the chunks written since are re-vectorized. |
| `vectorChunkBytes` | 64 MB | Chunk size of the vector file (min. 2048 vectors). Changing it re-vectorizes everything. |

Lifecycle and background tasks:

| Parameter | Default | What it controls |
|---|---|---|
| `eventualIndexing` | `false` | Defer graph mutations to a background thread. The vector file is written synchronously. |
| `persistenceIntervalMs` | 0 (off) | Background persist check. **Requires `onDisk`.** |
| `minChangesBetweenPersists` | 100 | Debounce. |
| `persistOnShutdown` | `true` | Persist on `close()` when `onDisk`. |
| `shutdownPersistTimeoutMillis` | 30000 | Bound for the final drain / persist in `close()`; an aborted persist only costs a rebuild on the next start. |
| `optimizationIntervalMs` | 0 (off) | Background `cleanup()` of an **in-memory** graph. No effect on an on-disk index (each segment is cleaned as it is written). |
| `minChangesBetweenOptimizations` | 1000 | Debounce. |
| `optimizeOnShutdown` | `false` | Cleanup on `close()`. |

`build()` rejects: `onDisk` without a directory or location, `FUSED_PQ` /
`NVQ` / background persistence without `onDisk`, `PQ_IN_MEMORY` in memory
without `optimizationIntervalMs`, `pqSubspaces` not dividing `dimension`.
PQ does **not** change `maxDegree` (the old "FusedPQ forces 32" rule is gone).

## Where the vectors live

The storage holds **no vectors**. Each index keeps them in a memory-mapped
*vector file* (`{name}.vec` + chunks `{name}.vec-{n}`) — a cache of what the
vectorizer derives from the entities. Consequences:

- `vectorize()` must reproduce the committed vector of a persisted entity:
  the index calls it again after a crash (chunks since the last checkpoint)
  and whenever the file is missing or does not match the stored index.
- An **on-disk** index keeps the file in its directory.
- An **in-memory computed** index keeps it in `indexDirectory` /
  `indexLocation` if configured (`keepsIndexFiles()` = `true`) and then
  restarts without a vectorizer call per entity.
- Every other in-memory index (embedded, or computed without a directory)
  uses a temporary file under `<java.io.tmpdir>/eclipsestore-vectors`
  (`-Dorg.eclipse.store.gigamap.jvector.temporaryRoot=…`) and re-vectorizes
  **every entity at every start, under the map's lock**. For an embedding
  service that means one API call per entity per start — configure a
  directory.
- Back up and restore the index directory **together with** the storage.
  Deleting the vector file only costs a full re-vectorization; restoring it
  from another point in time than the storage is not supported.

## Lifecycle and restart-safe wiring

```java
VectorIndices<E> indices = map.index().get(VectorIndices.class);
if (indices == null) indices = map.index().register(VectorIndices.Category());
VectorIndex<E> embeddings = indices.ensure(name, cfg, vectorizer);   // restart-safe
```

`register(...)` returns `null` once the category is attached (every run
after the first), hence the guard. `ensure` returns an existing index
**unchanged** — the persisted configuration and vectorizer win, a changed
`cfg` is silently ignored (a changed location logs a warning). To
reconfigure: `removeIndex(name)` then `add(...)` (re-indexes every entity),
or `changeIndexLocation(name, location)` for the location alone.

The vectorizer instance is persisted by reference with the index: mark heavy
fields (HTTP clients, model handles) `transient` and create them lazily.

### Closing

`EmbeddedStorageManager.shutdown()` closes every index group of every
loaded GigaMap (`GigaMap` participates in storage shutdown), persisting
per `persistOnShutdown`. Calling `vectorIndex.close()` yourself is not
required; it is only needed for a map that is not part of a storage. Never
call `close()`, `optimize()` or `persistToDisk()` while holding the map's
monitor (`synchronized(map)`, inside `update` / `apply` logic) — they throw
`IllegalStateException` instead of deadlocking.

## Files on disk

An on-disk index directory holds:

- `{name}.manifest` — the commit point: segment list, per-segment format and
  deletions, and the stored-index state it describes (vector count,
  highest entity id, structural modification count), CRC32-checked.
- `{name}.seg-{n}.graph` — HNSW graph of segment `n` (edges, inline or NVQ
  vectors, fused PQ codes with `FUSED_PQ`).
- `{name}.seg-{n}.l2g` — entity id of each node of segment `n`.
- `{name}.seg-{n}.pqv` — PQ codes + codebook, only with `PQ_IN_MEMORY`.
- `{name}.vec`, `{name}.vec-{n}` — the vector file.

Segment files are synced before the manifest that lists them; the manifest
is replaced atomically; files no manifest lists are deleted at the next load.

### Persist lifecycle

New entities go into an in-memory graph. A persist freezes it, writes it as
one more immutable segment while a fresh graph takes new mutations, and
commits a new manifest — nothing is rebuilt, searches and mutations go on.
Background merges combine `segmentMergeFactor` segments of similar size; only
if they fall behind `maxSegments` does a persist consolidate everything into
one segment (blocking). A search visits every segment plus the in-memory
graph and merges by score.

### Restart behaviour

The manifest is accepted when its checksum holds and its state matches the
stored index. Otherwise (e.g. the process ended after a `store()` of the map
but before the next persist, or a segment fails to open) the graph is rebuilt
from the vector file and the next persist replaces the files — scheduled
even if the index is only searched. 4.x files (`{name}.graph`, `.meta`,
`.pqv`) are ignored, logged once, and can be deleted.

A segment written under another `vectorStorage` / `approximateScoring` /
subspace count is still used (searched exactly) and rewritten by the next
merge or explicit `persistToDisk()`.

## Compression

| Setting | Effect on the graph file | When |
|---|---|---|
| `vectorStorage = NVQ` | ~3× **smaller** (8-bit vectors); reranking reads the full-precision vector file, so scores stay exact | Index exceeds page cache; pair with `parallelOnDiskWrite(true)` |
| `approximateScoring = FUSED_PQ` | **Larger** (`pqSubspaces × maxDegree` bytes per node); one sequential read per hop instead of `maxDegree` random reads | Graph larger than the page cache; costs some recall — widen `minSearchBeamWidth` |
| `approximateScoring = PQ_IN_MEMORY` | Unchanged; `pqSubspaces` bytes per *ordinal* resident in heap (deletion holes included) | Same traversal benefit without disk growth; size the heap first |

PQ never shrinks the index. While the graph fits in the page cache, `NONE`
is both faster and more accurate. Codebooks train at the first persist with
≥ 256 vectors (in memory: at the first optimization — the switch is an O(n)
rebuild that holds the map's lock). `isPqCompressionActive()` /
`isNvqCompressionActive()` report whether a codebook / quantizer exists yet.

## Background tasks and eventual indexing

Each enabled task runs on the index's background thread:

```java
.eventualIndexing(true)
.optimizationIntervalMs(60_000)        // in-memory indices only
.minChangesBetweenOptimizations(1000)
.persistenceIntervalMs(30_000)         // on-disk indices only
.minChangesBetweenPersists(100)
```

With `eventualIndexing=true`:

- `gigaMap.add(entity)` writes the vector file synchronously (durable);
  the graph mutation is queued.
- Search may miss the change until the worker applies it (same window for
  removals and `null` transitions).
- `optimize()` and `close()` drain the queue first. `persistToDisk()` does
  **not** wait: it takes the pending operations into the segment it writes.

Leave it off when the next search must see the write.

## Upgrading from 4.x

A storage written by 4.0.0–4.2.0 opens without preparation: a computed
index imports the vectors of its old vector store into the vector file
(no vectorizer call); old graph files are ignored and rebuilt. **One way:**
after the first `store()` on 4.3.0 the storage cannot be opened by 4.x
(`Missing runtime type ... VectorIndexFormat`). Back up first.

A 4.x **in-memory computed index without a directory** imports into a
temporary file; storing the map is refused until the index gets a location
(`VectorIndices.changeIndexLocation(name, location)`, which moves the
vectors there at once) or
`-Dorg.eclipse.store.gigamap.jvector.dropLegacyVectorsWithoutLocation=true`
(re-vectorizes every entity at every later start).

## Operational checklist

- [ ] Java 25+, JVM started with `--add-modules jdk.incubator.vector --enable-native-access=ALL-UNNAMED`.
- [ ] `dimension` matches the embedding model exactly.
- [ ] `vectorize()` is deterministic (same persisted entity → same vector) and safe to call concurrently.
- [ ] `null` vectors either impossible or opted in via `allowsNullVectors()`.
- [ ] Computed vectorizer: `indexDirectory` / `indexLocation` configured, heavy fields `transient`, `vectorKey()` for versioned entities.
- [ ] Vector changes go through `update` / `apply` / `set` / `replace`, never a direct field write.
- [ ] `> 1M` vectors or > RAM: `onDisk=true`; `NVQ` for size, `FUSED_PQ` only for a graph larger than the page cache.
- [ ] Moved / restored storages: `IndexLocation.Named` + `IndexLocations.bind` before start.
- [ ] Backup covers the index directory together with the `storage/` directory (same point in time).
- [ ] Recall measured on a held-out set, not assumed.
- [ ] 4.x → 4.3.0 upgrade is one way; backup taken before the first store.
