# AOP aspects — `@Read`, `@Write`, `@Mutex`

The AOP layer is the declarative form of the rule "mutate + `store()` under
the same lock" from the canonical concurrency treatment. See
`concurrency-and-locking` for the conceptual basis (why the rule exists, what
breaks without it, how it fits into the wider strategy ladder of
`XThreads.executeSynchronized` / `LockedExecutor` / `LockScope` / striped
helpers). This page is the Spring-specific reference.

## What the starter provides

`LockAspect` in
`org.eclipse.store.integrations.spring.boot.types.concurrent`. Active when
`spring-boot-starter-aop` is on the classpath.

## Annotations

### `@Read`

Acquire a shared (read) lock for the duration of the method. Multiple reads can
run concurrently.

### `@Write`

Acquire an exclusive (write) lock. Blocks reads and writes of the same lock
scope.

### `@Mutex(String name)`

Choose which lock to use. Applicable to methods or classes.

- Without `@Mutex`: all `@Read`/`@Write` share one global lock.
- `@Mutex("customers")` on a method: that method's read/write operates on the
  "customers" lock.
- `@Mutex("customers")` on a class: applies to every method unless overridden.

## Decision matrix

| Scenario | Annotations |
|---|---|
| Single aggregate, no other data | `@Read` / `@Write` (global lock) |
| Multiple aggregates, independent locking | `@Mutex("name")` per aggregate |
| Nested call: method A calls method B (both annotated) | Use the same `@Mutex` so `ReentrantReadWriteLock` allows re-entrance |
| Cross-aggregate atomic operation | `@Mutex` on one aggregate, call from inside the boundary of the other — or abandon AOP and use a manual `Storer` |

## Example — per-aggregate locks

```java
@Service
@Mutex("customers")
public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot root;

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = (AppRoot) s.root();
    }

    @Write
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        storage.store(root.customers());
    }

    @Read
    public Customer find(String email) {
        return root.customers().get(email);
    }
}

@Service
@Mutex("orders")
public class OrderService { ... }
```

Customer reads don't block order writes and vice versa.

## Example — override at method level

```java
@Service
@Mutex("customers")
public class CustomerService {

    @Write
    public void add(Customer c) { ... }

    // Special batch operation serialized globally, not just customers
    @Write @Mutex("global")
    public void bulkImport(List<Customer> all) { ... }
}
```

## Re-entrance

`ReentrantReadWriteLock` allows the same thread to re-acquire its lock. Calling
a `@Write`-annotated method from inside another `@Write`-annotated method on the
same lock is fine.

Calling `@Write` from inside `@Read` throws if the lock isn't the same thread
(would deadlock). Don't nest; restructure.

## Fairness

Default `ReentrantReadWriteLock` in `LockAspect` is non-fair. Under heavy load,
writers can starve readers briefly (or vice versa). For strict FIFO behaviour,
you'd need to replace `LockAspect` — out of scope for normal use.

## Without AOP

If your project doesn't use AOP, write the lock by hand:

```java
private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

public void add(Customer c) {
    lock.writeLock().lock();
    try {
        root.customers().put(c.email(), c);
        storage.store(root.customers());
    } finally {
        lock.writeLock().unlock();
    }
}
```

Same contract; more boilerplate.

## Testing

AOP advice is applied via proxies. In unit tests that don't go through the
Spring context (e.g., pure `new CustomerService(storage)`), the aspect is **not
active** — no locking happens. Either use `@SpringBootTest` for integration-
level behaviour or add a manual lock for tests.

## Common anti-patterns

### 1. `@Read` on a method that mutates

The mutation will proceed under the read lock — concurrent writers block this
thread but this thread's mutation is visible to other readers. Corrupts
invariants.

**Fix.** `@Write`, or restructure.

### 2. Long-running work in `@Write`

Blocks all other writers on the same lock for the entire duration. For big
imports, process offline then acquire the lock briefly.

### 3. Mixing `@Transactional` and `@Write`

`@Transactional` does nothing useful for Eclipse Store. Combining them can
confuse the framework's proxy chain. Pick one — `@Write` for Eclipse-Store-only
services; `@Transactional` only when you also touch a JDBC datasource.

### 4. Forgetting `spring-boot-starter-aop`

The `@Read`/`@Write`/`@Mutex` annotations are silently no-ops without it. No
warning, no error — just unsafe concurrent code.

**Fix.** Add the starter; it's a one-line dependency.
