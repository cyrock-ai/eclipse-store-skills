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
