# Pitfalls deep-dive — concurrency-and-locking

The three failure modes from the upstream guide first, then the recurring
mistakes that produce them.

## Failure modes

### F1. Partial reads

**Reproducer.**

```java
// Thread A
lock.writeLock().lock();
customer.setEmail("new@acme.com");
// ...10ms of other work, intentionally inside the lock so far
auditLog.append("email changed: " + customer.id());
storage.storeAll(customer, auditLog);     // one durable unit; see Pitfall #6 in SKILL.md
lock.writeLock().unlock();

// Thread B (no lock!)
String email   = customer.email();        // sees "new@acme.com"
int    entries = auditLog.size();         // sees the previous size
// → email changed but auditLog claims it didn't
```

**Symptom.** Reports periodically show customers whose email has changed but
whose audit log has no record of the change.

**Root cause.** Thread B reads without acquiring the read lock. The window
between the field write and the audit-log append is observable.

**Fix.** Thread B must `lock.readLock().lock()` for the duration of *both*
reads. The write lock prevents readers from observing intermediate states.

### F2. Persisted-graph divergence

**Reproducer.**

```java
// Thread A — no lock
root.orders().add(o1);
// preempted before store()

// Thread B — no lock
root.orders().add(o2);
storage.store(root.orders());      // persists [..., o1, o2]

// Thread A resumes — no lock
storage.store(root.orders());      // re-persists [..., o1, o2] but A's
                                   // logic was not designed for o2
```

**Symptom.** On restart, both orders are present, but the integrity check
that A was supposed to run after persisting `o1` never ran for `o2` —
because A did not know about `o2`. Invariants drift.

**Fix.** Both threads must hold the same write lock for the full mutate +
`store()` window. Without it, the persisted state diverges from any single
thread's intent.

### F3. GigaMap stored in inconsistent state

**Reproducer.**

```java
GigaMap<Order> orders = root.orders();

// Thread A
new Thread(() -> {
    orders.add(new Order(...));            // mutates the GigaMap
}).start();

// Thread B — concurrent
storageManager.store(orders);              // walks the GigaMap structure
                                           // while A mutates it
```

**Symptom.** The store throws (or, worse, succeeds against an inconsistent
snapshot). The error message often points at `BinaryTypeHandler` or
`PersistenceObjectRegistry` — confusingly remote from the actual cause.

**Root cause.** `storageManager.store(gigaMap)` does **not** acquire the
GigaMap's internal lock. The serializer walks an internally-changing
structure.

**Fix.** Use `gigaMap.store()`, which acquires the GigaMap's internal lock
for the duration of the store. The mutation thread will block until the
store completes (or vice versa).

```java
orders.store();   // safe — acquires the GigaMap's internal lock
```

## Recurring mistakes

### P1. Mutation in one method, `store()` in another

**Reproducer.**

```java
@Write
public void update(Customer c) {
    root.customers().put(c.email(), c);
    // returns; @Write releases the lock
}

@Write
public void persist() {
    storage.store(root.customers());
}
```

**Symptom.** Another thread calls `update()` between the first `update()`
and `persist()`. Two updates are queued, then the persist captures both —
but the first one's audit log entry happened before the second's mutation.
Invariants drift exactly as in F2.

**Fix.** The mutation and the `store()` must be in the *same* method, under
the *same* lock acquisition. If you want a ledger of `update` operations,
log inside the `@Write` method, not in a separate one.

### P2. Holding a lock across slow operations

**Reproducer.**

```java
@Write
public void importFromUrl(String url) {
    HttpResponse<String> res = http.send(req(url), BodyHandlers.ofString());
    Customer c = parse(res.body());
    root.customers().add(c);
    storage.store(root.customers());
}
```

**Symptom.** The whole service freezes while one HTTP call is in flight.
Throughput collapses.

**Fix.** Parse offline; acquire the lock only for the mutation + `store()`.

```java
public void importFromUrl(String url) {
    HttpResponse<String> res = http.send(req(url), BodyHandlers.ofString());
    Customer c = parse(res.body());
    apply(c);                // separate, locked method
}

@Write
private void apply(Customer c) {
    root.customers().add(c);
    storage.store(root.customers());
}
```

### P3. Returning a live mutable collection from inside the lock

**Reproducer.**

```java
@Read
public List<Customer> all() {
    return root.customers();   // the live List
}

// Caller — outside any lock
List<Customer> cs = service.all();
cs.add(new Customer("rogue"));   // mutates the persisted graph!
```

**Symptom.** Stray customers appear with no `store()` call ever logged. Or
`ConcurrentModificationException` on someone else's iteration.

**Fix.** Return an unmodifiable view, a defensive copy, or a snapshot.

```java
@Read
public List<Customer> all() {
    return List.copyOf(root.customers());
}
```

Streams returned from inside a `@Read` are similarly suspect — the
underlying collection can be mutated after the stream is returned. Either
materialise (`.toList()`) before returning or document the contract loudly.

