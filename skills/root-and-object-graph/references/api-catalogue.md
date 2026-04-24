# API catalogue — root-and-object-graph

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## Root-related methods on `EmbeddedStorageManager`

File: `storage/embedded/src/main/java/org/eclipse/store/storage/embedded/types/EmbeddedStorageManager.java`

| Method | Return | Purpose |
|---|---|---|
| `root()` | `Object` | The active root — returns `customRoot()` if non-null, else `defaultRoot()`. Null if neither has been set. |
| `defaultRoot()` | `Object` | The default-root slot. Set by `setRoot(...)`. |
| `customRoot()` | `Object` | The custom-root slot. Set by `EmbeddedStorage.start(root, …)`. |
| `setRoot(Object)` | `Object` | Replaces the default root. Returns the previous value. Does **not** persist — call `storeRoot()` after. |
| `storeRoot()` | `long` | Persists whichever root is active. Returns the storage object id. |

## Connection-foundation hooks (advanced)

File: `persistence/.../PersistenceRootResolverProvider.java`

When you need to intercept root registration beyond default/custom (e.g., to register
JVM-static constants), use the connection foundation on the embedded-storage foundation:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> {
        cf.getRootResolverProvider()
          .registerCustomRootSupplier(() -> myCustomRoot)
          .registerRoot("auxKey", auxObject);
    });
```

Relevant interfaces:

| Interface | File | Purpose |
|---|---|---|
| `PersistenceRootResolverProvider` | `persistence/binary/types/PersistenceRootResolverProvider.java` | Registers roots, aux entries, constants. |
| `PersistenceRootResolver` | `persistence/binary/types/PersistenceRootResolver.java` | Resolves an identifier → object during load. |
| `PersistenceRootReference` | `persistence/binary/types/PersistenceRootReference.java` | The reference wrapper used for root slots. |

Note: in 99% of applications the `setRoot` / `customRoot` story is all you need. The
foundation-level root resolver is for libraries that layer on top of Eclipse Store.

## Typing and the root

`root()`, `defaultRoot()`, `customRoot()` all return `Object`. To avoid casts:

- Use **custom root** (Pattern A in SKILL.md) — keep your own typed reference.
- If you *must* use the default root, centralize the cast in one accessor:

```java
private static AppRoot rootOf(EmbeddedStorageManager s) {
    return (AppRoot) s.root();   // documented cast; single maintenance point
}
```

## `XThreads.executeSynchronized` (optional helper)

File: `base/src/main/java/org/eclipse/serializer/util/X.java` (and `XThreads` utility).

```java
XThreads.executeSynchronized(() -> {
    root.addOrder(order);
    storage.store(root.orders());
});
```

This uses a single JVM-wide monitor. Correct but coarse — in a multi-aggregate app,
write per-aggregate locks yourself.

## Constants registration (JVM-static objects)

For singletons or enum-like constants that the graph references, register them so
Eclipse Store identifies them by reference instead of by value:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf ->
        cf.registerConstantInstance(AppConstants.SYSTEM_USER)
    );
```

Each call adds one constant. Duplicates are rejected. Registration must happen before
`.start()`.

## Summary — pick your tool

| I want to… | Use |
|---|---|
| …bootstrap a real application | `start(root, dir)` with a custom `AppRoot` class. |
| …write a one-off script | `start(dir)` + `setRoot(new HashMap<>())`. |
| …replace the root mid-app | `setRoot(newRoot); storeRoot();` then GC. |
| …register a static constant | Foundation + `registerConstantInstance`. |
| …swap to a different root class | Custom migration + `setRoot` or `legacy-type-mapping`. |
