# Examples-expanded — gigamap

## Example 1 — End-to-end: persons with multiple indices

```java
// Person.java
package app;

import java.time.LocalDate;
import java.util.UUID;

public class Person {
    private UUID id; private String firstName; private String lastName;
    private LocalDate birthDate;
    public Person(UUID id, String f, String l, LocalDate b) {
        this.id = id; this.firstName = f; this.lastName = l; this.birthDate = b;
    }
    public UUID id()                { return id; }
    public String firstName()       { return firstName; }
    public String lastName()        { return lastName; }
    public LocalDate birthDate()    { return birthDate; }
    public void setLastName(String l){ this.lastName = l; }
}
```

```java
// PersonIndices.java
package app;

import java.time.LocalDate;
import java.util.UUID;

import org.eclipse.store.gigamap.types.BinaryIndexerUUID;
import org.eclipse.store.gigamap.types.IndexerLocalDate;
import org.eclipse.store.gigamap.types.IndexerString;

public final class PersonIndices {
    public static final BinaryIndexerUUID<Person> id = new BinaryIndexerUUID.Abstract<>() {
        @Override protected UUID getUUID(Person p) { return p.id(); }
    };
    public static final IndexerString<Person> lastName = new IndexerString.Abstract<>() {
        @Override public String getString(Person p) { return p.lastName(); }
    };
    public static final IndexerLocalDate<Person> birthDate = new IndexerLocalDate.Abstract<>() {
        @Override protected LocalDate getLocalDate(Person p) { return p.birthDate(); }
    };
    private PersonIndices() {}
}
```

```java
// AppRoot.java
package app;

import org.eclipse.store.gigamap.types.GigaMap;

public class AppRoot {
    private final GigaMap<Person> people = GigaMap.<Person>Builder()
        .withBitmapIdentityIndex(PersonIndices.id)
        .withBitmapIndex(PersonIndices.lastName)
        .withBitmapIndex(PersonIndices.birthDate)
        .build();
    public GigaMap<Person> people() { return people; }
}
```

```java
// Main.java
package app;

import java.nio.file.Paths;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import org.eclipse.store.gigamap.types.GigaQuery;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class Main {
    public static void main(String[] args) {
        try (EmbeddedStorageManager storage =
                 EmbeddedStorage.start(new AppRoot(), Paths.get("data"))) {

            AppRoot root = (AppRoot) storage.root();
            if (root.people().size() == 0) {
                root.people().add(new Person(
                    UUID.randomUUID(), "Alice", "Smith", LocalDate.of(1990, 1, 1)));
                root.people().add(new Person(
                    UUID.randomUUID(), "Bob", "Jones", LocalDate.of(1985, 6, 15)));
                root.people().store();
            }

            List<Person> smiths = root.people()
                .query(PersonIndices.lastName.is("Smith"))
                .toList();
            smiths.forEach(p -> System.out.println(p.firstName()));

            GigaQuery<Person> adults = root.people().query(
                PersonIndices.birthDate.before(LocalDate.now().minusYears(30)));
            System.out.println("adults: " + adults.count());
        }
    }
}
```

## Example 2 — Updating an entity the right way

```java
Person alice = root.people().query(PersonIndices.lastName.is("Smith"))
    .findFirst().orElseThrow();

root.people().update(alice, p -> {
    p.setLastName("Brown");
});
root.people().store();

// Query reflects the change
boolean stillSmith = root.people().query(PersonIndices.lastName.is("Smith"))
    .findFirst().isPresent();
assert !stillSmith;
```

If you had called `alice.setLastName("Brown")` directly, the `lastName` index
would still point to "Smith" and queries would lie.

## Example 3 — Sub-query: Lucene + bitmap intersection

Assume articles are also indexed by a Lucene content index and a bitmap status
index:

```java
LuceneSearchResult<Article> hits = luceneIndex.search("content:eclipse", 100);

List<Article> publishedHits = articles.query(status.is("PUBLISHED"))
    .and(hits)
    .toList();
```

Or narrow from the scored side (keeps scoring):

