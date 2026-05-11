# Lucene full-text index — gigamap-lucene

Companion to the SKILL.md Lucene section. Use this when adding analyzer-driven
tokenization, phrase / wildcard / fuzzy / score-ranked search to a GigaMap.

## Maven

`gigamap-lucene` declares the Lucene libraries as `<scope>provided</scope>`,
so the consumer **must** add them explicitly — otherwise `Document`,
`TextField`, `IndexableField`, the `QueryParser`, etc. are missing from
the classpath:

| `groupId` | `artifactId` | `version` |
|---|---|---|
| `org.eclipse.store` | `gigamap-lucene` | `${eclipse-store.version}` |
| `org.apache.lucene` | `lucene-core` | `9.8.0` (match what gigamap-lucene was built against) |
| `org.apache.lucene` | `lucene-queryparser` | `9.8.0` |

## DocumentPopulator + LuceneContext

The populator maps an entity to a Lucene `Document`. `LuceneContext.New(...)`
binds a populator to an on-disk index directory.

```java
public class ArticlePopulator extends DocumentPopulator<Article> {
    @Override public void populate(Document doc, Article a) {
        doc.add(createTextField("title",   a.title()));
        doc.add(createTextField("content", a.content()));
    }
}

LuceneContext<Article> ctx = LuceneContext.New(
    Paths.get("lucene-index"), new ArticlePopulator());
```

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

articles.add(new Article("Python Guide", "…"));
```

## Lifecycle — `LuceneIndex` is `Closeable`

`LuceneIndex extends IndexGroup, Closeable`. It owns the on-disk Lucene
directory, including a `write.lock` file held for the JVM's lifetime.

**`EmbeddedStorageManager.close()` does NOT cascade to `LuceneIndex.close()`.**
On a second `EmbeddedStorage.start(...)` in the same JVM, opening the
Lucene directory again throws:

```
org.apache.lucene.store.LockObtainFailedException:
    Lock held by this virtual machine
```

Required close order before reopening storage:

```java
try { luceneIndex.close(); } catch (IOException ignore) {}
storage.close();
```

`LuceneIndex` re-opens lazily on the next call after `close()`, so the
get-or-register wiring above works cleanly on restart.

## Querying — list vs. scored

```java
// List result — id set, no scores
List<Article> matches = lucene.query("title:Python");

// Scored, sub-query-able
LuceneSearchResult<Article> hits = lucene.search("content:\"best practices\"", 100);
```

`lucene.query(...)` returns `List<E>` directly. `lucene.search(query, k)`
returns a `LuceneSearchResult<E>` that carries scores **and** can intersect
with bitmap / vector queries via `.and(...)`.

## Query syntax

Standard Lucene:

| Form | Example |
|---|---|
| Field + term | `title:Python` |
| Boolean | `python AND beginner`, `java OR kotlin`, `python NOT 2` |
| Phrase | `"best practices"` |
| Wildcard | `pyth*` |
| Fuzzy | `python~`, `python~2` |
| Range | `[2020 TO 2024]` |
| Field-scoped boolean | `title:python AND content:beginner` |

## Sub-query semantics

`LuceneSearchResult<E>` is a `SubQuery`, so it composes with bitmap and
vector queries. Score handling mirrors vector sub-queries:

- `gigaQuery.and(luceneResult)` → intersection by id set, **scores dropped**.
- `luceneResult.and(gigaQuery)` → preserves Lucene ordering + scores.

```java
// Intersect bitmap + Lucene; drops score
List<Article> published = articles.query(status.is("PUBLISHED"))
    .and(lucene.search("content:eclipse", 100))
    .toList();
```

## Backup

The Lucene index directory (the `Paths.get("lucene-index")` you passed to
`LuceneContext.New`) is **owned by Lucene, not by Eclipse Store**. It does
**not** ride along with the EclipseStore `storage/` directory backup.
Configure it as part of the application's backup plan separately.

## Operational notes

- The directory must be writable; Lucene maintains lock files there.
- Concurrent processes pointing at the same directory will fight over the
  lock. One JVM per index directory.
- Reindex from scratch: drop the directory, restart, re-add entities — the
  populator is invoked on each `gigaMap.add(...)`.
