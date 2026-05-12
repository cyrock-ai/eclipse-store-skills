---
name: root-and-object-graph
description: >
  Guide Claude on designing and using the root instance of an Eclipse Store database —
  the single entry point for the entire persisted object graph.

  **Apply this skill whenever the persistent object graph is being designed,
  reviewed, or extended** — root class shape, what lives directly on the root,
  splits between sub-aggregates, registration of constants, decisions about
  collections vs. custom container classes. The root decision *is* the
  model-design decision in Eclipse Store: there are no tables, no
  entity-per-class concept — the structure of the root is the structure of the
  database. If you are sketching entities, aggregate roots, or any persistent
  container that will be reachable from `start(root, ...)`, load this skill
  before proposing a structure.

  Also use this skill when the user asks to "set the root", "use a custom root",
  "design a root class", "use defaultRoot vs customRoot", "register constants",
  "load the root", "storeRoot", "entry point to the graph", "what goes in the
  root", or needs help deciding whether to use a bare object, a collection, or
  a dedicated root class, and how to structure the top of the object graph for
  maintainability and performance.
version: 0.2.0
---

# Eclipse Store — Root Instance & Object Graph Design

Every Eclipse Store database has exactly one **root** — a single Java object that is the
persistent entry point to everything else. Design the root well and the rest of the app
is easy; design it poorly and you'll fight the library on every store and load.

## Do NOT use this skill

- Bootstrapping the manager itself → `getting-started`.
- Persisting children of the root → `storing-data`.
- Deferring loading of large subgraphs of the root → `lazy-loading`.
- Renaming a field on the root or splitting it into two → `legacy-type-mapping`.

## Mental model

Eclipse Store does not have tables or collections-per-entity-type as first-class
concepts. It persists an arbitrary Java object graph, but it has to start reading
somewhere — hence the root. Think of the root as a pointer to your entire in-memory data
model.

There is exactly one root reference per database. What differs is *how* you wire it
in:

- **Default root (registered post-start)** — start the storage with no root, then
  `setRoot(o)` + `storeRoot()`. No constructor coupling; you can assign any object.
- **Custom root (passed at start)** — pass your instance into
  `EmbeddedStorage.start(root, …)`. Eclipse Store **fills that instance in place**
  with loaded state. You keep a typed field in your app code and never cast.

Both persist identically; the difference is API ergonomics and lifecycle:

| | Default root | Custom root |
|---|---|---|
| How to register | `setRoot(o)` then `storeRoot()` | Pass to `start(root, …)` |
| Access | `storage.root()` (returns `<R> R`) | Your typed variable |
| When loaded | After `setRoot(...)` (or on next start) | Immediately after `start()`; fields populated in place |
| Typical use | Scripts, tests, "Hello World" | **Real applications** |

**Recommendation**: use a custom root for anything beyond a toy. It avoids casts, lets
your IDE autocomplete, and makes refactoring tractable.

## Core API

Inherited from `org.eclipse.store.storage.types.StorageManager`:

| Method | Purpose |
|---|---|
| `<R> R root()` | The active root, or `null` if none has been set. Generic-typed convenience. |
| `<R> R setRoot(R newRoot)` | Replace the in-memory root reference. Returns the passed `newRoot` for fluent use. **Does not persist** — call `storeRoot()` after. |
| `long storeRoot()` | Persist the registered root. Returns the root's objectId. |
| `<R> R ensureRoot(Supplier<R>)` | If no root is set yet, run the supplier, `setRoot` and `storeRoot`. Otherwise no-op. Default method on `StorageManager`. |

`EmbeddedStorage.start(Object root, …)` registers `root` as the custom root.

## Idiomatic patterns

### Pattern A — Custom root class (the default for real apps)

```java
// AppRoot.java
package app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AppRoot {
    private final Map<String, Customer> customersById = new HashMap<>();
    private final List<Order>           orders        = new ArrayList<>();
    private       Settings              settings      = new Settings();

    public Map<String, Customer> customers() { return customersById; }
    public List<Order>           orders()    { return orders; }
    public Settings              settings()  { return settings; }
    public void setSettings(Settings s)      { this.settings = s; }
}
```

```java
// Bootstrap.java
AppRoot root = new AppRoot();
EmbeddedStorageManager storage = EmbeddedStorage.start(root, Paths.get("data"));

// root fields are now populated from disk in place. Use `root` directly — typed, no cast.
root.customers().put(c.id(), c);
storage.store(root.customers());   // store the modified map, not the root
```

Why this is the right default:

