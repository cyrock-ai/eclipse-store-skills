# API catalogue — root-and-object-graph

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## Root-related methods (declared on `StorageManager`, inherited by `EmbeddedStorageManager`)

File: `storage/storage/src/main/java/org/eclipse/store/storage/types/StorageManager.java`

| Method | Return | Purpose |
|---|---|---|
| `<R> R root()` | the root, or `null` | The active root reference. Generic convenience cast — no `Object` ceremony at the call site. |
| `<R> R setRoot(R newRoot)` | the passed `newRoot` | Replace the in-memory root reference. Returns `newRoot` for fluent chaining. Does **not** persist — call `storeRoot()` after. |
| `long storeRoot()` | the root's objectId | Persists the registered root. |
| `<R> R ensureRoot(Supplier<R>)` | the (eventual) root | Default method. If no root is set yet, supplies one, calls `setRoot` and `storeRoot`. Otherwise returns the existing root unchanged. Throws `IllegalArgumentException` if the supplier returns `null` on the init branch. |
| `PersistenceRootsView viewRoots()` | a read-only view | Iterates all technical root entries (custom/default/constants). Niche — for tooling and advanced migrations. |

There is no `defaultRoot()` / `customRoot()` accessor on the current public API; the
distinction between the two is internal (different identifiers in the type
dictionary, different refactoring registration paths). Always read via `root()`.

## Connection-foundation hooks (advanced)

File: `persistence/.../PersistenceRootResolverProvider.java`

When you need to intercept root registration beyond the basic default/custom split
(e.g., to register JVM-static constants), use the connection foundation on the
embedded-storage foundation:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> {
        cf.getRootResolverProvider()
          .registerRootSupplier(() -> myCustomRoot)   // no-arg variant uses the
                                                      // default root identifier
          .registerRoot("auxKey", auxObject);          // additional named root
    });
```

Relevant types (all in `serializer/persistence/persistence/...`):

| Interface | File | Purpose |
|---|---|---|
| `PersistenceRootResolverProvider` | `persistence/types/PersistenceRootResolverProvider.java` | Registers roots, aux entries, constants. |
| `PersistenceRootResolver` | `persistence/types/PersistenceRootResolver.java` | Resolves an identifier → object during load. |
| `PersistenceRootReference` | `persistence/types/PersistenceRootReference.java` | The reference wrapper used for root slots. |

Available registration methods on `PersistenceRootResolverProvider`:

| Method | Purpose |
|---|---|
| `registerRoot(String identifier, Object instance)` | Register a fixed instance under a named root identifier. |
| `registerRootSupplier(Supplier<?>)` | Register a default-identifier root constructed lazily by the supplier. |
| `registerRootSupplier(String identifier, Supplier<?>)` | Same with explicit identifier. |
| `registerRootSuppliers(XGettingTable<String, Supplier<?>>)` | Bulk variant. |

Note: in 99% of applications the `setRoot` / `customRoot` story is all you need. The
foundation-level root resolver is for libraries that layer on top of Eclipse Store.

## Typing and the root

`root()` is declared `<R> R root()` so a typed assignment compiles without an
explicit cast (the unchecked warning at the call site is the cost). To avoid even
the warning:

- Use **custom root** (Pattern A in SKILL.md) — keep your own typed reference.
- If you *must* read via the manager, centralize the assignment in one accessor:

```java
@SuppressWarnings("unchecked")
private static AppRoot rootOf(EmbeddedStorageManager s) {
    return s.root();   // single maintenance point for the unchecked cast
}
```

## `XThreads.executeSynchronized` (optional helper)

File: `serializer/base/src/main/java/org/eclipse/serializer/concurrency/XThreads.java`.

```java
XThreads.executeSynchronized(() -> {
    root.addOrder(order);
    storage.store(root.orders());
});
```

`Runnable` and `Supplier<T>` overloads. Uses a single JVM-wide monitor. Correct but
coarse — in a multi-aggregate app, write per-aggregate locks yourself.

## Constants registration (JVM-static objects)

For singletons or enum-like constants that the graph references, register them as
named roots on the connection foundation's root resolver provider so Eclipse Store
identifies them by reference instead of by value:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf ->
        cf.getRootResolverProvider()
          .registerRoot("AppConstants.SYSTEM_USER", AppConstants.SYSTEM_USER)
    );
```

Pick stable identifier strings (renaming them later requires a refactoring mapping).
Registration must happen before `.start()`.

## Summary — pick your tool

| I want to… | Use |
|---|---|
| …bootstrap a real application | `start(root, dir)` with a custom `AppRoot` class. |
| …write a one-off script | `start(dir)` + `setRoot(new HashMap<>())`. |
| …replace the root mid-app | `setRoot(newRoot); storeRoot();` then GC. |
| …register a static constant | Foundation + `cf.getRootResolverProvider().registerRoot("ID", instance)`. |
| …swap to a different root class | Custom migration + `setRoot` or `legacy-type-mapping`. |
