---
name: concurrency-and-locking
description: >
  Guide Claude on safe concurrent access to Eclipse Store object graphs — the
  "mutate + store under the same lock" rule, what is and isn't thread-safe
  (`EmbeddedStorageManager`, channels, `Storer`, `GigaMap`, `Lazy<T>`, JCache,
  `Serializer`), and which strategy to use (`XThreads.executeSynchronized`,
  `ReentrantReadWriteLock`, `LockedExecutor`, `LockScope`, `StripeLockedExecutor`,
  `StripeLockScope`, Spring `@Read` / `@Write` / `@Mutex`). Use this skill when
  the user asks to "handle concurrent access", "make this thread-safe",
  "synchronize storing", "lock around store()", "ConcurrentModificationException
  during serialize", "share a Storer across threads", "what's thread-safe in
  Eclipse Store", "GigaMap concurrency", "gigaMap.store vs storageManager.store",
  "iterators leaking read locks", "stress-test concurrent writes", or asks why a
  multi-threaded app is producing inconsistent state on disk.
version: 0.1.0
---

# Eclipse Store — Concurrent Access and Locking

Eclipse Store loads your object graph directly into the JVM heap — it is the same
graph you read, mutate, and persist. There is no defensive copy, no session-scoped
cache, no proxy. That is what makes the library fast, and it is also why **the
application is responsible for synchronizing concurrent access**. The library
cannot do it for you because the library is not in the read/write path.

This skill is the canonical treatment of that responsibility: the single rule, the
thread-safety matrix, the strategies, the GigaMap-specific story, and the pitfalls.

## When to use this skill

- User has a multi-threaded app (web request handlers, scheduled jobs, background
  workers) hitting the same `EmbeddedStorageManager`.
- User reports `ConcurrentModificationException` during `store()` serialization.
- User asks whether a particular API is thread-safe.
- User is choosing between `synchronized`, `ReentrantReadWriteLock`,
  `LockedExecutor`, striped locking, or Spring `@Read`/`@Write`/`@Mutex`.
- User is mixing `gigaMap.store()` and `storageManager.store(gigaMap)` and
  hitting inconsistent state.
- User is sharing a `Storer` across threads.
- User wants a stress-test pattern for concurrency regressions.

**Route elsewhere** when:

- User has a single-threaded app — the rule still applies in principle, but no
  locks are needed. Stick with `storing-data`.
- User is configuring the lock *file* (process-level lock that prevents two JVMs
  from opening the same storage) → `configuration`. That is unrelated to
  application-level concurrency.
- User wants the Spring AOP setup details → `spring-boot`. Conceptual rules live
  here; the bean wiring lives there.

## Mental model — the single invariant

Modifying the object graph and the corresponding `store()` call **must happen
under the same lock**. Concretely, a thread that mutates the graph must hold a
lock that spans:

1. the mutation itself (the assignment, the `add()`, the field update), and
2. the `store(...)` call that persists it.

No other thread may execute either step on the affected objects until both are
complete.

This is the same atomicity guarantee any in-memory shared data structure
requires in Java. The only difference is that with Eclipse Store the second
step — `store()` — is **part of the critical section**, not an afterthought
handed to a transaction manager.

### Why this differs from JDBC / JPA / ORMs

Most persistence frameworks insulate the application from the data store by
copying values across a boundary: JDBC returns primitive `ResultSet` values;
JPA hydrates entities into a session-scoped cache; ORMs hand back fresh proxies.
The application mutates a *copy*; concurrency between threads is mediated by
the database's transaction isolation.

Eclipse Store has no copy step. The graph you load is the graph you mutate is
the graph you persist. The framework is not in the read/write path, so the
framework cannot lock around it — your application must.

## The three failure modes (recognise these in incident logs)

1. **Partial reads.** Thread A is halfway through a multi-step mutation. Thread
   B reads the graph and sees an internally inconsistent intermediate state —
   a `Customer` with updated address but stale audit log, an order whose line
   items no longer sum to its total.
2. **Persisted-graph divergence.** Thread A mutates but has not yet called
   `store()`. Thread B grabs the lock, mutates, and stores. Thread A resumes
   and stores — but the graph it persists already includes B's changes. The
   persisted state diverges from what either thread "intended".