```java
ScoredSearchResult<Article> scored = luceneIndex.search("content:eclipse", 100)
    .and(articles.query(status.is("PUBLISHED")));

for (var entry : scored) {
    System.out.println(entry.score() + " " + entry.entity().title());
}
```

## Example 4 — Multi-value: tag search

```java
public static final IndexerMultiValue<Article, String> tags =
    new IndexerMultiValue.Abstract<>() {
        @Override public Collection<String> get(Article a) { return a.tags(); }
    };

// Has tag "java"
articles.query(tags.is("java"));

// Has any of [java, eclipse, jvm]
articles.query(tags.in("java", "eclipse", "jvm"));

// Has ALL of [java, eclipse]
articles.query(tags.all("java", "eclipse"));
```

## Example 5 — Iterating with try-with-resources

```java
try (var it = root.people().query(PersonIndices.lastName.is("Smith")).iterator()) {
    while (it.hasNext()) {
        Person p = it.next();
        process(p);
    }
}
// read lock released here
```

## Example 6 — Range query with combined filter

```java
articles.query(
    tags.is("java")
      .and(publishedAt.between(
          LocalDate.of(2025, 1, 1),
          LocalDate.of(2025, 12, 31)))
);
```

## Example 7 — Writing concurrently

GigaMap is internally thread-safe for its own CRUD. Multiple threads can add
simultaneously. But `store()` should not overlap with pending writes in other
threads unless you carefully manage state. Simplest pattern:

```java
// Per-thread writes
executor.submit(() -> {
    root.people().add(new Person(...));
});

// Periodically, on a single thread
root.people().store();
```

The `store()` call acquires the GigaMap's internal lock and blocks concurrent
mutations.

## Example 8 — Deletion

```java
Person toRemove = root.people().query(PersonIndices.lastName.is("Jones"))
    .findFirst().orElseThrow();

root.people().remove(toRemove);
root.people().store();
```

Unlike plain storage, you call `remove` on the GigaMap, not "remove reference
from collection" — GigaMap owns the collection semantics.

## Example 9 — Vector search: end-to-end with embedded mode

Document with its embedding stored on the entity (e.g. you batch-computed
vectors at ingest time). Embedded mode avoids duplicate storage.

```java
public record Doc(String id, String title, String text, float[] embedding) {}

public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) { return d.embedding(); }
    @Override public boolean isEmbedded()     { return true; }
}

public final class DocIndices {
    public static final IndexerString<Doc> id = new IndexerString.Abstract<>() {
        @Override public String getString(Doc d) { return d.id(); }
    };
    public static final IndexerString<Doc> title = new IndexerString.Abstract<>() {
        @Override public String getString(Doc d) { return d.title(); }
    };
    private DocIndices() {}
}

public class AppRoot {
    private final GigaMap<Doc> docs = GigaMap.<Doc>Builder()
        .withBitmapIdentityIndex(DocIndices.id)
        .withBitmapIndex(DocIndices.title)
        .build();
    public GigaMap<Doc> docs() { return docs; }
}

public static void main(String[] args) {
    AppRoot root = new AppRoot();
    try (EmbeddedStorageManager storage =
             EmbeddedStorage.start(root, Paths.get("data"))) {

        GigaMap<Doc> docs = root.docs();

        // Restart-safe — register() returns null if the category is already attached.
        VectorIndices<Doc> indices = docs.index().get(VectorIndices.class);
        if (indices == null) indices = docs.index().register(VectorIndices.Category());

        VectorIndexConfiguration cfg = VectorIndexConfiguration
            .forMediumDataset(768);

        VectorIndex<Doc> embeddings = indices.ensure("embeddings", cfg, new DocVectorizer());

        if (docs.size() == 0) {
            docs.add(new Doc("d1", "Eclipse Store overview", "...", embed("...")));
            docs.add(new Doc("d2", "JVector internals",      "...", embed("...")));
            docs.add(new Doc("d3", "Cooking pasta",          "...", embed("...")));
            docs.store();
        }

        VectorSearchResult<Doc> top =
            embeddings.search(embed("How does the persistent vector index work?"), 5);
        for (var entry : top) {
            System.out.printf("%.3f  %s%n", entry.score(), entry.entity().title());
        }

        try { embeddings.close(); } catch (IOException ignore) {}   // close before storage.close()
    }
}

static float[] embed(String text) { /* call your embedding model */ }
```

