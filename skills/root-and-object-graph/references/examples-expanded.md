# Examples-expanded — root-and-object-graph

## Example 1 — Realistic `AppRoot`

A fabricated but representative root for a small line-of-business app. Shows final
collection fields, a settings object, lazy-wrapped auditing.

```java
// AppRoot.java
package app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.serializer.reference.Lazy;

public class AppRoot {
    private final Map<String, Customer>       customersById = new HashMap<>();
    private final Map<String, Product>        productsById  = new HashMap<>();
    private final List<Order>                 orders        = new ArrayList<>();

    // Audit history can be huge — wrap in Lazy so it is not loaded at startup.
    private       Lazy<ArrayList<AuditEntry>> auditLog      =
        Lazy.Reference(new ArrayList<>());

    private       AppSettings                 settings      = AppSettings.defaults();

    public Map<String, Customer> customers() { return customersById; }
    public Map<String, Product>  products()  { return productsById; }
    public List<Order>           orders()    { return orders; }
    public ArrayList<AuditEntry> audit()     { return auditLog.get(); }
    public AppSettings           settings()  { return settings; }
    public void setSettings(AppSettings s)   { this.settings = s; }
}
```

Principles on display:

- `customersById`, `productsById`, `orders` are `final` → Eclipse Store mutates the
  existing collection instances on load, keeping external references valid.
- `auditLog` is `Lazy<ArrayList<AuditEntry>>` — not loaded until `.get()`, keeps
  startup fast even when the log grows to millions of entries.
- `settings` is a non-final field: fine because settings are replaced atomically by the
  application (rare), not mutated in place.

## Example 2 — Bootstrap with custom root

```java
// Bootstrap.java
package app;

import java.nio.file.Paths;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public final class Bootstrap {
    public static final AppRoot                 ROOT;
    public static final EmbeddedStorageManager  STORAGE;

    static {
        AppRoot root = new AppRoot();
        STORAGE = EmbeddedStorage.start(root, Paths.get("data"));
        ROOT    = root;   // same instance; Eclipse Store populated its fields in place
    }

    public static void shutdown() { STORAGE.shutdown(); }

    private Bootstrap() {}
}
```

Simple and typed. Any service layer in the app reads `Bootstrap.ROOT`; no casts, no
`storage.root()` calls at call sites.

## Example 3 — Threaded update with per-aggregate locks

Real apps want finer-grained locking than a single JVM monitor. This pattern gives per
aggregate (customers / orders / audit) write locks while keeping reads concurrent.

```java
// OrderService.java
package app;

import java.util.List;
import java.util.concurrent.locks.ReentrantReadWriteLock;

import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class OrderService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public OrderService(EmbeddedStorageManager s, AppRoot r) {
        this.storage = s;
        this.root    = r;
    }

    public void placeOrder(Order order) {
        lock.writeLock().lock();
        try {
            root.orders().add(order);
            storage.store(root.orders());   // store the modified collection
        } finally {
            lock.writeLock().unlock();
        }
    }

    public List<Order> findBy(String customerId) {
        lock.readLock().lock();
        try {
            return root.orders().stream()
                .filter(o -> o.customerId().equals(customerId))
                .toList();
        } finally {
            lock.readLock().unlock();
        }
    }
}
```

## Example 4 — Default-root script

A tool that seeds the database with a small `Map`. Don't use this pattern in real apps.

```java
// Seeder.java
package tools;

import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class Seeder {
    public static void main(String[] args) {
        try (EmbeddedStorageManager s = EmbeddedStorage.start(Paths.get("data"))) {
            if (s.root() == null) {
                Map<String, String> data = new HashMap<>();
                data.put("version", "1.0.0");
                data.put("seeded-at", java.time.Instant.now().toString());
                s.setRoot(data);
                s.storeRoot();
            }
        }
    }
}
```

## Example 5 — Migrating to a new root class

Sometimes you want a clean cutover instead of gradual `legacy-type-mapping`. Works when
you can afford downtime.

```java
// MigrateRoot.java
package ops;

public class MigrateRoot {
    public static void main(String[] args) {
        try (EmbeddedStorageManager s = EmbeddedStorage.start(new AppRootV1(), dir)) {
            AppRootV1 oldRoot = s.root();
            AppRootV2 newRoot = translate(oldRoot);
            s.setRoot(newRoot);
            s.storeRoot();
        }

        // Next boot uses the new root class.
        try (EmbeddedStorageManager s = EmbeddedStorage.start(new AppRootV2(), dir)) {
            AppRootV2 root = s.root();
            System.out.println("Migrated: " + root.describe());
        }
    }

    private static AppRootV2 translate(AppRootV1 src) { /* field-by-field copy */ }
}
```

Caveats:

- The old graph becomes unreachable and will be GC'd on the next housekeeping pass.
- If you want the migration to be non-destructive (keep v1 data until v2 is validated),
  either take a file-system copy of the data directory first, or use
  `legacy-type-mapping` for in-place field mapping.
