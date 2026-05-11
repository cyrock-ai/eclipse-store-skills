# API catalogue — concurrency-and-locking

## JDK primitives (used by every strategy below)

`java.util.concurrent.locks.ReentrantReadWriteLock` is the foundation of every
helper Eclipse Store ships. The patterns here are familiar Java; what matters
is that the lock spans **both** the mutation and the `store()` call.

## Functional types used by the helpers

`LockedExecutor`, `LockScope`, and the striped variants accept lambdas typed
against Eclipse Serializer's own functional interfaces (not `java.util.function.*`):

| Type | Shape | Purpose |
|---|---|---|
| `org.eclipse.serializer.functional.Action` | `void execute()` | Side-effecting (write or void read). `Runnable`-shaped. **Does not declare `throws`** — wrap any checked exception inside the lambda as unchecked. |
| `org.eclipse.serializer.functional.Producer<R>` | `R produce()` | Value-returning (read). `Supplier`-shaped. **Does not declare `throws`** — same as `Action`. |

The skill's lambdas (`() -> { … }`, `() -> root.customers().get(id)`) are
inferred against these types — they look identical to JDK lambdas at the call
site.

## Eclipse Serializer — `XThreads`

Package: `org.eclipse.serializer.concurrency`. File:
`base/src/main/java/org/eclipse/serializer/concurrency/XThreads.java`.

| Symbol | Purpose |
|---|---|
| `XThreads.executeSynchronized(Runnable)` | Executes the runnable in a JVM-global synchronized block. Lowest-effort coarse-grained locking. No return value. |
| `XThreads.executeSynchronized(Supplier<T>) : T` | Same, with a return value. Note: the parameter type is `java.util.function.Supplier`, not Eclipse Serializer's `Producer`. |

`XThreads` wraps an internal monitor. Two threads calling
`executeSynchronized` are serialised against each other globally — there is
no per-region partitioning.

`XThreads` also exposes `start(...)`, `sleep(...)`, `executeDelayed(...)` —
those are general thread utilities, not concurrency primitives in this skill's
sense.

## Eclipse Store — `LockedExecutor`

Package: `org.eclipse.serializer.concurrency`. File:
`base/src/main/java/org/eclipse/serializer/concurrency/LockedExecutor.java`.

`LockedExecutor` is an **interface** with a default implementation. Each
instance owns its own `ReentrantReadWriteLock` — different `LockedExecutor`s
do not contend with each other.

| Symbol | Purpose |
|---|---|
| `LockedExecutor.New() : LockedExecutor` | Factory — creates a fresh instance backed by a `ReentrantReadWriteLock`. |
| `LockedExecutor.global() : LockedExecutor` | VM-wide singleton. **Use sparingly** — every caller of `.global()` shares one lock across the JVM, which is rarely the right granularity for an application. Prefer `New()` per protected region. |
| `read(Action) : void` | Run a side-effecting read under the read lock. |
| `read(Producer<R>) : R` | Run a value-returning read under the read lock. |
| `write(Action) : void` | Run a side-effecting write under the write lock. Exclusive. |
| `write(Producer<R>) : R` | Run a value-returning write under the write lock. |

Hold one `LockedExecutor` per protected region (one per aggregate, one per
tenant, etc.) if you want partitioned locking without striping.

## Eclipse Store — `LockScope`

Same package. `LockScope` is an **abstract class** — the inheritance-based
form of `LockedExecutor`: extend it from your domain class to get
`read(...)` / `write(...)` methods inline.