Run with `--add-modules jdk.incubator.vector` for SIMD acceleration.

## Example 10 — On-disk + PQ for a 5M-vector corpus

Production-grade preset: on-disk graph, PQ compression, background persist
and optimize. Ideal for a > RAM corpus where you want bounded memory and
durable index files.

```java
VectorIndexConfiguration cfg = VectorIndexConfiguration
    .builderForLargeDataset(768, Path.of("data/vectors"))
    .similarityFunction(VectorSimilarityFunction.COSINE)
    .enablePqCompression(true)        // forces maxDegree = 32
    .pqSubspaces(192)                 // must divide 768 evenly
    .persistenceIntervalMs(30_000)
    .minChangesBetweenPersists(500)
    .optimizationIntervalMs(120_000)
    .minChangesBetweenOptimizations(5_000)
    .persistOnShutdown(true)
    .build();

VectorIndex<Doc> embeddings = vectorIndices.ensure("embeddings", cfg, new DocVectorizer());
```

The on-disk graph file `data/vectors/embeddings.graph` plus the
`embeddings.meta` sidecar reload automatically on the next startup. If a
mismatch is detected (older format version, count collision after restart),
the index silently rebuilds from `vectorStore`.

## Example 11 — Sub-query: vector + bitmap + Lucene intersection

"Top-10 documents semantically similar to *X*, restricted to category=tech,
that also match a Lucene phrase query."

```java
VectorSearchResult<Doc> vecHits  = embeddings.search(queryVec, 100);
LuceneSearchResult<Doc> textHits = lucene.search("\"distributed systems\"", 200);

List<Doc> finalHits = docs.query(category.is("tech"))
    .and(vecHits)
    .and(textHits)
    .toList();
```

To preserve vector ranking, invert the chain so the scored side drives:

```java
ScoredSearchResult<Doc> scored = embeddings.search(queryVec, 100)
    .and(docs.query(category.is("tech")))
    .and(textHits);

for (var entry : scored) {
    System.out.printf("%.3f  %s%n", entry.score(), entry.entity().title());
}
```

The two forms differ only in what's preserved — the **id intersection** is
identical.

## Example 12 — "More like this" recommendations

`VectorIndex.search(E queryEntity, int k)` is a convenience overload that
vectorizes the entity and runs the search:

```java
Doc seed = docs.query(DocIndices.id.is("d42")).findFirst().orElseThrow();
VectorSearchResult<Doc> similar = embeddings.search(seed, 10);

similar.stream()
    .filter(e -> !e.entity().id().equals(seed.id()))   // drop the seed itself
    .limit(9)
    .forEach(e -> System.out.println(e.entity().title()));
```

Useful for product recommendations, related articles, deduplication
candidates, etc.

## Example 13 — Computed mode: vectorize via an external API

When vectors come from an external embedding service, set
`isEmbedded() == false` (the default) so vectors are persisted in an
internal `GigaMap<VectorEntry>`. They survive restarts without re-calling
the API.

```java
public class OpenAIVectorizer extends Vectorizer<Article> {
    private final OpenAIClient client;

    public OpenAIVectorizer(OpenAIClient client) { this.client = client; }

    @Override
    public float[] vectorize(Article a) {
        return client.embed(a.text());
    }

    @Override
    public List<float[]> vectorizeAll(List<? extends Article> articles) {
        // Single batch call — much cheaper than N round-trips.
        return client.embedBatch(articles.stream().map(Article::text).toList());
    }

    // isEmbedded() defaults to false → vectors are persisted in vectorStore
}
```

`vectorize()` is called once per `add()`. `vectorizeAll()` kicks in on
batch paths (`addAll`, internal training-data collection, full graph
rebuilds). The vectorizer **must be thread-safe** — the build-time graph
constructor invokes it from worker threads.
