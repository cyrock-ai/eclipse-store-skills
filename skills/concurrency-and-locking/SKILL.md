---
name: concurrency-and-locking
description: >
  Guide Claude on safe concurrent access to Eclipse Store object graphs — the
  "mutate + store under the same lock" rule, what is and isn't thread-safe
  (`EmbeddedStorageManager`, channels, `Storer`, `GigaMap`, `Lazy<T>`, JCache,
  `Serializer`), and which strategy to use (`XThreads.executeSynchronized`,
  `ReentrantReadWriteLock`, `LockedExecutor`, `LockScope`, `StripeLockedExecutor`,
  `StripeLockScope`, Spring `@Read` / `@Write` / `@Mutex`).

  **Apply this skill whenever an Eclipse Store object model, root aggregate, or
  service / repository / facade layer is being designed, reviewed, or extended**
  — not only when the user explicitly mentions "lock" or "synchronized". In
  Eclipse Store the application owns thread-safety because the library is not
  in the read/write path, so locking decisions are part of the data model and
  service-layer design itself: where the locks live, which methods are read vs.
  write, where `store()` is called, whether to use `LockScope` /
  `StripeLockedExecutor` / Spring `@Read`/`@Write`/`@Mutex`. If you are sketching
  entities, root containers, repositories, or any API that mutates persistent
  state, load this skill before proposing a structure.

  Also use this skill when the user asks to "handle concurrent access", "make
  this thread-safe", "synchronize storing", "lock around store()",
  "ConcurrentModificationException during serialize", "share a Storer across
  threads", "what's thread-safe in Eclipse Store", "GigaMap concurrency",
  "gigaMap.store vs storageManager.store", "iterators leaking read locks",
  "stress-test concurrent writes", or asks why a multi-threaded app is
  producing inconsistent state on disk.
version: 0.3.0
---

# Eclipse Store — Concurrent Access and Locking

The application owns thread-safety: the library is not in the read/write
path, so it cannot lock the graph for you.

## Do NOT use this skill

- Single-threaded app — rule still applies in principle but no locks
  needed → `storing-data`.
- Process-level lock *file* (preventing two JVMs opening the same storage)
  → `configuration`. Unrelated to thread-level locking.
- Spring AOP bean wiring details → `spring-boot`. Conceptual rules live
  here; wiring lives there.

## Mental model — the single invariant

Mutating the object graph and the matching `store()` call **must happen
under the same lock**. The lock spans both:

1. the mutation (assignment, `add()`, field update), and
2. the `store(...)` call that persists it.

No other thread may execute either step on the affected objects until
both are complete. This is plain in-memory Java concurrency — the only
twist is that `store()` is **part** of the critical section, not handed
off to a transaction manager.

## Thread-safety matrix

| Component | Thread-safe? | Notes |
|---|---|---|
| `EmbeddedStorageManager` (I/O) | yes | Internal channel I/O / housekeeping / file locking. Graph it persists is **not** safe — application's job. |
| Storage channels | yes | Internal I/O parallelism. **Not** an application-level concurrency primitive. |
| `EmbeddedStorageManager.store(...)` | atomic for **durability** only | All-or-nothing on disk. In-memory graph not protected from concurrent mutation. |
| `EmbeddedStorageManager.storeAll(Object...)` / `.storeAll(Iterable<?>)` | atomic for **durability** across all listed objects | **Single durable unit.** Use when one business op must persist multiple objects atomically (e.g. `storeAll(from, to)` in a transfer). Two consecutive `store()` calls are **not** atomic together — see Pitfall 6. |
| `GigaMap` ops (`add` / `remove` / `update` / `get` / `apply`) | yes | Each acquires GigaMap's internal RW lock. Iterators must be try-with-resources. |
| `gigaMap.store()` vs `storageManager.store(gigaMap)` | only `gigaMap.store()` | The former is `synchronized` on the GigaMap; the latter bypasses. **Always prefer `gigaMap.store()`.** |
| `Lazy<T>.get()` | yes | Concurrent calls safe. Background-clearing thread won't reclaim a still-held reference. |
| `Cache<K, V>` (cache module) | yes | JCache contract. |
| `Serializer` | **no** | Confine to a single thread. `SerializerFoundation` is safe to share. |
| `Storer` (`createStorer` / `createLazyStorer` / `createEagerStorer`) | **no** | Per-thread unit of work. Each thread that stores concurrently gets its own. |
| Application's object graph | **no** | Plain Java objects. Your synchronization. |

## Package quick-reference