### P4. Forgetting to close GigaMap iterators

**Reproducer.**

```java
GigaQuery<Order> q = orders.query(statusIndex.is("OPEN"));
Iterator<Order> it = q.iterator();          // acquires read lock
// ...some work, then the method returns without closing
```

**Symptom.** Writers block forever waiting for the leaked read lock.
`gigaMap.add(...)` blocks on what looks like nothing.

**Fix.** Always try-with-resources.

```java
try (GigaIterator<Order> it = q.iterator()) {
    while (it.hasNext()) { handle(it.next()); }
}
```

The same applies to query results consumed via streams or `forEach` —
either let the helper close the iterator for you (most do; check the
specific API), or wrap explicitly.

### P5. `storageManager.store(gigaMap)`

**Reproducer.** See F3 above. This is the same bug, common enough to warrant
its own slot.

**Fix.** Always `gigaMap.store()`. The convenience method on
`EmbeddedStorageManager` does **not** acquire the GigaMap's internal lock.

### P6. Sharing a `Storer` across threads

**Reproducer.**

```java
Storer storer = storage.createStorer();    // built once, shared

// Thread A
storer.store(a1);

// Thread B — concurrent
storer.store(a2);

// Thread A
storer.commit();
```

**Symptom.** Random `IllegalStateException`, intermittent corruption of the
persistent context, missing objects on disk.

**Root cause.** `Storer` is single-threaded internal state — register
buffers, type handlers, the registry view. Sharing it across threads is
unsupported.

**Fix.** Each thread that wants to commit gets its own `Storer`.

```java
// per-thread
Storer s = storage.createStorer();
s.store(...);
s.commit();
```

The same applies to `createLazyStorer`, `createEagerStorer`, and
`BatchStorer`.

### P7. Wrapping every method in `synchronized`

**Reproducer.**

```java
public synchronized void register(Customer c) { /* ... */ }
public synchronized Customer findById(int id) { /* ... */ }
public synchronized List<Customer> all()       { /* ... */ }
public synchronized int count()                { /* ... */ }
```

**Symptom.** Reads serialise against reads. Throughput is single-threaded
even when the workload is 99% read.

**Fix.** Switch to `ReentrantReadWriteLock` or `LockedExecutor`. Reserve
`synchronized` for genuinely write-heavy or low-contention apps.

### P8. Mixing strategies on the same protected region

**Reproducer.**

```java
public class CustomerService {
    private final Object monitor = new Object();
    private final LockedExecutor exec = LockedExecutor.New();

    public void register(Customer c) {
        synchronized (monitor) {           // strategy A
            root.customers().add(c);
            storage.store(root.customers());
        }
    }

    public Customer findById(int id) {
        return exec.read(() -> root.customers().get(id));   // strategy B
    }
}
```

**Symptom.** Reader sees a partially-mutated graph because the writer's
`monitor` does not serialise against the reader's `exec.read`.

**Fix.** Pick one strategy per protected region. Either both methods use
`synchronized (monitor)`, or both use `exec.read` / `exec.write`. Mixing
them is identical to having no lock at all.

## Stress-test pattern (catches most regressions)

```java
@Test
void concurrentWritersAndReadersStayConsistent() throws Exception {
    EmbeddedStorageManager storage = startStorage(tmp);
    AppRoot root = (AppRoot) storage.root();
    LockedExecutor exec = LockedExecutor.New();

    int writers = 4, readers = 8, ops = 10_000;
    ExecutorService pool = Executors.newFixedThreadPool(writers + readers);
    CountDownLatch start = new CountDownLatch(1);
    AtomicLong errors = new AtomicLong();

    for (int i = 0; i < writers; i++) {
        pool.submit(() -> {
            start.await();
            for (int n = 0; n < ops; n++) {
                exec.write(() -> {
                    Order o = new Order(UUID.randomUUID().toString(), n);
                    root.orders().add(o);
                    storage.store(root.orders());
                });
            }
            return null;
        });
    }
    for (int i = 0; i < readers; i++) {
        pool.submit(() -> {
            start.await();
            for (int n = 0; n < ops; n++) {
                exec.read(() -> {
                    int size = root.orders().size();
                    if (size < 0) errors.incrementAndGet();
                });
            }
            return null;
        });
    }

    start.countDown();
    pool.shutdown();
    pool.awaitTermination(60, TimeUnit.SECONDS);
    storage.shutdown();

    // Re-open and verify the invariant on the persisted state
    EmbeddedStorageManager reopened = startStorage(tmp);
    AppRoot reopenedRoot = (AppRoot) reopened.root();
    assertEquals(writers * ops, reopenedRoot.orders().size());
    reopened.shutdown();

    assertEquals(0, errors.get());
}
```

The decisive step is the **reopen and re-assert**. That is what proves the
lock covered the `store()` call and not just the mutation. A bug that loses
writes on shutdown will pass the in-memory assertion and fail the
post-restart one.