- Adding new top-level aggregates is adding a field — you do not bust existing data,
  because the `legacy-type-mapping` machinery handles added fields.
- Tests can construct an `AppRoot` directly without touching storage.
- Refactors stay type-checked.

### Pattern B — Default root (for quick scripts)

```java
EmbeddedStorageManager s = EmbeddedStorage.start(Paths.get("data"));
if (s.root() == null) {
    s.setRoot(new HashMap<String, String>());
    s.storeRoot();
}
@SuppressWarnings("unchecked")
Map<String, String> data = (Map<String, String>) s.root();
```

Use only for scratch tools. The cast is the tell-tale sign you should have used a custom
root.

### Pattern C — Switching roots (migration)

If you need to replace the root entirely — e.g., you're restructuring the top of the
graph and can afford a cutover — use `setRoot`:

```java
OldRoot oldRoot = storage.root();
NewRoot newRoot = migrate(oldRoot);
storage.setRoot(newRoot);
storage.storeRoot();
```

This leaves the old graph unreachable; it becomes garbage on the next housekeeping pass
(see `housekeeping-and-deletion`). For non-destructive field-level changes prefer
`legacy-type-mapping`.

### Pattern D — Shared mutable data: lock + modify + store under one lock

The rule from the upstream docs is non-negotiable: **modify the graph and call `store()`
under the same lock**. Without this, other threads see partial mutations or the stored
data doesn't match the in-memory graph.

```java
// Application-level lock (any java.util.concurrent lock works)
private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

public void addOrder(Order order) {
    lock.writeLock().lock();
    try {
        root.orders().add(order);
        storage.store(root.orders());
    } finally {
        lock.writeLock().unlock();
    }
}

public Order findOrder(String id) {
    lock.readLock().lock();
    try {
        return root.orders().stream()
            .filter(o -> o.id().equals(id))
            .findFirst().orElse(null);
    } finally {
        lock.readLock().unlock();
    }
}
```

Eclipse Store ships `XThreads.executeSynchronized(Runnable)` as a convenience for a
single JVM-wide monitor — it is correct but coarse; write your own lock for any
production workload.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Root is "just a Map" forever

```java
// WRONG past the tutorial stage
storage.setRoot(new HashMap<String, Object>());
Map<String, Object> root = (Map<String, Object>) storage.root();
root.put("customers", new ArrayList<Customer>());
root.put("orders", new ArrayList<Order>());
```

Casts everywhere, no type safety, painful refactor later. Promote to an `AppRoot`
class; it's ten lines and fixes all of this.

### Anti-pattern 2 — Holding a reference to a field captured before `start()`

```java
// WRONG
AppRoot fresh = new AppRoot();
List<Order> ordersRef = fresh.orders();   // captured before start()
EmbeddedStorageManager s = EmbeddedStorage.start(fresh, dir);
ordersRef.size();                         // still empty; not the loaded list
```

If `AppRoot.orders` is a `final` field that Eclipse Store cannot replace, loading
populates the *existing* list (it mutates the contents). If it is a non-final field,
loading can assign a fresh collection, leaving `ordersRef` pointing to the pre-load
empty one.

**Fix**: always read through the root object after `start()`, never through a field
captured beforehand.

### Anti-pattern 3 — Replacing the root every session

```java
// WRONG
storage.setRoot(new AppRoot());   // clobbers persisted data on storeRoot()
storage.storeRoot();
```

This throws away the persisted graph. Use `setRoot` only during a deliberate migration
(Pattern C) — never as part of normal startup.

### Anti-pattern 4 — Making the root mutable via setters everywhere

```java
// WRONG
public class AppRoot {
    public List<Order> orders;        // public, non-final, settable everywhere
    public Map<String, Customer> c;
}

// elsewhere
root.orders = new ArrayList<>();      // loses identity of the persisted list
storage.storeRoot();                  // now "stores" a brand new list
```

If you reassign a collection field, the old (persisted) collection becomes garbage and a
brand-new collection replaces it. That is almost never what you want. Prefer `final`
fields and mutate the collections, not the references.

### Anti-pattern 5 — Root that grows unboundedly

A 50 GB root loaded in full at every `start()` is a 5-minute startup. If a top-level
collection is expected to grow, wrap it in `Lazy<>` so the children are not loaded
upfront. See `lazy-loading`.

## Pitfalls & gotchas (ranked by frequency of failure)