```java
public class CustomerService extends LockScope {
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

The inherited `read(...)` and `write(...)` methods are `protected` — only
callable from within the inheriting class. Each `LockScope` instance lazily
creates its own `LockedExecutor` (and therefore its own
`ReentrantReadWriteLock`) on first use, so two services extending `LockScope`
do not share a lock.

## Eclipse Store — striped variants

Files: `base/src/main/java/org/eclipse/serializer/concurrency/StripeLockedExecutor.java`
and `StripeLockScope.java`.

| Symbol | Purpose |
|---|---|
| `StripeLockedExecutor.New(int stripeCount)` | Factory — `LockedExecutor` with `stripeCount` independent RW locks; the caller picks a stripe by passing a `mutex` key. |
| `StripeLockedExecutor.global()` | VM-wide singleton with `Runtime.getRuntime().availableProcessors()` stripes. Same caveat as `LockedExecutor.global()`. |
| `read(Object mutex, Action)` / `read(Object mutex, Producer<R>)` | Read under the stripe selected by `abs(mutex.hashCode()) % stripeCount`. |
| `write(Object mutex, Action)` / `write(Object mutex, Producer<R>)` | Same for write. |
| `StripeLockScope` | Abstract class — inheritance form of the above. The inherited `read(...)` / `write(...)` are `protected`. |

The striped helpers are right when:

- the workload partitions naturally (per-tenant, per-shard, per-customer),
- threads working on different stripes do not need to coordinate, and
- the hot path stays inside a single stripe.

When two stripes need to be locked together, you are back to the
cross-aggregate problem — striping does not help.

## Spring Boot — declarative annotations

Package: `org.eclipse.store.integrations.spring.boot.types.concurrent`.

Files (all under
`integrations/spring-boot3/src/main/java/org/eclipse/store/integrations/spring/boot/types/concurrent/`):

| Annotation | `@Target` | Purpose |
|---|---|---|
| `@Read` | `METHOD` | Read-lock around the method body. No attributes. |
| `@Write` | `METHOD` | Write-lock around the method body. No attributes. |
| `@Mutex(String value)` | `TYPE`, `METHOD` | Named lock scope. The attribute is `value` (positional, e.g. `@Mutex("customers")`). Method-level `@Mutex` overrides class-level. Without **any** `@Mutex`, the aspect uses a single VM-wide global lock. With `@Mutex("X")`, methods sharing the name `X` share an independent lock from methods under other names. |

All three are `@Retention(RUNTIME)`.

Implementation: `LockAspect` (Spring AOP). Activation is gated by
`@Conditional(LockAspect.AspectJCondition.class)` — AspectJ must be on the
classpath, most simply by depending on `spring-boot-starter-aop`. Without it,
the annotations are silently ignored.

The locks are `ReentrantReadWriteLock` instances managed by the aspect — a
`ConcurrentHashMap<String, ReentrantReadWriteLock>` keyed by `@Mutex` value,
plus one global lock for un-`@Mutex`'d methods. Re-entrance works; nested
calls between two annotated methods sharing the same `@Mutex` name will not
deadlock.

See the `spring-boot` skill for setup, profile configuration, and
per-aggregate patterns.

## What is **not** a concurrency primitive

| Symbol | Why it isn't |
|---|---|
| Storage channels (`channel-count`) | Internal I/O threads. They parallelise the library's reads/writes but do not synchronise application threads. |
| The lock file (`lock-file-name`, `Storage Lock File`) | Process-level — prevents two JVMs from opening the same storage. Has no effect on threads inside a single JVM. |
| `EmbeddedStorageManager.store(...)` | Atomic for *durability* (all-or-nothing on disk) **per call**. Not *isolation* (the in-memory graph it traverses is unprotected). **Two consecutive `store()` calls are not atomic together** — use `storeAll(Object...)` / `storeAll(Iterable<?>)` for multi-object durable atomicity. |
| `Threaded<E>` / `ThreadedInstantiating<E>` | Thread-local-context utilities in `org.eclipse.serializer.concurrency`. Not application-level locking primitives — used internally for per-thread state. |
| `ThreadSafe` / `Synchronized` (marker interfaces) | Documentation markers. They do not enforce anything. |

## Thread-safety summary

| Object | Safe to share? |
|---|---|
| `EmbeddedStorageManager` | yes — the manager itself is the API; you'll typically have one per storage |
| `EmbeddedStorageFoundation` | yes — used to build the manager |
| `Storer` (any flavour) | **no** — single-threaded; one per thread that wants to commit |
| `BatchStorer` | **no** — same as `Storer`; the `AutoCloseable` close is what makes it different |
| `Serializer` | **no** — confine to one thread |
| `SerializerFoundation` | yes — used to build serializers |
| `GigaMap<E>` | yes — internal RW lock; `gigaMap.store()` is a `synchronized` method on the instance |
| `Lazy<T>` | yes — concurrent `get()` / `clear()` are safe |
| `Cache<K, V>` | yes — JCache contract |
| The application's object graph | **no** — your responsibility |

Note: the Javadoc on `org.eclipse.serializer.persistence.types.Storer` and
`org.eclipse.serializer.persistence.types.BatchStorer` does not currently
spell out the single-thread requirement; the rule is documented in
`docs/modules/intro/pages/concurrent-access.adoc` and is enforced by the
internal state these types hold (a per-instance object registry view, write
buffers, and type handlers).

## Where these types live

- `XThreads`, `LockedExecutor`, `LockScope`, `StripeLockedExecutor`,
  `StripeLockScope`, `Threaded`, `ThreadedInstantiating`, `ThreadSafe`,
  `Synchronized` → `org.eclipse.serializer.concurrency` (eclipse-serializer
  base module).
- `Action`, `Producer<R>` → `org.eclipse.serializer.functional`.
- `@Read`, `@Write`, `@Mutex`, `LockAspect`
  → `org.eclipse.store.integrations.spring.boot.types.concurrent`.
- `Storer`, `BatchStorer` → `org.eclipse.serializer.persistence.types`.
- `Lazy<T>` → `org.eclipse.serializer.reference`.
- `GigaMap<E>` → `org.eclipse.store.gigamap.types`.
