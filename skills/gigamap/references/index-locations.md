# Index locations — on-disk vector and Lucene index directories

On-disk JVector indices and Lucene indices with an MMap directory keep their
files **outside** the storage; the storage remembers where. An
`IndexLocation` (core `gigamap` artifact, `org.eclipse.store.gigamap.types`)
decides *what* it remembers. Available since Eclipse Store 4.3.0.

| Location | Stored in the storage | Where the files are |
|---|---|---|
| `IndexLocation.Absolute(path)` | The path | Always that path. Same as `indexDirectory(path)` / `DirectoryCreator.MMap(path)`. |
| `IndexLocation.Named(name)` | Only the name | The directory the application binds the name to at runtime. |

A plain path points a moved, copied or restored storage at the **original**
directory — it shares or overwrites the original's index files, or silently
opens an empty Lucene index. A named location works like a data-source name:
the storage says *which* index directory it needs, the application says
*where* it is on this machine.

## Binding names

Bind at application startup, **before** the storage is started:

```java
IndexLocations.bind("vectors",  Path.of("/data/myapp/vector-index"));
IndexLocations.bind("fulltext", Path.of("/data/myapp/lucene-index"));

EmbeddedStorageManager storage = EmbeddedStorage.start(Path.of("/data/myapp/storage"));
```

- A name is resolved once, when the index is created or loaded (also for
  maps loaded later behind a `Lazy`). Rebinding does not move an open index.
- Bindings are **JVM-wide**, not per storage. Two storages in one JVM must
  use different names; never bind two storages' names to one directory.
- An unbound name fails loudly when the index is created or loaded — no
  fallback to a default or previous directory.
- A bound path is never stored, so it may be relative.
- Index names are unique only within one GigaMap. Two maps sharing a
  location must not have indices of the same name (their files would
  overwrite each other) — give each map its own location or name the index.

## Using named locations

```java
// JVector
VectorIndexConfiguration cfg = VectorIndexConfiguration.builder()
    .dimension(768)
    .onDisk(true)
    .indexLocation(IndexLocation.Named("vectors"))      // instead of .indexDirectory(path)
    .build();

// Lucene
LuceneContext<Article> ctx = LuceneContext.New(
    DirectoryCreator.MMap(IndexLocation.Named("fulltext")), new ArticlePopulator());

// Annotation-based
IndexerGenerator.AnnotationBased(Product.class)
    .register(VectorAnnotationHandler.New(IndexLocation.Named("vectors")))
    .register(LuceneAnnotationHandler.New(IndexLocation.Named("fulltext")))
    .generateIndices(gigaMap);
```

`VectorAnnotationHandler.New(Path base)` puts each index into
`base/<indexName>/`; `New(IndexLocation.Named("x"))` puts the files of all
its indices directly into the bound directory, named after the index.

An **in-memory computed** vector index also keeps its vector file at a
configured location (`VectorIndex.keepsIndexFiles()`), which spares it a
vectorizer call per entity at every start.

## Moving, copying or restoring a storage

1. Stop the application. Copy the storage directory **and** the index
   directories together (same point in time).
2. At startup, bind the names to the copied index directories.
3. Start the storage.

A copied vector graph that matches the storage is loaded; one that does not
(another point in time) is rebuilt from the vector file. Copied Lucene files
are used as they are, so always restore them together with the storage.
If the index files are not copied along, nothing is lost: a JVector index
re-vectorizes its entities and rebuilds; a Lucene index rebuilds itself from
the entities on first use (warning logged, map blocked meanwhile).

## Changing the location of an existing index

An existing index keeps the location it was created with; passing another
one to `VectorIndices.ensure(...)` has no effect and logs a warning. Change
it explicitly, then store:

```java
gigaMap.index().get(VectorIndices.class).changeIndexLocation("embeddings", IndexLocation.Named("vectors"));
gigaMap.index().get(LuceneIndex.class).changeIndexLocation(IndexLocation.Named("fulltext"));
gigaMap.store();   // the change reaches the storage with the next store
```

Takes effect from the next start; no files are moved. Refused for in-memory
vector indices with an embedded vectorizer, Lucene indices without an MMap
directory or with a custom `LuceneContext` implementation, and read-only maps.
Exception: an in-memory *computed* vector index without a location yet
moves its temporary vector file to the new location **at once**, without a
vectorizer call.

Migration of an existing storage without a rebuild: call
`changeIndexLocation(..., Named("x"))` + `store()` once; from the next start
bind `"x"` to the directory the index uses today; switch the application's
own setup to `.indexLocation(Named("x"))` so `ensure` stops warning.

## Limits

- Lucene files are not checked for ownership; the JVector manifest check
  detects most mismatches, not all (two copies of one storage with the same
  change count accept each other's graph).
- There is no location relative to the storage directory — bind a name to a
  directory next to the storage instead.
- Older library versions ignore the stored name: a JVector index created
  with a named location rebuilds in memory there and cannot persist; a Lucene
  index at a named location fails every change and query there (loud, not
  stale).