| Symbol | Package |
|---|---|
| `XThreads`, `LockedExecutor`, `LockScope`, `StripeLockedExecutor`, `StripeLockScope` | `org.eclipse.serializer.concurrency` |
| `Action`, `Producer<R>` | `org.eclipse.serializer.functional` |
| `@Read`, `@Write`, `@Mutex`, `LockAspect` | `org.eclipse.store.integrations.spring.boot.types.concurrent` |

`Action` is a `@FunctionalInterface` with `void execute()`. `Producer<R>`
is `@FunctionalInterface` with `R produce()`. They're Eclipse-Serializer
equivalents of `Runnable` / `Supplier<R>`. **Neither declares any
`throws`** — checked exceptions inside the lambda body must be caught
and rethrown as unchecked (`RuntimeException`, `UncheckedIOException`,
etc.).

## Strategies, simple → advanced

**Default: `LockedExecutor` (least boilerplate, RW semantics).** Fall back
to a manual `ReentrantReadWriteLock` when you need lock objects passed
around explicitly, to coarse `XThreads.executeSynchronized` for one-off
scripts or low-contention apps, to `StripeLockedExecutor` only after
profiling shows contention crossing aggregate boundaries, and to Spring
`@Read`/`@Write`/`@Mutex` when the codebase is already Spring-AOP-wired.

Pick one and apply it consistently per protected region. Mixing
strategies on the same data does **not** serialise — a `synchronized`
block and a `LockedExecutor` covering the same graph race against each
other.

### Coarse — `XThreads.executeSynchronized`

`org.eclipse.serializer.concurrency.XThreads` — global monitor.

| Method | Returns |
|---|---|
| `XThreads.executeSynchronized(Runnable)` | `void` |
| `XThreads.executeSynchronized(Supplier<T>)` | `T` |

```java
XThreads.executeSynchronized(() -> {
    root.changeData();
    storageManager.store(root);
});
```

Simplest. One thread at a time globally — fine for low contention.

### `ReentrantReadWriteLock`

Manual JDK lock. Readers run in parallel, writers serialise.

```java
private final ReadWriteLock lock = new ReentrantReadWriteLock();

public void renameCustomer(String id, String email) {
    lock.writeLock().lock();
    try {
        Customer c = root.customers().get(id);
        if (c == null) return;
        c.setEmail(email);
        storage.store(c);            // mutation AND store inside the same lock
    } finally {
        lock.writeLock().unlock();
    }
}

public Customer find(String id) {
    lock.readLock().lock();
    try {
        return root.customers().get(id);
    } finally {
        lock.readLock().unlock();
    }
}
```

### `LockedExecutor` and `LockScope`

`LockedExecutor` wraps a `ReentrantReadWriteLock` behind an
`Action`/`Producer` API. `LockScope` is the same as an abstract base
class so your domain class inherits `read`/`write` inline.

| Method on `LockedExecutor` | Returns |
|---|---|
| `LockedExecutor.New()` | `LockedExecutor` |
| `read(Action)` | `void` |
| `read(Producer<R>)` | `R` |
| `write(Action)` | `void` |
| `write(Producer<R>)` | `R` |

`LockScope` exposes the same four methods as `protected` — subclass it.

```java
LockedExecutor exec = LockedExecutor.New();

exec.write(() -> {                              // Action
    root.customers().add(c);
    storage.store(root.customers());
});

Customer c = exec.read(() -> root.customers().get(id));   // Producer<Customer>
```

### `StripeLockedExecutor` and `StripeLockScope`

Striped RW locking — independent regions (per customer, per tenant, per
shard) run in parallel. Stripe is selected by `mutex.hashCode() %
stripeCount`.

| Method on `StripeLockedExecutor` | Returns |
|---|---|
| `StripeLockedExecutor.New(int stripeCount)` | `StripeLockedExecutor` |
| `read(Object mutex, Action)` | `void` |
| `read(Object mutex, Producer<R>)` | `R` |
| `write(Object mutex, Action)` | `void` |
| `write(Object mutex, Producer<R>)` | `R` |

`StripeLockScope` is the matching abstract base class (`protected`
methods, same shape). Pick stripe count as a power of 2 large enough
that hot mutexes don't collide. **Does not help if the hot path crosses
stripes** — measure before reaching for it.

```java
StripeLockedExecutor exec = StripeLockedExecutor.New(16);

exec.write(customerId, () -> {                  // mutex = customerId
    root.customers().get(customerId).recordVisit();
    storage.store(root.customers().get(customerId));
});
```

### Spring Boot — `@Read` / `@Write` / `@Mutex`

Declarative AOP at the service method level.

```java
@Component
public class CustomerService {
    @Write
    public void register(Customer c) {
        root.customers().add(c);
        storage.store(root.customers());   // mutation AND store inside @Write
    }

    @Read
    public Customer findById(int id) {
        return root.customers().get(id);
    }
}
```

