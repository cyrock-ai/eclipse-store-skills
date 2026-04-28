# API catalogue — concurrency-and-locking

## JDK primitives (used by every strategy below)

`java.util.concurrent.locks.ReentrantReadWriteLock` is the foundation of every
helper Eclipse Store ships. The patterns here are familiar Java; what matters
is that the lock spans **both** the mutation and the `store()` call.

## Eclipse Serializer — `XThreads`

Package: `org.eclipse.serializer.concurrency`.

| Symbol | Purpose |
|---|---|
| `XThreads.executeSynchronized(Runnable)` | Executes the runnable in a JVM-global synchronized block. Lowest-effort coarse-grained locking. No return value. |
| `XThreads.executeSynchronized(Supplier<T>) : T` | Same, with a return value. |

`XThreads` wraps an internal monitor. Two threads calling
`executeSynchronized` are serialised against each other globally — there is
no per-region partitioning.

## Eclipse Store — `LockedExecutor`

Package: `org.eclipse.store.afs.types` (re-exported in the storage module).

| Symbol | Purpose |
|---|---|
| `LockedExecutor.New() : LockedExecutor` | Factory — creates an executor backed by a fresh `ReentrantReadWriteLock`. |
| `executor.read(Supplier<T>) : T` | Run the supplier under the read lock. Multiple readers proceed in parallel. |
| `executor.read(Runnable) : void` | Read-lock variant for side-effecting reads. |
| `executor.write(Supplier<T>) : T` | Run under the write lock. Exclusive. |
| `executor.write(Runnable) : void` | Write-lock variant. |

A `LockedExecutor` is a single RW lock. Hold one per protected region (one per
aggregate, one per tenant, etc.) if you want partitioned locking without
striping.

## Eclipse Store — `LockScope`

Same package. `LockScope` is the inheritance-based form of `LockedExecutor`:
extend it from your domain class to get `read(...)` / `write(...)` methods
inline.

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

Each instance holds its own RW lock — different services do not contend.

## Eclipse Store — striped variants

| Symbol | Purpose |
|---|---|
| `StripeLockedExecutor.New(int stripes)` | `LockedExecutor` with `stripes` independent RW locks; the caller picks a stripe (typically by hash). |
| `StripeLockScope` | Inheritance form of the above. |

The striped helpers are right when:

- the workload partitions naturally (per-tenant, per-shard, per-customer),
- threads working on different stripes do not need to coordinate, and
- the hot path stays inside a single stripe.

When two stripes need to be locked together, you are back to the
cross-aggregate problem — striping does not help.

## Spring Boot — declarative annotations

Package: `org.eclipse.store.integrations.spring.boot.types.concurrent`.

| Annotation | Target | Purpose |
|---|---|---|
| `@Read` | method | Read-lock around the method body. |
| `@Write` | method | Write-lock around the method body. |
| `@Mutex(String name)` | class or method | Named lock scope. Without a name, all `@Read` / `@Write` share one global lock; with a name, methods sharing the name share a lock independent of other names. |

Implementation: `LockAspect` (Spring AOP). Active when
`spring-boot-starter-aop` is on the classpath; without it, the annotations are
silently ignored.

The locks are `ReentrantReadWriteLock` instances managed by the aspect — one
per name (or one global if unnamed). Re-entrance works; nested calls between
two annotated methods sharing the same `@Mutex` will not deadlock.

See the `spring-boot` skill for setup, profile configuration, and per-aggregate
patterns.

## What is **not** a concurrency primitive

| Symbol | Why it isn't |
|---|---|
| Storage channels (`channel-count`) | Internal I/O threads. They parallelise the library's reads/writes but do not synchronise application threads. |
| The lock file (`lock-file-name`, `Storage Lock File`) | Process-level — prevents two JVMs from opening the same storage. Has no effect on threads inside a single JVM. |
| `EmbeddedStorageManager.store(...)` | Atomic for *durability* (all-or-nothing on disk), not *isolation* (the in-memory graph it traverses is unprotected). |

## Thread-safety summary

| Object | Safe to share? |
|---|---|
| `EmbeddedStorageManager` | yes — the manager itself is the API; you'll typically have one per storage |
| `EmbeddedStorageFoundation` | yes — used to build the manager |
| `Storer` (any flavour) | **no** — single-threaded; one per thread that wants to commit |
| `BatchStorer` | **no** — same as `Storer`; the `AutoCloseable` close is what makes it different |
| `Serializer` | **no** — confine to one thread |
| `SerializerFoundation` | yes — used to build serializers |
| `GigaMap<E>` | yes — internal RW lock |
| `Lazy<T>` | yes — concurrent `get()` / `clear()` are safe |
| `Cache<K, V>` | yes — JCache contract |
| The application's object graph | **no** — your responsibility |

## Where these types live

- `XThreads` → `org.eclipse.serializer.concurrency`
- `LockedExecutor`, `LockScope`, `StripeLockedExecutor`, `StripeLockScope`
  → `org.eclipse.store.afs.types` (helper module re-exported by storage)
- `@Read`, `@Write`, `@Mutex`, `LockAspect`
  → `org.eclipse.store.integrations.spring.boot.types.concurrent`
- `Storer`, `BatchStorer` → `org.eclipse.serializer.persistence.types` /
  `org.eclipse.store.storage.types`
- `Lazy<T>` → `org.eclipse.serializer.reference`
- `GigaMap<E>` → `org.eclipse.store.gigamap.types`

Verify against the upstream source — class paths are stable but artifact
boundaries occasionally shift between versions.
