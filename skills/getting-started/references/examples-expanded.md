# Examples-expanded — getting-started

Three complete, runnable bootstraps for common scenarios. Each is copy-paste deployable
into a fresh Maven module with the `storage-embedded` dependency.

## Example 1 — Minimal app

Two classes, local `./data` directory, crash-safe.

```java
// DataRoot.java
package app;

import java.util.ArrayList;
import java.util.List;

public class DataRoot {
    private final List<String> entries = new ArrayList<>();
    public List<String> entries() { return entries; }
}
```

```java
// Main.java
package app;

import java.nio.file.Paths;
import java.time.Instant;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class Main {
    public static void main(String[] args) {
        DataRoot root = new DataRoot();
        EmbeddedStorageManager storage =
            EmbeddedStorage.start(root, Paths.get("data"));

        System.out.println("Loaded " + root.entries().size() + " entries");

        root.entries().add("entry at " + Instant.now());
        storage.store(root.entries());   // store the modified list, not root

        // shutdown optional — skip for prod, call for tests/tools
    }
}
```

Run it twice. The first run prints `Loaded 0 entries`; the second prints `Loaded 1
entries` and then adds a second. No other setup required.

## Example 2 — Foundation with explicit configuration

Use this when you need to set the channel count, change directories, or register a
custom type handler.

```java
package app;

import java.nio.file.Paths;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageFoundation;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration;

public class FoundationBootstrap {
    public static EmbeddedStorageManager start(DataRoot root) {
        EmbeddedStorageFoundation<?> foundation = EmbeddedStorageConfiguration.Builder()
            .setStorageDirectory(Paths.get("data").toString())
            .setChannelCount(4)                          // 4 parallel I/O channels
            .setBackupDirectory("backup")                // continuous backup target
            .setDeletionDirectory("deletion")            // where deleted files go
            .createEmbeddedStorageFoundation();

        // Register a custom type handler before start, if needed:
        // foundation.onConnectionFoundation(cf ->
        //     cf.registerCustomTypeHandler(new MyCustomHandler()));

        return foundation.start(root);
    }
}
```

**Channel count rules of thumb**: 1 for the default case, 2-4 for workloads with heavy
parallel writes. More channels ≠ more throughput past a point; they add file handles and
lock coordination. See the `configuration` skill.

## Example 3 — Two databases in one JVM

Each database gets its own directory, its own root, its own manager. Independent
lifecycles, no contention.

```java
package app;

import java.nio.file.Paths;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class MultiDb {
    public static void main(String[] args) {
        EmbeddedStorageManager orders =
            EmbeddedStorage.start(new OrdersRoot(), Paths.get("data/orders"));
        EmbeddedStorageManager inventory =
            EmbeddedStorage.start(new InventoryRoot(), Paths.get("data/inventory"));

        // Two fully independent databases. No JVM-wide registry ties them together.

        // Shut them down in reverse order if you need explicit shutdown.
        inventory.shutdown();
        orders.shutdown();
    }

    static class OrdersRoot     { /* … */ }
    static class InventoryRoot  { /* … */ }
}
```

**Common mistake**: pointing both at the same `data/` directory. The second `.start()`
will throw because the first holds the storage lock.

## Example 4 — JUnit test pattern

Try-with-resources is the idiom for tests so the managing threads exit promptly and the
test runner can clean up the data directory.

```java
package app;

import java.nio.file.Path;
import java.nio.file.Paths;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;

public class RootRoundtripTest {

    @Test
    void persistedRootReloadsWithSameContent(@TempDir Path dir) {
        try (EmbeddedStorageManager s = EmbeddedStorage.start(new DataRoot(), dir)) {
            DataRoot root = (DataRoot) s.root();
            root.entries().add("a");
            s.store(root.entries());
        }

        try (EmbeddedStorageManager s = EmbeddedStorage.start(new DataRoot(), dir)) {
            DataRoot root = (DataRoot) s.root();
            assertEquals(1, root.entries().size());
            assertEquals("a", root.entries().get(0));
        }
    }
}
```

Key points:

- `@TempDir` gives JUnit ownership of cleanup.
- Each try-with-resources block is a complete database lifecycle.
- The second block's `new DataRoot()` is a *throwaway placeholder* — Eclipse Store
  populates its fields from the persisted graph on load.

## Example 5 — Graceful shutdown via a JVM hook (when you really need it)

Normally you do not. But if the user insists — e.g., they have a background scheduler
that must flush final state outside any `store()` call — this is the safe form:

```java
EmbeddedStorageManager storage = EmbeddedStorage.start(root, Paths.get("data"));

Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    try {
        storage.shutdown();
    } catch (Throwable t) {
        // log and swallow; shutdown hook must not throw
    }
}, "eclipse-store-shutdown"));
```

Caveat: shutdown hooks run after `System.exit(0)` is already underway. If the managing
threads were already torn down by that point, `shutdown()` is a no-op. This pattern is
for niche cases, not the default.
