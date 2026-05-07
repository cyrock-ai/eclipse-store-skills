# Examples-expanded — storing-data

## Example 1 — The "modified object" rule in practice

A customer registry: add, update, rename.

```java
// CustomerService.java
package app;

import java.util.concurrent.locks.ReentrantReadWriteLock;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public CustomerService(EmbeddedStorageManager s, AppRoot r) {
        this.storage = s; this.root = r;
    }

    // ADD: the customers map is what changed
    public void add(Customer c) {
        lock.writeLock().lock();
        try {
            root.customers().put(c.email(), c);
            storage.store(root.customers());
        } finally { lock.writeLock().unlock(); }
    }

    // UPDATE FIELD: the customer is what changed
    public void renameEmail(String oldEmail, String newEmail) {
        lock.writeLock().lock();
        try {
            Customer c = root.customers().remove(oldEmail);
            if (c == null) return;
            c.setEmail(newEmail);
            root.customers().put(newEmail, c);
            // Two things changed: the map and the customer. Store both atomically.
            storage.storeAll(root.customers(), c);
        } finally { lock.writeLock().unlock(); }
    }

    // REPLACE NESTED IMMUTABLE: the customer is what changed (new Address reference)
    public void updateAddress(String email, Address addr) {
        lock.writeLock().lock();
        try {
            Customer c = root.customers().get(email);
            if (c == null) return;
            c.setAddress(addr);
            storage.store(c);
        } finally { lock.writeLock().unlock(); }
    }
}
```

## Example 2 — Manual Storer for multi-object transaction

Place an order: mutate the orders list, mutate the customer's order count, append an
audit entry. All or nothing.

```java
// OrderService.java
package app;

import org.eclipse.serializer.persistence.types.Storer;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class OrderService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;

    public OrderService(EmbeddedStorageManager s, AppRoot r) {
        this.storage = s; this.root = r;
    }

    public void placeOrder(Customer c, Order o) {
        // Mutate in memory
        root.orders().add(o);
        c.incrementOrderCount();
        root.audit().add(new AuditEntry("order.placed", o.id()));

        // Stage as one atomic transaction
        Storer storer = storage.createStorer();
        storer.store(root.orders());
        storer.store(c);
        storer.store(root.audit());
        storer.commit();   // all three land together
    }
}
```

If any `store()` throws before `commit()`, nothing lands. If `commit()` throws, Eclipse
Store reverts any partial write at the next startup.

## Example 3 — BatchStorer ingest loop

Import a stream of events from a file. Don't want to do one disk transaction per event.

```java
// EventImporter.java
package tools;

import java.time.Duration;
import java.util.List;

import org.eclipse.store.storage.embedded.types.BatchStorer;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class EventImporter {

    public static void importAll(List<Event> events, java.nio.file.Path dir) {
        try (EmbeddedStorageManager storage =
                 EmbeddedStorage.start(new EventRoot(), dir)) {

            EventRoot root = (EventRoot) storage.root();

            try (BatchStorer batch = storage.batchStorerBuilder()
                    .maxSize(10_000L)
                    .flushCycle(Duration.ofSeconds(1))
                    .checkInterval(Duration.ofMillis(200))
                    .build()) {

                for (Event e : events) {
                    root.events().add(e);
                    batch.store(root.events());
                }
                batch.commit();   // flush the tail
            }
        }
    }
}
```

**Why `batch.store(root.events())` every iteration?** — Because `events` is the
collection that changed; each call re-serializes its current state. Child objects (the
`Event` instances themselves) are lazy: only new ones get serialized.

If you instead buffered events in a local `ArrayList` and called `batch.store()` once
at the end, that also works and is simpler — but `BatchStorer` is specifically designed
for the per-iteration pattern without the performance cost.

## Example 4 — Eager field evaluator for hidden fields

A third-party class has a private field with no getter, and you want it stored
eagerly.

```java
// HiddenFieldEagerConfig.java
package app.bootstrap;

import org.eclipse.serializer.persistence.types.PersistenceEagerStoringFieldEvaluator;

public class HiddenFieldEagerConfig {

    public static PersistenceEagerStoringFieldEvaluator eagerFor(
            Class<?> owner, String fieldName) {
        return (type, field) ->
            owner.isAssignableFrom(type) && field.getName().equals(fieldName);
    }
}
```

