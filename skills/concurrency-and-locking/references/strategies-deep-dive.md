# Strategies — deep dive

Five complete examples. Each implements the same trivial service —
register a customer, look one up — so the trade-offs are easy to compare.

The single rule applies to all of them: the lock spans **both** the mutation
and the `store()` call.

## 1. Coarse-grained — `synchronized` / `XThreads.executeSynchronized`

```java
import org.eclipse.serializer.concurrency.XThreads;

public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    public void register(Customer c) {
        XThreads.executeSynchronized(() -> {
            root.customers().add(c);
            storage.store(root.customers());
        });
    }

    public Customer findById(int id) {
        return XThreads.executeSynchronized(() -> root.customers().get(id));
    }
}
```

**Trade-offs.** Correct, simplest. One lock for the whole JVM — every
`executeSynchronized` call serialises against every other. Right when you
do not care about throughput, or when reads do not dominate.

A pure-JDK equivalent: hold a `private final Object monitor = new Object();`
field and `synchronized (monitor) { ... }`. Same semantics, no Eclipse Store
dependency.

## 2. `ReentrantReadWriteLock`

```java
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;
    private final ReadWriteLock          lock = new ReentrantReadWriteLock();

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    public void register(Customer c) {
        lock.writeLock().lock();
        try {
            root.customers().add(c);
            storage.store(root.customers());
        } finally {
            lock.writeLock().unlock();
        }
    }

    public Customer findById(int id) {
        lock.readLock().lock();
        try {
            return root.customers().get(id);
        } finally {
            lock.readLock().unlock();
        }
    }
}
```

**Trade-offs.** Multiple `findById` calls can run in parallel; a `register`
blocks until all readers have released. Verbose; the try/finally is mandatory
(an exception inside the block must release the lock). Most apps end up here.

## 3. `LockedExecutor`

```java
import org.eclipse.serializer.concurrency.LockedExecutor;

public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;
    private final LockedExecutor         exec = LockedExecutor.New();

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    public void register(Customer c) {
        exec.write(() -> {
            root.customers().add(c);
            storage.store(root.customers());
        });
    }

    public Customer findById(int id) {
        return exec.read(() -> root.customers().get(id));
    }
}
```

**Trade-offs.** Same semantics as the explicit RW lock with less ceremony.
The `exec.read` / `exec.write` lambdas are the critical sections; the helper
manages acquire/release. Recommended over the manual form unless you need to
do something the lambda shape does not allow (multiple acquires interleaved
with non-locked work, etc.).

## 4. `LockScope` — inheritance form

```java
import org.eclipse.serializer.concurrency.LockScope;

public class CustomerService extends LockScope {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    public void register(Customer c) {
        write(() -> {
            root.customers().add(c);
            storage.store(root.customers());
        });
    }

    public Customer findById(int id) {
        return read(() -> root.customers().get(id));
    }
}
```

**Trade-offs.** Tightest syntax. The lock is scoped to the instance, so two
instances of `CustomerService` would not share a lock — usually fine, since
you typically have one per Spring bean. Less flexible than `LockedExecutor`
because you cannot pass the executor around.

## 5. Striped — `StripeLockedExecutor`

```java
import org.eclipse.serializer.concurrency.StripeLockedExecutor;

public class TenantOrderService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;
    private final StripeLockedExecutor   exec = StripeLockedExecutor.New(64);

    public TenantOrderService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    public void place(String tenantId, Order o) {
        exec.write(tenantId, () -> {
            root.ordersFor(tenantId).add(o);
            storage.store(root.ordersFor(tenantId));
        });
    }

    public List<Order> ordersFor(String tenantId) {
        return exec.read(tenantId, () -> List.copyOf(root.ordersFor(tenantId)));
    }
}
```

**Trade-offs.** Two tenants placing orders in parallel hold different stripes
and do not contend. A query that needs to lock *across* tenants is back to
serial — striping helps only when the partition is real. The number of
stripes (`64` here) is a hash-target — too few and stripes contend; too many
and memory grows for no benefit.

The `read(Object mutex, …)` / `write(Object mutex, …)` overloads take
`Action` (side-effecting) or `Producer<R>` (value-returning) — same shape
as `LockedExecutor`, with an extra `mutex` argument that picks the stripe
via `abs(mutex.hashCode()) % stripeCount`.

## 6. Spring Boot — `@Read` / `@Write` / `@Mutex`

```java
import org.eclipse.store.integrations.spring.boot.types.concurrent.Mutex;
import org.eclipse.store.integrations.spring.boot.types.concurrent.Read;
import org.eclipse.store.integrations.spring.boot.types.concurrent.Write;
import org.springframework.stereotype.Service;

@Service
@Mutex("customers")
public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    @Write
    public void register(Customer c) {
        root.customers().add(c);
        storage.store(root.customers());
    }

    @Read
    public Customer findById(int id) {
        return root.customers().get(id);
    }
}
```

**Trade-offs.** Most concise. Requires `spring-boot-starter-aop` on the
classpath; without it, the annotations are silently ignored — no warning. The
`@Mutex("customers")` partitions the lock so that a separate
`@Mutex("orders")` service does not contend.

**Important:** the contract is the same as the manual patterns. Both the
mutation **and** the `store()` call must be inside the annotated method body.
A method that mutates and returns, with `store()` deferred to a caller, is
broken — the lock has been released before the persist.

## Choosing between them

| Workload | Strategy |
|---|---|
| Single-threaded or near-single-threaded | `synchronized` / `XThreads.executeSynchronized` — keep it simple |
| Read-dominated | `ReentrantReadWriteLock` or `LockedExecutor` |
| Service classes, lots of methods, tired of try/finally | `LockedExecutor` or `LockScope` |
| Multi-tenant, per-tenant hot paths | `StripeLockedExecutor` |
| Spring Boot app | `@Read` / `@Write` / `@Mutex` |

The decision tree: start with `LockedExecutor`. Only step up to striped if
profiling shows lock contention is real and the data partitions cleanly. Only
step down to `XThreads.executeSynchronized` if writes dominate and the RW
machinery is overkill.