`@Mutex("name")` partitions locks per name (per-aggregate). Bean wiring
+ AOP requirements live in `spring-boot`. The contract is identical to
the manual patterns: the lock must span both the mutation and the
`store()` — both inside the annotated method body.

## GigaMap concurrency

1. **Each GigaMap operation acquires the GigaMap's internal RW lock.**
   You do not need to wrap individual ops in your own lock for them to
   be atomic.
2. **Always prefer `gigaMap.store()` over `storageManager.store(gigaMap)`.**
   The former holds the internal lock for the duration of the store;
   the latter bypasses it and fails under concurrent mutation.
3. **Iterators must be closed** (try-with-resources). A leaked iterator
   holds the read lock open and starves writers.
4. **The internal lock covers GigaMap operations only.** Elements held
   in the GigaMap can still be mutated by another thread during the
   store walk — the GigaMap itself stays consistent, but the persisted
   element graph may not. Application-level synchronization around
   element mutation + storing is still needed.
5. **Cross-aggregate atomicity is your job.** GigaMap mutation + other
   graph changes inside one business operation needs an
   application-level lock spanning both.

## Pitfalls

1. **Mutation in one method, `store()` in another.** Lock must span
   both. `void update()` then `void persist()` is broken even if each
   is `synchronized` — another thread can interleave.
2. **Holding a lock across slow operations** — network calls, UI
   callbacks, blocking I/O. Bracket the mutation + store only.
3. **Returning a mutable collection from inside the lock.** Caller
   mutates after release. Return an unmodifiable view, a defensive
   copy, or a snapshot. **For aggregate invariants** (`sum`, `count`,
   `any`), compute the scalar *inside* the `read(...)` block and
   return that — never the underlying collection.
4. **Wrapping every method in `synchronized`.** Correct but
   single-threaded throughput. Switch to RW or striped when contention
   shows up in the profiler.
5. **Mixing strategies on the same protected region.** `synchronized`
   and `LockedExecutor` over the same data do not serialise against
   each other.
6. **Two consecutive `store()` calls treated as one atomic unit.**
   `store(from); store(to);` inside one write lock is **not** durably
   atomic — a crash between the two calls leaves persisted state
   inconsistent across restart. Use `storeAll(from, to)` (one call,
   one durable unit) whenever a business operation must persist
   multiple objects together. The in-memory lock guarantees no other
   thread interleaves; `storeAll` guarantees no crash can split the
   persisted view.

## Testing

The pattern that catches most regressions: N writer + M reader threads
against a real `EmbeddedStorageManager`, thousands of mutations each,
then assert at two levels:

1. **In-memory invariant** — after the stress run, check the live
   graph (total balance unchanged, parent / child references
   consistent, etc.).
2. **Persisted invariant** — close the storage, restart from the same
   directory, re-assert. This proves the lock covered the `store()`
   call and not just the mutation; an in-memory-only invariant can
   pass while the persisted view diverges.

## Interactions with other skills

- **`storing-data`** — every mutation + `store()` is implicitly inside
  a critical section.
- **`gigamap`** — GigaMap-specific rules above; rest of the skill
  covers indices / queries.
- **`spring-boot`** — `@Read` / `@Write` / `@Mutex` AOP setup. Spring's
  `@Transactional` does **nothing** for Eclipse Store.
- **`serializer-standalone`** — `Serializer` is single-thread;
  `SerializerFoundation` is shareable.
- **`configuration`** — the lock *file* is process-level, unrelated to
  thread-level locking.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a method overload
  or factory variant not in the in-line tables — e.g. additional
  `XThreads` helpers (`start(...)`, `sleep(...)`, `executeDelayed(...)`),
  `LockAspect` internals, less common `LockedExecutor`/`LockScope`
  constructors.
- **Load `references/strategies-deep-dive.md`** when implementing a
  non-trivial strategy variant — custom mutex selection for striping,
  custom lock pairing across aggregates, integrating an existing
  `ReentrantReadWriteLock` with `LockedExecutor.New(...)`, or weighing
  trade-offs between two strategies for a specific workload.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a
  concurrency bug — `ConcurrentModificationException` during `store()`,
  inconsistent persisted state after restart, hanging threads, a
  stress-test failure, or any "this worked single-threaded but broke
  under load" symptom.

## Upstream sources

`docs/modules/intro/pages/concurrent-access.adoc` —
canonical treatment. Helpers reference: `docs/modules/misc/pages/locking/`.
Spring AOP: `docs/modules/misc/pages/integrations/spring-boot.adoc`
(`_mutex_locking`). GigaMap locking:
`docs/modules/gigamap/pages/{crud.adoc#_locking,persistence.adoc}`.
