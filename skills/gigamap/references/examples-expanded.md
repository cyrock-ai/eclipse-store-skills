# Examples-expanded — gigamap

Verified against Eclipse Store 4.3.0.

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
        @Override protected String getString(Person p) { return p.lastName(); }
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
would still point to "Smith" and queries would lie. A later `update` does not
repair that — only `reindex()` does:

```java
storage.store(alice);          // persist the direct change (GigaMap did not track it)
root.people().reindex();       // rebuild every index from the current entity state
root.people().store();
```

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
    new IndexerMultiValue.Abstract<Article, String>() {
        @Override public Iterable<String> indexEntityMultiValue(Article a) { return a.tags(); }
        @Override public Class<String>    keyType()                        { return String.class; }
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

## Example 6 — Registering an index on a populated map

```java
// A new index for existing data: back-filled from every entity, all-or-nothing
IndexerString<Person> firstName = new IndexerString.Abstract<>() {
    @Override public String name() { return "person.firstName"; }   // stable persisted name
    @Override protected String getString(Person p) { return p.firstName(); }
};
root.people().index().bitmap().ensure(firstName);   // no-op on the next start
root.people().store();

root.people().query(firstName.startsWith("Al")).toList();
```

## Example 7 — One commit across several maps

`store()` is one commit per map. For a change spanning two maps and the
root, register through the maps into one `Storer`:

```java
Storer storer = storage.createStorer();
root.people().store(storer);
root.orders().store(storer);
storer.store(root);
storer.commit();            // all-or-nothing
```

## Example 8 — Vector search: end-to-end with embedded mode

Document with its embedding stored on the entity (e.g. you batch-computed
vectors at ingest time). Requires Java 25+ and the JVM flags
`--add-modules jdk.incubator.vector --enable-native-access=ALL-UNNAMED`.

```java
public record Doc(String id, String title, String text, float[] embedding) {}

public class DocVectorizer extends Vectorizer<Doc> {
    @Override public float[] vectorize(Doc d) { return d.embedding(); }
    @Override public boolean isEmbedded()     { return true; }
}

public final class DocIndices {
    public static final IndexerString<Doc> id = new IndexerString.Abstract<>() {
        @Override protected String getString(Doc d) { return d.id(); }
    };
    public static final IndexerString<Doc> title = new IndexerString.Abstract<>() {
        @Override protected String getString(Doc d) { return d.title(); }
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
            .forMediumDataset(768);                 // in-memory; embedded vectors are re-read at each start

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
    }   // storage shutdown closes the vector index; no explicit close()
}

static float[] embed(String text) { /* call your embedding model */ }
```

## Example 9 — On-disk index for a 5M-vector corpus

Production-grade preset: on-disk segments, background persistence, named
location so the storage can be moved. Ideal for a > RAM corpus.

```java
IndexLocations.bind("vectors", Path.of("/data/app/vector-index"));   // before storage start

VectorIndexConfiguration cfg = VectorIndexConfiguration
    .builderForLargeDataset(768, Path.of("unused"))                 // preset values: maxDegree 32, beamWidth 300
    .indexLocation(IndexLocation.Named("vectors"))                  // overrides the directory
    .similarityFunction(VectorSimilarityFunction.COSINE)
    .approximateScoring(ApproximateScoring.NONE)                    // FUSED_PQ only if the graph exceeds the page cache
    .vectorStorage(VectorStorage.NVQ)                               // ~3x smaller segments, exact scores
    .parallelOnDiskWrite(true)                                      // absorbs the NVQ encode cost
    .persistenceIntervalMs(30_000)
    .minChangesBetweenPersists(500)
    .flushThreshold(100_000)                                        // segment size; keep it large
    .persistOnShutdown(true)
    .build();

VectorIndex<Doc> embeddings = vectorIndices.ensure("embeddings", cfg, new DocVectorizer());
```

The directory then holds `embeddings.manifest`, `embeddings.seg-{n}.graph`
/ `.l2g` and the vector file `embeddings.vec` + `embeddings.vec-{n}`. A
manifest that does not match the stored index is rejected and the graph is
rebuilt from the vector file. Back up the directory together with the storage.

## Example 10 — Sub-query: vector + bitmap + Lucene intersection

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

## Example 11 — "More like this" recommendations

```java
Doc seed = docs.query(DocIndices.id.is("d42")).findFirst().orElseThrow();
VectorSearchResult<Doc> similar = embeddings.search(seed, 10);   // vectorizes the entity
similar.stream()
    .filter(e -> !e.entity().id().equals(seed.id()))              // drop the seed itself
    .limit(9)
    .forEach(e -> System.out.println(e.entity().title()));
```

## Example 12 — Computed mode: vectorize via an external API

When vectors come from an external embedding service, keep the default
`isEmbedded() == false`. The vectors are **not** persisted in the storage —
they live in the index's vector file, so give the index a directory or
named location; otherwise every start calls the service once per entity.
The vectorizer instance itself is persisted with the index: keep the
configuration in fields and the client `transient`.

```java
public class OpenAIVectorizer extends Vectorizer<Article> {
    private final String model;
    private transient OpenAIClient client;              // recreated after load

    public OpenAIVectorizer(String model) { this.model = model; }

    private OpenAIClient client() {
        if (client == null) client = OpenAIClient.forModel(model);
        return client;
    }

    @Override
    public float[] vectorize(Article a) {
        return client().embed(a.text());                // must be deterministic per persisted entity
    }

    @Override
    public List<float[]> vectorizeAll(List<? extends Article> articles) {
        // Single batch call — much cheaper than N round-trips. Same size, same order.
        return client().embedBatch(articles.stream().map(Article::text).toList());
    }

    @Override
    public long vectorKey(Article a) {
        return a.textVersion();                         // unchanged key → vectorize() is skipped on update
    }
}

VectorIndexConfiguration cfg = VectorIndexConfiguration
    .builderForMediumDataset(1536)
    .indexDirectory(Path.of("data/vectors"))            // keeps the vector file across restarts
    .build();
VectorIndex<Article> embeddings = indices.ensure("embeddings", cfg, new OpenAIVectorizer("text-embedding-3-small"));
```

`vectorizeAll()` serves `addAll`, back-fills and vector-file rebuilds. Change
the text only through `articles.update(a, x -> x.setText(...))`.