3. **GigaMap stored in inconsistent state.** Calling `storageManager.store(gigaMap)`
   while another thread is mutating the GigaMap walks a structure that is
   changing under it; the store fails. (`gigaMap.store()` does not have this
   problem — see [GigaMap concurrency](#gigamap-concurrency).)

## Thread-safety matrix

The boundary between "library handles it" and "you handle it" is at the object
graph: the library locks its internal I/O machinery; you lock the graph it
serializes.

| Component | Thread-safe? | Notes |
|---|---|---|
| `EmbeddedStorageManager` (I/O) | yes | Handles channel I/O, housekeeping, file locking internally. The application's view of the graph it persists is **not** thread-safe — that is your job. |
| Storage channels | yes | Internal I/O threads that parallelize file reads/writes. **Not** an application-level concurrency primitive — they do not synchronize access from your application threads. |
| `EmbeddedStorageManager.store(...)` | atomic for **durability** only | Each `store()` is an all-or-nothing write on disk. This is *durability* atomicity, not RAM isolation. The in-memory graph the store traverses is **not** protected from concurrent mutation. |
| `GigaMap` operations (`add`, `remove`, `update`, `get`, `apply`) | yes | Each acquires the GigaMap's internal read-write lock. Iterators must be closed (try-with-resources) so the read lock is released. |
| `gigaMap.store()` vs `storageManager.store(gigaMap)` | only `gigaMap.store()` | The former acquires the GigaMap's internal lock during the store; the latter does not. **Always prefer `gigaMap.store()`.** |
| `Lazy<T>.get()` | yes | Concurrent calls are safe. The background clearing thread uses `WeakReference` and cannot reclaim a reference still held by application code. |
| `Cache<K, V>` (cache module) | yes | JCache contract; thread-safe by JSR-107 spec. |
| `Serializer` instances | **no** | Confine to a single thread. The `SerializerFoundation` is safe to share. |
| `Storer` (`createStorer`, `createLazyStorer`, `createEagerStorer`) | **no** | A `Storer` is a per-thread unit of work. Each thread that wants to store concurrently must obtain its own from the manager — they must not be shared. |
| The application's object graph | **no** | Plain Java objects in the heap. Concurrent access must be synchronized by the application. |

The lock *file* (proprietary file-lock that prevents two JVMs from opening the
same storage) is **unrelated** to application-level concurrency. It is process
serialization, not thread serialization.

## Strategies, simple → advanced

Pick one and apply it consistently per protected region. Mixing strategies on
the same data is a common source of subtle bugs — a `synchronized` block on
the root and a `LockedExecutor` covering the same data do **not** serialise
against each other.

### Coarse-grained synchronization

Wrap every read and every write in the same lock. Eclipse Store provides
`XThreads.executeSynchronized(Runnable)`; the JDK equivalent is `synchronized`
on a shared monitor.

```java
XThreads.executeSynchronized(() -> {
    root.changeData();
    storageManager.store(root);
});
```

Correct, simplest. Throughput suffers because only one thread runs at a time,
regardless of read vs write. Right for low-contention apps or when reads do not
dominate.

### `ReentrantReadWriteLock`

Most apps read far more than they write. RW locking lets multiple readers
proceed in parallel while still serialising writers.

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

This is what most Eclipse Store apps end up using. Verbose but transparent.

### `LockedExecutor` and `LockScope`

For more concise code without the manual try/finally, Eclipse Store provides
two helpers wrapping a `ReentrantReadWriteLock`:

- **`LockedExecutor`** — a wrapper exposing `read(Supplier)` / `write(Runnable)`.
- **`LockScope`** — a base class with the same methods inherited into your
  domain class.

```java
LockedExecutor exec = LockedExecutor.New();

exec.write(() -> {
    root.customers().add(c);
    storage.store(root.customers());
});

Customer c = exec.read(() -> root.customers().get(id));
```

Same semantics as the explicit RW lock, less boilerplate.

### Striped locking

If the graph naturally partitions into independent regions (customer-scoped,
tenant-scoped, shard-scoped), striped locking lets threads working on different
regions run in parallel even when both hold write locks.

`StripeLockedExecutor` and `StripeLockScope` are the helpers. Striped locking
is more complex than RW and **does not help if the hot path crosses stripes** —
measure before reaching for it.

### Spring Boot — `@Read` / `@Write` / `@Mutex`

The Spring Boot integration provides a declarative AOP layer for the same
pattern. Annotate service methods; the aspect acquires the lock.

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

`@Mutex("name")` partitions locks (per-aggregate). See `spring-boot` skill for
the full setup. The contract is identical to the manual patterns above:
*the lock must span both the mutation and the `store()` — both must be inside
the annotated method body*.

## GigaMap concurrency

GigaMap has its own concurrency story because it is itself a thread-safe data
structure.

1. **Each GigaMap operation (`add`, `remove`, `update`, `apply`, `get`) acquires
   the GigaMap's internal read-write lock.** You do *not* need to wrap individual
   GigaMap operations in your own lock for them to be atomic.
2. **Always prefer `gigaMap.store()` over `storageManager.store(gigaMap)`.**
   The former acquires the GigaMap's internal lock for the duration of the
   store; the latter does not. Concurrent mutations during the store leave the
   GigaMap in an inconsistent state and the store fails.
3. **Iterators must be closed** so the underlying read lock is released. Use
   try-with-resources for any iterator returned from a GigaMap. A leaked
   iterator holds the read lock open and starves writers.
4. **The internal lock covers GigaMap operations only.** Stored *elements* (the
   values held in the GigaMap and any objects they reference) can still be
   mutated by another thread during the store walk. The GigaMap itself remains
   fine, but the persisted element graph may be inconsistent. Application-level
   synchronization is still required around mutation and storing of those
   objects.
5. **Cross-aggregate atomicity is your job.** If a business operation modifies
   a GigaMap *and* other parts of the object graph atomically, you still need
   an application-level lock spanning both — the GigaMap's internal lock does
   not extend to non-GigaMap state.

This is the classic limitation of synchronized JDK collections like `Vector`:
per-method synchronization is not enough when a logical operation needs to
span multiple calls.

## Pitfalls

1. **Mutation in one method, `store()` in another.** The lock has to span
   both. A `void update()` that mutates and returns, followed by a separate
   `void persist()` that calls `store()`, is broken even if both methods are
   individually synchronized — another thread can mutate between them.
2. **Holding a lock across slow operations.** Network calls, UI callbacks,
   blocking I/O, human input — none belong inside the critical section. The
   lock should bracket the mutation and the `store()`, nothing more.
3. **Returning a mutable collection from inside the lock.** A `@Read` method
   returning the live `List<Customer>` lets the caller mutate it after the
   read lock has been released. Return an unmodifiable view, defensive copy,
   or snapshot.
4. **Forgetting to close GigaMap iterators.** Leaked iterator → leaked read
   lock → starved writers. Always try-with-resources.
5. **Using `storageManager.store(gigaMap)`.** Bypasses the GigaMap's internal
   lock; use `gigaMap.store()`.
6. **Sharing a `Storer` across threads.** A `Storer` is single-threaded state.
   Each thread that wants to store concurrently must obtain its own.
7. **Wrapping every method in `synchronized`.** Correct, but degenerates to
   single-threaded throughput. If the profiler shows lock contention
   everywhere, switch to RW before reaching for striped locks.
8. **Mixing strategies on the same protected region.** A `synchronized` block
   on the root and a `LockedExecutor` covering the same data do not serialise
   against each other. Pick one strategy per protected region.

## Testing for concurrency correctness

Concurrency bugs do not reproduce in single-threaded unit tests. The pattern
that catches most regressions:

1. Spin up a fixed number of writer and reader threads against a real
   `EmbeddedStorageManager`.
2. Run them for tens of seconds, performing thousands of mutations and reads
   each.
3. After the run, assert **invariants** on the in-memory graph — totals match
   line items, parent/child references are consistent, no duplicate keys.
4. Restart the storage and re-assert the invariants on the persisted state to
   confirm the lock also covered the `store()` call.

Stress tests should run as part of CI, not just on a developer's machine. For
deterministic exploration of interleavings, frameworks like
[JCStress](https://openjdk.org/projects/code-tools/jcstress/) are available,
but the simple stress-test pattern above catches the overwhelming majority of
real-world bugs.

## Interactions with other skills

- **`storing-data`** — every example of mutation + `store()` is implicitly
  inside a critical section; this skill is what makes that work in
  multi-threaded code. The "explicit argument is always re-written" rule is
  there.
- **`gigamap`** — GigaMap-specific concurrency rules above; the rest of the
  skill covers indices, queries, and `gigaMap.store()`.
- **`spring-boot`** — Spring's `@Read` / `@Write` / `@Mutex` AOP is the
  declarative form of the rule here. Spring's `@Transactional` does **nothing**
  for Eclipse Store.
- **`serializer-standalone`** — `Serializer` instances must be confined to a
  single thread; the `SerializerFoundation` is safe to share.
- **`configuration`** — the lock *file* is process-level (preventing two JVMs
  from opening the same storage), unrelated to the thread-level rules here.

## Recipes

**"How do I handle concurrent writes?"** → Pick a strategy from the ladder
above. Default to `ReentrantReadWriteLock` or `LockedExecutor` unless your
read/write ratio or partitioning suggests otherwise.

**"Is `EmbeddedStorageManager.store()` thread-safe?"** → For *durability*
(the on-disk write), yes — atomic. For *isolation* (the in-memory graph it
traverses), **no** — your lock must cover the graph.

**"Can I share a `Storer` across threads?"** → No. Each thread gets its own.

**"`storageManager.store(gigaMap)` keeps failing."** → That is the symptom of
GigaMap-internal-state-changed-under-the-store. Switch to `gigaMap.store()`.

**"Do channels parallelize my writes?"** → They parallelize the library's I/O,
not your application's mutations. Channels are internal threads; they do not
synchronize anything for you.

**"My read method returns a `List` — is that safe?"** → Only if the caller
cannot mutate it after you release the read lock. Return an unmodifiable view
(`Collections.unmodifiableList`), a copy, or a snapshot.

**"How do I lock per-aggregate without Spring?"** → Manage one
`ReentrantReadWriteLock` (or `LockedExecutor`) per aggregate root, look up the
right one in the service method, and acquire/release explicitly. Striped
helpers (`StripeLockedExecutor`) automate the lookup if your stripes are
hashable.

**"How do I stress-test the locking?"** → See "Testing for concurrency
correctness" above. The key step is the **restart and re-assert** — that is
what proves your lock covered the `store()` and not just the mutation.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — signatures for `XThreads.executeSynchronized`,
  `LockedExecutor`, `LockScope`, `StripeLockedExecutor`, `StripeLockScope`,
  Spring `@Read` / `@Write` / `@Mutex`, `LockAspect`.
- `references/strategies-deep-dive.md` — full code examples for each strategy
  (coarse, RW, helpers, striped, Spring) with trade-off discussion.
- `references/pitfalls-deep-dive.md` — each pitfall with reproducer and fix,
  including the three failure modes (partial reads, persisted-graph divergence,
  GigaMap stored in inconsistent state).

## Upstream sources

- `docs/modules/intro/pages/concurrent-access.adoc` — the canonical treatment
  this skill mirrors.
- `docs/modules/misc/pages/locking/index.adoc` — the helpers reference
  (`LockedExecutor`, `LockScope`, `StripeLockedExecutor`,
  `ReentrantReadWriteLock` patterns).
- `docs/modules/misc/pages/integrations/spring-boot.adoc` — the
  `_mutex_locking` section covers `@Read` / `@Write` / `@Mutex`.
- `docs/modules/storage/pages/storing-data/transactions.adoc` — `store()`
  atomicity at the persistence level.
- `docs/modules/gigamap/pages/crud.adoc#_locking` and
  `docs/modules/gigamap/pages/persistence.adoc` — GigaMap's internal locking
  and the `gigaMap.store()` rule.
- `docs/modules/serializer/pages/performance.adoc` — per-thread `Serializer`
  pattern.
- `docs/modules/storage/pages/configuration/lock-file.adoc` — *process*-level
  locking (unrelated to application-level concurrency).