Wire it into the foundation:

```java
EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
    EmbeddedStorageConfiguration.Builder()
        .setStorageDirectory("data")
        .createConfiguration()
)
.onConnectionFoundation(cf -> cf.setReferenceFieldEagerEvaluator(
    HiddenFieldEagerConfig.eagerFor(ForeignObject.class, "hidden")
))
.start(root);
```

Now mutations to `foreignObject.hidden` are picked up when `foreignObject` is stored,
without a dedicated call.

## Example 5 — Registration listener for audit

Track every object persisted in a big transaction.

```java
// AuditingStore.java
package app.audit;

import java.util.Hashtable;
import java.util.Map;

import org.eclipse.serializer.persistence.types.PersistenceObjectRegistrationListener;
import org.eclipse.serializer.persistence.types.Storer;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

public class AuditingStore {

    public static Map<Long, Object> storeWithAudit(
            EmbeddedStorageManager storage, Object... objects) {

        Hashtable<Long, Object> persisted = new Hashtable<>();
        Storer s = storage.createStorer();
        s.registerRegistrationListener((id, obj) -> persisted.put(id, obj));

        for (Object o : objects) s.store(o);
        s.commit();

        return persisted;
    }
}
```

The returned map shows every object (including transitive new references) actually
persisted, with its storage id. Use for migration verification or incident
reconstruction.

## Example 6 — Read/Write lock wrapping

A small library wrapper applying the "mutate + store under same lock" rule with one
call site.

```java
// Transaction.java
package app;

import java.util.concurrent.locks.ReentrantReadWriteLock;

public class Transaction {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public <T> T read(java.util.function.Supplier<T> read) {
        lock.readLock().lock();
        try { return read.get(); } finally { lock.readLock().unlock(); }
    }

    public void write(Runnable mutateAndStore) {
        lock.writeLock().lock();
        try { mutateAndStore.run(); } finally { lock.writeLock().unlock(); }
    }
}
```

Usage:

```java
tx.write(() -> {
    root.customers().put(c.email(), c);
    storage.store(root.customers());
});
```

Both the mutation and the store are guaranteed to happen under the same write lock,
with no reader seeing an intermediate state.

## Example 7 — Lazy walk vs eager walk, visualised

The same scenario stored with a lazy storer and an eager storer side by side.
The graph: `root.customers()` is the explicit argument; Customer A and her
address are already registered (have `objectId`); Customer B was just added
in memory and has no `objectId` yet.

```
                       root.customers()  <-- explicit arg to store(...)
                              |
                  +-----------+-----------+
                  |                       |
              Customer A              Customer B
            (in registry,             (NEW — not in
             objectId=42)              registry)
                  |                       |
              Address                 Address
            (in registry)              (NEW)
```

Storing it three different ways:

```java
// Lazy (the default — convenience methods always behave this way)
storage.store(root.customers());

// Lazy (explicit — same as above)
Storer lazy = storage.createLazyStorer();
lazy.store(root.customers());
lazy.commit();

// Eager (must be explicit — there is no eager convenience method)
Storer eager = storage.createEagerStorer();
eager.store(root.customers());
eager.commit();
```

What gets written:

```
  Lazy walk:
    root.customers()       ALWAYS written (explicit argument)
      \-> Customer A        STOP — already in registry
      \-> Customer B        write B
            \-> Address(B)  write Address(B)

    Bytes written: collection shell + Customer B + Address(B).


  Eager walk:
    root.customers()       ALWAYS written (explicit argument)
      \-> Customer A        re-write A (already in registry, eager descends)
            \-> Address(A)  re-write Address(A)
      \-> Customer B        write B (new)
            \-> Address(B)  write Address(B)

    Bytes written: every reachable object.
```

The same is true if you mutate `Customer A.address().setStreet(...)` in place
before storing: the lazy walk does *not* persist the change (Address A is
skipped), the eager walk does (Address A is re-written as a side effect of
the full traversal).

This is why **the explicit argument is always re-written** is the rule that
matters: it tells you when storing the parent is enough (when the parent
itself or its newly-added children carry the change) and when it isn't (when
an already-registered child's *fields* changed in place).
