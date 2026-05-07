# Pitfalls deep-dive — root-and-object-graph

## 1. `storage.root()` returns `null`

**Reproducer.**

```java
EmbeddedStorageManager s = EmbeddedStorage.start(Paths.get("data"));  // no root
Object r = s.root();
System.out.println(r);   // null
```

**Root cause.** No root has ever been set (fresh database), and you did not pass a
custom root to `start`. Both the default-root slot and the custom-root slot are empty.

**Fix.** Either:

- Pass a custom root: `EmbeddedStorage.start(new AppRoot(), dir)` — `root()` now
  returns the AppRoot instance.
- Or set a default root: `s.setRoot(new HashMap<>()); s.storeRoot();`.

## 2. Cast failures at `(AppRoot) storage.root()`

**Reproducer.**

```java
AppRoot r = new AppRoot();
EmbeddedStorageManager s = EmbeddedStorage.start(r, dir);
AppRoot loaded = (AppRoot) s.root();   // works
// later, in a refactor, someone types `AppRootV2` here
AppRootV2 v2 = (AppRootV2) s.root();   // ClassCastException
```

**Root cause.** Casting from `s.root()` couples every caller to the current root type.
The moment you rename, you have to update the cast everywhere.

**Fix.** Keep a single typed reference next to the storage manager (see Example 2 in
`examples-expanded.md`), and have every caller read from that.

## 3. Root loads are slow because the graph is huge

**Reproducer.** `start()` takes 30+ seconds. Thread dumps show the load thread scanning
millions of small entities.

**Root cause.** The root is eagerly walked by default — every object strongly reachable
from the root is loaded at startup.

**Fix.** Wrap large subgraphs in `Lazy<T>`. Typical targets: audit logs, history
tables, attachments, any "append-only" collection that grows unboundedly.

```java
// before
private final List<AuditEntry> audit = new ArrayList<>();

// after
private Lazy<ArrayList<AuditEntry>> audit = Lazy.Reference(new ArrayList<>());

public ArrayList<AuditEntry> audit() { return audit.get(); }   // loaded on first call
```

See the `lazy-loading` skill for the full treatment.

## 4. `storeRoot()` doesn't persist my changes

**Reproducer.**

```java
root.customers().put(c.id(), c);
storage.storeRoot();   // nothing changes on disk for the new customer
```

**Symptom.** Next run shows the new customer missing.

**Root cause.** `storeRoot()` stores **the root object itself** — the top-level
reference. If you only modified a nested collection (`customers`), the root reference
didn't change, so `storeRoot()` is a no-op for your new customer.

**Fix.** Store the modified child:

```java
root.customers().put(c.id(), c);
storage.store(root.customers());
```

"The modified object must be stored" — see `storing-data`.

## 5. Reassigning a collection field loses persistence identity

**Reproducer.**

```java
public class AppRoot {
    private List<Order> orders = new ArrayList<>();  // non-final
    public void reset() { orders = new ArrayList<>(); }
}

root.reset();
storage.storeRoot();
```

**Symptom.** Persistence feels fine — but you've created a second `ArrayList` and
orphaned the first (which was what the persistent graph referenced).

**Root cause.** When you reassign a non-final field, you're creating a new object.
Eclipse Store sees this as a reference change. `storeRoot()` stores the new list; the
old list is now garbage.

**Fix.** If you want to clear in-place: `orders.clear()` + store the list. If you
really want a fresh collection (migration), that's fine — but be aware the next
housekeeping GC will clean up the old one.

## 6. Passing `new AppRoot()` to every `start()` and expecting data to appear on it

**Reproducer.** Code has `EmbeddedStorage.start(new AppRoot(), dir)` inline. Works once.
Then confusion sets in about whether it "remembers" anything.

**Root cause.** Eclipse Store does populate the passed instance. But if every time you
create a *fresh* AppRoot and don't keep a reference to it, you have to read via
`storage.root()`, which brings back the cast pain.

**Fix.** Keep the reference:

```java
AppRoot root = new AppRoot();
EmbeddedStorageManager storage = EmbeddedStorage.start(root, dir);
// `root` is now the loaded-in-place object. Use it directly.
```

## 7. Spring Boot: root class has no public no-arg constructor

**Reproducer.** Adding `integrations-spring-boot3`, setting
`org.eclipse.store.root=app.AppRoot`, starting the app; Spring fails to instantiate.

**Root cause.** Eclipse Store itself does not need a no-arg constructor — it uses
low-level instantiation. **Spring** does need one because the starter instantiates the
root via reflection before handing it to Eclipse Store.

**Fix.** Add a public no-arg constructor to the root class. Covered in `spring-boot`.

## 8. Registering a constant after `.start()`

**Reproducer.**

```java
var s = EmbeddedStorage.start(root, dir);
// trying to register the singleton now
```

**Symptom.** No public API path; developer hacks via reflection or ends up with
duplicate copies of the constant instance after each restart.

**Root cause.** Constant registration must happen at foundation build time.

**Fix.** Use the foundation pattern with the root resolver provider:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf ->
        cf.getRootResolverProvider()
          .registerRoot("AppConstants.SYSTEM_USER", AppConstants.SYSTEM_USER)
    )
    .start(root);
```

## 9. Replacing the root and losing data

**Reproducer.**

```java
s.setRoot(null);
s.storeRoot();
```

**Symptom.** All data becomes unreachable. On the next housekeeping pass it's gone.

**Root cause.** Root is *the* entry point. Setting it to null orphans the entire graph.

**Fix.** Don't do this in normal operation. If you need a clean slate, wipe the data
directory while the manager is stopped — `setRoot(null)` is not a "reset" operation.

## 10. Storing the root from inside a loop that never mutates the root reference

```java
// WRONG (wasteful, not wrong-wrong)
for (Order o : newOrders) {
    root.orders().add(o);
    storage.storeRoot();   // stores the root reference every iteration
}
```

**Symptom.** Slow; disk writes grow linearly with the loop.

**Root cause.** You're storing the root reference (which didn't change) plus the
transitively reachable changed parts. Most of the work is pointless.

**Fix.** Store the modified collection once after the loop:

```java
root.orders().addAll(newOrders);
storage.store(root.orders());
```

Or use a `BatchStorer` — see `storing-data`.
