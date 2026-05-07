# Examples-expanded — lazy-loading

## Example 1 — Canonical per-year lazy list

The scenario from the upstream docs: 20 years × 1 M turnovers each. Only load the
current year's list.

```java
// BusinessYear.java
package app;

import java.util.ArrayList;
import org.eclipse.serializer.reference.Lazy;

public class BusinessYear {
    private final int year;
    private final Lazy<ArrayList<Turnover>> turnovers = Lazy.Reference(new ArrayList<>());

    public BusinessYear(int year) { this.year = year; }
    public int year() { return year; }
    public ArrayList<Turnover> turnovers() { return Lazy.get(this.turnovers); }
    public Lazy<ArrayList<Turnover>> turnoversLazy() { return this.turnovers; }
}
```

```java
// AppRoot.java
public class AppRoot {
    private final java.util.HashMap<Integer, BusinessYear> years = new java.util.HashMap<>();
    public java.util.HashMap<Integer, BusinessYear> years() { return years; }
}
```

Startup reads the root and the `years` map (small). Only when you call
`year.turnovers()` is the year's list of turnovers loaded.

Storing a new turnover:

```java
BusinessYear y = root.years().get(2026);
y.turnovers().add(new Turnover(...));
storage.store(y.turnovers());   // store the INNER collection, not the Lazy wrapper
```

## Example 2 — Null-safe access and initialization

Some business years may not have any data yet.

```java
public class BusinessYear {
    private Lazy<ArrayList<Turnover>> turnovers;   // nullable

    public ArrayList<Turnover> turnovers() {
        return Lazy.get(this.turnovers);           // null-safe: returns null if Lazy is null
    }

    public void initializeIfMissing() {
        if (this.turnovers == null) {
            this.turnovers = Lazy.Reference(new ArrayList<>());
        }
    }
}
```

Pair with storing:

```java
y.initializeIfMissing();
y.turnovers().add(t);
storage.store(y.turnovers());      // store the list
storage.store(y);                  // and the year, which now references the Lazy
```

## Example 3 — Custom `LazyReferenceManager`

Interactive app that keeps subgraphs loaded for 2 hours of inactivity, and aggressively
releases above 80% heap:

```java
// ReferenceManagerBootstrap.java
package app.bootstrap;

import java.time.Duration;
import org.eclipse.serializer.reference.Lazy;
import org.eclipse.serializer.reference.LazyReferenceManager;

public final class ReferenceManagerBootstrap {
    public static void install() {
        LazyReferenceManager.set(LazyReferenceManager.New(
            Lazy.Checker(
                Duration.ofHours(2).toMillis(),
                0.80
            )
        ));
    }
    private ReferenceManagerBootstrap() {}
}
```

Call `ReferenceManagerBootstrap.install()` **before** `EmbeddedStorage.start(...)`.

## Example 4 — `LazyArrayList` ingest

Importing 10 million events into a single collection. With a plain `ArrayList`, the
first access loads all 10 M into memory. `LazyArrayList` keeps segments on disk.

```java
// EventIngest.java
package tools;

import java.time.Duration;
import java.util.List;
import org.eclipse.serializer.collections.lazy.LazyArrayList;
import org.eclipse.serializer.persistence.types.BatchStorer;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class EventIngest {

    public static void ingest(List<Event> source, java.nio.file.Path dir) {
        EventRoot root = new EventRoot();   // contains LazyArrayList<Event> events
        try (EmbeddedStorageManager storage = EmbeddedStorage.start(root, dir)) {

            try (BatchStorer batch = storage.batchStorerBuilder()
                    .maxSize(5_000L)
                    .flushCycle(Duration.ofSeconds(1))
                    .build()) {
                for (Event e : source) {
                    root.events().add(e);       // LazyArrayList — adds to the active segment
                    batch.store(root.events()); // persists dirty segments, not the whole list
                }
                batch.commit();
            }
        }
    }
}
```

Note: `LazyArrayList.size()` is cached; `root.events().size()` is free and does not
force loads.

## Example 5 — Iterate with explicit clearing

A report scanner that walks every business year once, then releases each.

```java
// Scanner.java
package reports;

import java.util.List;

import app.AppRoot;
import app.BusinessYear;

public class Scanner {
    public Report scan(AppRoot root) {
        Report r = new Report();
        for (BusinessYear y : root.years().values()) {
            List<app.Turnover> ts = y.turnovers();   // loads
            ts.forEach(r::accumulate);
            y.turnoversLazy().clear();               // drops the hard ref
        }
        return r;
    }
}
```

`.clear()` doesn't immediately free memory — the JVM GC does that when it needs to.
Under memory pressure, cleared Lazy references are first in line for reclamation.

## Example 6 — Lazy over an already-large Map, done wrong and right

**Wrong** — wrapping a `HashMap` with 10 million entries in `Lazy<>`:

```java
private Lazy<HashMap<String, Customer>> customers = Lazy.Reference(new HashMap<>());
```

On first `.get()`, the entire 10 M entry map loads. Lazy doesn't help here.

**Right** — use `LazyHashMap`:

```java
private final LazyHashMap<String, Customer> customers = new LazyHashMap<>();
public LazyHashMap<String, Customer> customers() { return customers; }
```

Now `customers.get("alice@acme.com")` loads only a segment (`log2(n)` segments worst
case).

## Example 7 — Testing Lazy-wrapped domain

For deterministic tests: install a no-op `LazyReferenceManager` so the background
daemon does not race your assertions.

```java
// TestSetup.java (JUnit 5)
import org.junit.jupiter.api.BeforeAll;
import org.eclipse.serializer.reference.Lazy;
import org.eclipse.serializer.reference.LazyReferenceManager;

public class TestSetup {
    @BeforeAll
    static void disableAutoClear() {
        LazyReferenceManager.set(LazyReferenceManager.New(
            // Long enough to never fire in a test run
            Lazy.Checker(Long.MAX_VALUE)
        ));
    }
}
```

Or explicitly clear Lazy references in assertions:

```java
@Test
void lazyReloadsAfterClear() {
    // ... setup ...
    BusinessYear y = root.years().get(2026);
    y.turnovers().add(new Turnover(...));
    storage.store(y.turnovers());

    y.turnoversLazy().clear();
    assertFalse(y.turnoversLazy().isLoaded());

    var reloaded = y.turnovers();
    assertEquals(1, reloaded.size());
    assertTrue(y.turnoversLazy().isLoaded());
}
```