1. **`storage.root()` returns `null`.** Happens when the database is empty and no root
   has been set yet. In default-root mode the first `setRoot(...)` + `storeRoot()` fixes
   it. In custom-root mode this shouldn't happen — if it does, verify you actually
   passed the root into `start(root, dir)`, not just `start(dir)`.
2. **Cast failures at `(AppRoot) storage.root()`.** Someone is using custom root *and*
   casting from `root()`. Keep your own typed reference (the one you passed to
   `start(...)`) instead.
3. **Root is eagerly loaded, always.** The root object and everything strongly
   referenced from it is traversed at startup. Big means slow startup. Mitigate with
   `Lazy<T>` fields.
4. **Constant instances not round-tripping.** Static final fields referenced by the
   graph need to be registered as constants on the connection foundation before
   `.start()`, or they will be stored by value and create duplicates. Covered in
   `custom-type-handlers` under "persistent constants".
5. **Accidentally orphaning the root.** `setRoot(null)` plus `storeRoot()` clears it.
   The rest of the graph becomes unreachable garbage.
6. **Final vs. non-final collection fields.** Best practice: `private final List<…>
   foo = new ArrayList<>();` — Eclipse Store populates the existing list's contents on
   load. Non-final fields are replaced entirely, which invalidates any external
   references.

## Interactions with other skills

- **`getting-started`** — `EmbeddedStorage.start(root, dir)` is where custom roots are
  registered. This skill picks up once that bootstrap is written.
- **`storing-data`** — storing a child of the root is the common case. `storeRoot()` is
  only right when the root field itself (reference) changed.
- **`lazy-loading`** — the antidote to "root is slow to load". Use `Lazy<>` fields
  inside the root.
- **`legacy-type-mapping`** — adding or renaming fields on the root class is the
  textbook use case for schema-evolution mapping.

## Recipes

**"Should my root be a POJO, a record, or a generated class?"** → Plain class with
mutable collections (typically `final HashMap` / `final ArrayList` fields). Records are
fine for deep leaf types, not for the root (their fields are final and records with
`List` components surprise people at load time). Avoid Lombok on the root — keep the
class manually maintained; it rarely changes.

**"Do I really need a root class, or can I use a `HashMap<String, Object>`?"** → For
anything beyond a one-off tool, write the class. You'll save yourself hours.

**"What's the smallest root for a real app?"** → A class with a few `final` collection
fields and a settings record.

```java
public class AppRoot {
    private final Map<String, User> usersById    = new HashMap<>();
    private final List<AuditEntry>  auditLog     = new ArrayList<>();
    private       AppSettings        settings    = AppSettings.defaults();
    // accessors
}
```

**"Do I need a no-arg constructor on my root?"** → No, Eclipse Store instantiates
objects via reflection without invoking constructors (it uses `sun.misc.Unsafe`-style
allocation). **Exception**: in Spring Boot integration, the root *does* need a public
no-arg constructor because Spring instantiates it. See `spring-boot`.

**"Can the root change type between runs?"** → Only with explicit migration
(`legacy-type-mapping`) or by rebuilding the database.

**"How do I access persisted JVM constants?"** → Register them as named roots on the
connection foundation: `cf.getRootResolverProvider().registerRoot("MY.CONST", instance)`.
The persistence layer associates each constant's stored OID with the live JVM
instance under that identifier. See the Eclipse Store docs on "constant instances" —
this is niche and mostly solved by design-by-not (don't reference JVM constants from
the graph if you can avoid it).

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a `StorageManager` method
  not in the in-line Core API table (e.g. `viewRoots()`), the connection-foundation
  hooks for `registerRoot(...)` / `registerRootSupplier(...)` / `registerRootSuppliers(...)`,
  or the `XThreads.executeSynchronized` Runnable/Supplier overloads.
- **Load `references/examples-expanded.md`** when you want a complete runnable
  template — realistic `AppRoot` with `Lazy<>`-wrapped audit, the canonical
  `Bootstrap` static-initializer pattern, per-aggregate `ReentrantReadWriteLock`
  service, default-root seeder, full-root migration with `setRoot`.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a root-related bug
  — `root()` returns `null`, cast failures, slow startup (eager graph), `storeRoot()`
  not persisting nested mutations, reassigning a collection field, Spring Boot
  no-arg-constructor requirement, registering a constant after `.start()`.

## Upstream sources

- `docs/modules/storage/pages/root-instances.adoc` — authoritative upstream guide.
- `docs/modules/storage/pages/getting-started.adoc` — introduces the default-root +
  custom-root distinction.
- `examples/helloworld/`, `examples/items/` — minimal roots.
