# Lucene full-text index — gigamap-lucene

Companion to the SKILL.md Lucene section. Use this when adding analyzer-driven
tokenization, phrase / wildcard / fuzzy / score-ranked search to a GigaMap.
State as of Eclipse Store 4.3.0.

## Maven

`gigamap-lucene` declares the Lucene libraries as `<scope>provided</scope>`,
so the consumer **must** add them explicitly — otherwise `Document`,
`TextField`, `IndexableField`, the `QueryParser`, etc. are missing from
the classpath:

| `groupId` | `artifactId` | `version` |
|---|---|---|
| `org.eclipse.store` | `gigamap-lucene` | `${eclipse-store.version}` |
| `org.apache.lucene` | `lucene-core` | `9.8.0` (what gigamap-lucene 4.3.0 is built against) |
| `org.apache.lucene` | `lucene-queryparser` | `9.8.0` |

Language analyzers (`GermanAnalyzer`, `KeywordAnalyzer`, …) live in
`lucene-analysis-common`; highlighting in `lucene-highlighter`.

## DocumentPopulator + LuceneContext

The populator maps an entity to a Lucene `Document`. `LuceneContext.New(...)`
binds it to a directory and an analyzer:

```java
public class ArticlePopulator extends DocumentPopulator<Article> {
    @Override public void populate(Document doc, Article a) {
        doc.add(createTextField  ("title",   a.title()));     // tokenized
        doc.add(createTextField  ("content", a.content()));
        doc.add(createStringField("sku",     a.sku()));       // exact match
    }
}
```

| Factory | Where the index data lives |
|---|---|
| `LuceneContext.New(populator)` | **Inside the object graph** — persisted with the map on `store()`, no directory to manage. Default choice for small / medium indices. |
| `LuceneContext.New(Path, populator)` | MMap directory on disk (`DirectoryCreator.MMap(path)`); the path is stored with the index. |
| `LuceneContext.New(DirectoryCreator.MMap(IndexLocation.Named("fulltext")), populator)` | MMap directory bound at runtime via `IndexLocations.bind` → `index-locations.md`. |
| `LuceneContext.New(DirectoryCreator.ByteBuffers(), populator)` | In-memory only; rebuilt from the entities after load or `close()`. Tests. |
| `New(directoryCreator, analyzerCreator, populator[, autoCommit])` | Custom `AnalyzerCreator` (subclass, override `createAnalyzer()`), commit behaviour. |

## Register post-build, not on the Builder — restart-safe

Lucene and vector indices are **not** declared on `GigaMap.Builder` — they
register on `map.index()` after the map is built. `register(...)` is
**not idempotent**: after deserialization from storage the category is
already attached and `register(...)` returns `null`. Use the get-or-register
idiom so the same wiring code works on first start and on restart:

```java
GigaMap<Article> articles = GigaMap.New();   // or restored from storage.root()

LuceneIndex<Article> lucene = articles.index().get(LuceneIndex.class);
if (lucene == null) {
    lucene = articles.index().register(LuceneIndex.Category(ctx));
}
```

Registering on a populated map back-fills the index from the existing
entities (all-or-nothing). Annotation form: `@FullText` on fields / getters
plus `IndexerGenerator.AnnotationBased(Article.class)
.register(LuceneAnnotationHandler.New(/* path | IndexLocation | nothing = in-graph */))
.generateIndices(articles)`.

## Lifecycle — closing and reopening

`LuceneIndex extends IndexGroup, Closeable`. An MMap index holds the
directory's `write.lock` while open. **`EmbeddedStorageManager.shutdown()`
closes every index group of every loaded GigaMap**, so a second
`EmbeddedStorage.start(...)` in the same JVM reopens the directory cleanly
without an explicit `luceneIndex.close()`.

Call `close()` yourself only for a map that is not part of a storage, or to
release the directory while the storage keeps running; the index re-opens
lazily on the next call. A `LockObtainFailedException` therefore means two
*storages or JVMs* point at the same directory — one JVM per index directory.

## Querying — list vs. scored vs. callback

```java
List<Article> matches = lucene.query("title:Python");             // id set, no scores
List<Article> top     = lucene.query("title:Python", 20);         // bounded

LuceneSearchResult<Article> hits = lucene.search("content:\"best practices\"", 100);
for (var entry : hits) {                                           // score-descending
    System.out.println(entry.score() + " " + entry.entity().title());
}

lucene.query("name:wireless", (entityId, article, score) -> log(article, score)); // SearchResultAcceptor
```

`query(...)` returns `List<E>`; `search(query[, k])` returns a
`LuceneSearchResult<E>` that carries scores **and** can intersect with bitmap /
vector queries via `.and(...)`. Native `org.apache.lucene.search.Query`
objects (`TermQuery`, `BooleanQuery`, `IntPoint.newRangeQuery`, …) are
accepted by the same overloads. `entityId()` on an entry feeds
`gigaMap.update(entityId, …)` on maps without a bitmap index.

## Query syntax

Standard Lucene:

| Form | Example |
|---|---|
| Field + term | `title:Python` |
| Boolean | `python AND beginner`, `java OR kotlin`, `python NOT 2` |
| Phrase | `"best practices"` |
| Wildcard | `pyth*` (avoid leading wildcards) |
| Fuzzy | `python~`, `python~2` |
| Range | `[2020 TO 2024]` |
| Field-scoped boolean | `title:python AND content:beginner` |

## Sub-query semantics

- `gigaQuery.and(luceneResult)` → intersection by id set, **scores dropped**.
- `luceneResult.and(gigaQuery)` → preserves Lucene ordering + scores.

```java
List<Article> published = articles.query(status.is("PUBLISHED"))
    .and(lucene.search("content:eclipse", 100))
    .toList();
```

## Commits

`autoCommit` (default `true`) commits after every mutation. With an MMap
directory that commits to disk immediately, decoupled from `store()`: a
mutation not followed by a `store()` leaves the on-disk index ahead of the
persisted entities. `autoCommit=false` couples the commit to every
`GigaMap.store()` boundary (store-aligned durability) and to explicit
`luceneIndex.commit()` — use it for bulk imports too:

```java
LuceneContext<Article> ctx = LuceneContext.New(
    DirectoryCreator.MMap(path), AnalyzerCreator.Standard(), new ArticlePopulator(), false);
for (Article a : bulk) articles.add(a);
lucene.commit();          // or let the next articles.store() commit
```

## Backup, moving, repair

- An MMap directory is **not** part of the EclipseStore `storage/`
  directory. Back up the two together, at the same point in time, and
  restore them together. Copied Lucene files are used as they are (no
  ownership check), so never bind one directory to two storages.
- A stored absolute path points a moved / restored storage at the original
  directory. Use `IndexLocation.Named` for anything that will be copied or
  restored (`index-locations.md`); migrate an existing index with
  `lucene.changeIndexLocation(IndexLocation.Named("fulltext"))` + `store()`.
- If the directory holds no index files when a loaded index is first used
  (deleted, not copied along, bound to an empty directory), the index is
  **rebuilt from the GigaMap's entities** inside that first operation (a
  warning is logged; other operations on the map wait).
- A field changed directly (not via `update` / `apply`) is never
  re-populated — searches silently miss it. Repair: `storageManager.store(entity)`
  for the direct change, then `gigaMap.reindex()` (rebuilds every index)
  and `gigaMap.store()`. Do not drop the directory and restart.

## Operational notes

- All Lucene index operations are synchronized on the parent GigaMap.
- The directory must be writable; one JVM per index directory.
- `search(q)` without a limit is bounded by the current map size.
