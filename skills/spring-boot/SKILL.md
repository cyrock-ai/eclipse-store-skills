---
name: spring-boot
description: >
  Guide Claude on integrating Eclipse Store into Spring Boot 3 applications —
  the `integrations-spring-boot3` starter, `org.eclipse.store.*` configuration
  properties, auto-wiring `EmbeddedStorageManager`, designing the root bean, and
  the `@Read` / `@Write` / `@Mutex` AOP aspects that wrap mutation + store under
  the same lock. This skill should be used when the user asks to "set up Eclipse
  Store in Spring Boot", "use Spring Boot starter", "@Autowired EmbeddedStorageManager",
  "auto-create-default-storage", "org.eclipse.store.root", "application.properties
  for Eclipse Store", "@Read", "@Write", "@Mutex", "LockAspect", "Spring REST
  console for Eclipse Store", or needs help wiring cloud storage credentials
  through Spring config.
version: 0.1.0
---

# Eclipse Store — Spring Boot 3 Integration

The `integrations-spring-boot3` starter wires Eclipse Store into Spring Boot:
properties-based configuration, auto-created beans, AOP aspects for concurrent
access, and an optional REST console. The patterns here differ from the
standalone storage skills because Spring owns bean lifecycle — but the
fundamentals (root, `store()`, lazy loading, housekeeping) are identical.

## When to use this skill

- User is building a Spring Boot 3 app that persists with Eclipse Store.
- User is **designing or wiring a `@Service` / `@Repository` / `@Component`
  bean that touches persistent state** — `@Read` / `@Write` / `@Mutex`
  placement is part of the bean's contract and is decided here, not bolted
  on after a concurrency bug.
- User asks about `org.eclipse.store.*` properties.
- User wants to inject an `EmbeddedStorageManager`.
- User is confused about `@Transactional` vs. `store()` (Spring's transactions
  do not flush Eclipse Store).
- User needs thread-safe mutation + store at method granularity.
- User wants the REST console (read-only storage browser).

**Route elsewhere** when:

- User is writing a standalone (non-Spring) app → `getting-started` and friends.
- User wants JCache caching via Spring (`@Cacheable`) → `cache-jcache`.
- User wants CDI / Jakarta EE instead of Spring → not in v0.1.0 of this plugin.

## Mental model

The starter registers:

- An `EmbeddedStorageFoundationFactory` bean that reads `org.eclipse.store.*`
  properties and builds a foundation.
- A singleton `EmbeddedStorageManager` bean (if
  `org.eclipse.store.auto-create-default-storage=true`, the default).
- The root bean, instantiated from the class named in `org.eclipse.store.root`
  via its public no-arg constructor.
- A `LockAspect` that wraps `@Read` / `@Write` / `@Mutex`-annotated methods in
  a `ReentrantReadWriteLock`.

Boot sequence:

1. Spring instantiates your root class (needs public no-arg constructor).
2. Eclipse Store populates its fields from disk.
3. `EmbeddedStorageManager` bean is ready; others can `@Autowired` it.

Spring `@Transactional` does **nothing** for Eclipse Store. You still call
`storage.store(modifiedObject)` (or `gigaMap.store()`) yourself.

## Maven setup

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>integrations-spring-boot3</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>

<!-- Required if you use @Read/@Write/@Mutex AOP -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>

<!-- Optional: REST console (read-only browser) -->
<!-- Vaadin + REST adapter -->
```

## Core properties

All under prefix `org.eclipse.store`:

| Property | Default | Purpose |
|---|---|---|
| `root` | — | FQCN of the root class. Required for auto-create. |
| `auto-start` | `true` | Start the storage manager at app startup. |
| `auto-create-default-storage` | `true` | Create an `EmbeddedStorageManager` bean. |
| `storage-directory` | `storage` | Where the data lives. |
| `deletion-directory` | unset | Move deleted files here. |
| `truncation-directory` | unset | Move truncated files here. |
| `backup-directory` | unset | Continuous backup target. |
| `channel-count` | `1` | Parallel channels (power of 2). |
| `housekeeping-*` | defaults | Same as the storage config properties. |
| `data-file-*` | defaults | Same as the storage config properties. |
| `rest.enabled` | `false` | Enable the REST browser console. |

Cloud storage properties live under
`org.eclipse.store.storage-filesystem.*` and
`org.eclipse.store.backup-filesystem.*` — same shape as the `configuration` skill
covers, with Spring-native `@NestedConfigurationProperty` for AWS S3, Azure Blob,
GCP Firestore, etc.

Spring Boot's `application.properties` example:

```properties
org.eclipse.store.auto-start=true
org.eclipse.store.root=com.example.AppRoot
org.eclipse.store.storage-directory=data
org.eclipse.store.channel-count=2
org.eclipse.store.backup-directory=backup
```

## AOP aspects

Package: `org.eclipse.store.integrations.spring.boot.types.concurrent`.

| Annotation | Effect |
|---|---|
| `@Read` | Acquire a shared (read) lock around the method. |
| `@Write` | Acquire an exclusive (write) lock. |
| `@Mutex("name")` | Named lock — methods with the same name share a lock; different names are independent. Applicable at class or method level. |

Without an explicit name, `@Read`/`@Write` share a single global
`ReentrantReadWriteLock`. With `@Mutex("orders")`, orders-related methods are
serialized independently of customers.

**The contract.** This is the declarative form of the rule from
`concurrency-and-locking`: the lock spans both the mutation **and** the
`store()` call. Both must be inside the annotated method body. A method that
mutates and returns, with `store()` deferred to a caller, is broken even if
the caller is also annotated — the lock has been released and re-acquired
between the two steps, and another thread can interleave.

Re-entrance works: a `@Write` method calling another `@Write` method on the
same `@Mutex` does not deadlock (`ReentrantReadWriteLock` allows it).

## Idiomatic patterns

### Pattern A — Minimal setup

`application.properties`:

```properties
org.eclipse.store.root=com.example.AppRoot
org.eclipse.store.storage-directory=data
```

`AppRoot.java`:

```java
package com.example;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AppRoot {
    public AppRoot() {}    // public no-arg constructor required by Spring

    private final Map<String, Customer> customersById = new HashMap<>();
    private final List<Order>           orders        = new ArrayList<>();

    public Map<String, Customer> customers() { return customersById; }
    public List<Order>           orders()    { return orders; }
}
```

`CustomerService.java`:

```java
@Service
public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot                root;

    public CustomerService(EmbeddedStorageManager storage) {
        this.storage = storage;
        this.root    = (AppRoot) storage.root();
    }

    @Write
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        storage.store(root.customers());   // YOU call store; Spring doesn't
    }

    @Read
    public Customer find(String email) {
        return root.customers().get(email);
    }
}
```

### Pattern B — `@Mutex` for aggregate-level locking

Separate lock per aggregate — reads on customers don't block writes on orders.

```java
@Service
public class OrderService {

    @Write @Mutex("orders")
    public void place(Order o) {
        root.orders().add(o);
        storage.store(root.orders());
    }

    @Read @Mutex("orders")
    public Order find(String id) {
        return root.orders().stream()
            .filter(o -> o.id().equals(id)).findFirst().orElse(null);
    }
}

@Service
public class CustomerService {

    @Write @Mutex("customers")
    public void add(Customer c) { ... }

    @Read @Mutex("customers")
    public Customer find(String id) { ... }
}
```

`@Mutex` at class level applies to all methods by default.

### Pattern C — Cloud storage via properties

```properties
org.eclipse.store.storage-filesystem.aws.s3.credentials.type=default
org.eclipse.store.storage-filesystem.aws.s3.region=eu-north-1
org.eclipse.store.storage-directory=my-bucket/prod-data
```

Spring Boot's relaxed binding handles camelCase too. Profiles allow
per-environment overrides; dev uses local, prod uses S3.

### Pattern D — Custom foundation (advanced)

If you need to register custom type handlers, plug into the foundation:

```java
@Configuration
public class StorageConfig {

    @Bean
    public StorageContextInitializer storageContextInitializer() {
        return foundation -> foundation.onConnectionFoundation(cf -> {
            cf.registerCustomTypeHandler(new MoneyHandler());
            cf.registerCustomTypeHandler(new ZoneIdHandler());
        });
    }
}
```

`StorageContextInitializer` is called before the manager starts.

### Pattern E — Disable auto-start (manual control)

```properties
org.eclipse.store.auto-start=false
```

Inject the manager, call `.start()` yourself when ready. Useful if your root
bean needs DB lookups before Eclipse Store is started.

### Pattern F — REST console (read-only browser)

```properties
org.eclipse.store.rest.enabled=true
```

Adds a `/store-console` HTTP endpoint for browsing the object graph. Useful for
ops debugging.

**In production:** off by default. If you need it for operations, place it
behind authentication (Spring Security or equivalent) and restrict it to an
internal network. The protocol is read-only, but the data exposed is your
application's data — the same access controls that govern the application as
a whole must govern this endpoint. The bundled Client GUI is a development
tool and should not be exposed publicly. See `configuration` →
`references/dev-test-staging-prod.md` for the per-environment matrix.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Relying on `@Transactional`

```java
// WRONG
@Service
public class CustomerService {
    @Transactional
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        // no store() — Spring's @Transactional does nothing for Eclipse Store
    }
}
```

**Fix.** Call `storage.store(root.customers())` explicitly.

### Anti-pattern 2 — No `@Write` on mutating methods

```java
// WRONG
@Service
public class CustomerService {
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        storage.store(root.customers());
    }
}
```

Concurrent adds race. Without `@Write` (or a manual lock), you get corruption.

**Fix.** `@Write` on every mutating public service method.

### Anti-pattern 3 — Root class with no public no-arg constructor

```java
// WRONG
public class AppRoot {
    private final String tenant;
    public AppRoot(String tenant) { this.tenant = tenant; }   // Spring fails
}
```

**Fix.** Add a public no-arg constructor. Eclipse Store doesn't need it, but
Spring does.

### Anti-pattern 4 — Multiple `EmbeddedStorageManager` beans pointing at the same directory

Same rule as standalone: one live manager per directory. With Spring, it is easy
to accidentally define two beans (e.g., via a second `@Configuration`).

**Fix.** Rely on the default auto-created bean. If you need a second database,
give it a different directory *and* name, and use `@Qualifier` to inject the
right one.

### Anti-pattern 5 — Long-running work under `@Write`

```java
@Write
public void importBigFile(File f) {
    // 30 minutes of work holding the write lock
}
```

**Fix.** Parse outside the lock, prepare a batch, then acquire the lock for a
short mutation window:

```java
public void importBigFile(File f) {
    List<Customer> batch = parseOffline(f);
    applyBatch(batch);
}

@Write
private void applyBatch(List<Customer> batch) {
    batch.forEach(c -> root.customers().put(c.email(), c));
    storage.store(root.customers());
}
```

### Anti-pattern 6 — Two independent `@Write` methods that should be atomic

```java
// WRONG
orderService.placeOrder(o);         // @Write on "orders"
customerService.incrementStats(c);  // @Write on "customers"
// between the two, a crash breaks invariants
```

**Fix.** Wrap the cross-aggregate operation in one method that stages both
mutations and calls `storage.store(...)` once, inside a single lock scope (may
need a manual `Storer` to persist both atomically).

## Pitfalls & gotchas

1. **Spring needs a public no-arg constructor on the root class.** Eclipse
   Store doesn't, but the starter uses Spring reflection.
2. **AOP requires `spring-boot-starter-aop`.** Without it, `@Read/@Write/@Mutex`
   are silently ignored — no warning.
3. **`@Transactional` is for databases.** Eclipse Store isn't a JDBC data
   source; it ignores transaction manager boundaries.
4. **Don't mix Eclipse Store with Spring Data JPA expectations.** It's not a
   repository-based ORM; no `findAll`, no `save` semantics.
5. **Relaxed property binding works but be consistent.** Pick either kebab-case
   (`storage-directory`) or camelCase (`storageDirectory`); don't mix within
   one profile file.
6. **REST console: protocol is read-only, data is not.** Writes via the
   console are not supported, but the data exposed is your application's data.
   The same access controls (auth, network isolation) that govern the
   application must govern this endpoint. Off by default in production; only
   enable behind authentication and an internal network.
7. **Cloud SDK version compatibility.** Spring Boot may pull in an older S3 SDK;
   the `afs-aws-s3` artifact doesn't pin one. Verify compatibility; override
   in your parent pom if needed.
8. **`StorageContextInitializer` runs once, early.** If you need request-scope
   customization, you're on the wrong path — rethink the design.
9. **Auto-created storage uses `EmbeddedStorageFoundationFactory`.** Replacing
   it with your own `@Primary` bean lets you fully customize, but you lose the
   cloud property wiring the factory provides.

## Interactions with other skills

- **`root-and-object-graph`** — same design rules; Spring cares about
  constructors.
- **`storing-data`** — same `store(...)` rules. `@Transactional` irrelevant.
- **`concurrency-and-locking`** — the conceptual basis for `@Read` /
  `@Write` / `@Mutex`. The AOP layer is the declarative form of the rule
  "mutate + store under the same lock"; the canonical treatment, the
  thread-safety matrix, the strategy ladder, and the GigaMap-specific story
  all live there.
- **`configuration`** — the underlying config properties are the same, but the
  property **prefix differs**: Spring uses `org.eclipse.store.*`; standalone uses
  the bare property names. Per-environment recommendations (Dev / Test /
  Staging / Prod for backups, channel count, JMX, REST) are documented
  there.
- **`custom-type-handlers`** — register via `StorageContextInitializer`.
- **`storage-targets-afs`** — cloud credentials flow through Spring properties,
  routed into the AFS layer automatically.
- **`cache-jcache`** — orthogonal; a Spring app can use both Eclipse Store (data
  store) and JCache over Eclipse Store (`@Cacheable`).

## Recipes

**"Minimal Spring Boot app with Eclipse Store?"** → Pattern A.

**"How do I get the typed root?"** → Cast once in the service's
constructor: `this.root = (AppRoot) storage.root()`. Hold it in a field.

**"Do I really need `@Write`?"** → Yes for any mutating service method, unless
you have manual locks.

**"How do I test without writing to disk?"** → Use a `@TestConfiguration` with
a temp-dir property:

```java
@TestConfiguration
static class TestConfig {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry reg) {
        reg.add("org.eclipse.store.storage-directory",
            () -> java.nio.file.Files.createTempDirectory("es").toString());
    }
}
```

**"How do I run with profiles?"** → `application-dev.properties`,
`application-prod.properties` with different `storage-directory` /
`storage-filesystem.*` entries. Standard Spring profiles.

**"Can I have two Eclipse Store databases?"** → Yes, but you'll need to define
a second `EmbeddedStorageFoundationFactory` (or build the second manager
manually) and qualify the beans. Not supported as a first-class feature; plan
carefully.

**"What if my root class has dependencies (e.g., services)?"** → It shouldn't.
The root is pure data. Inject services into your service layer; the root
contains what you persist, not what uses it.

**"How do I trigger a backup?"** → Configure `backup-directory`. Eclipse Store
backs up continuously.

**"Can I listen to startup events to seed data?"** → Yes:
`@EventListener(ApplicationReadyEvent.class)`. At that point the storage is
started; call `storage.store(...)` normally.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — bean types, properties, AOP annotations.
- `references/properties-reference.md` — every `org.eclipse.store.*` property.
- `references/aop-aspects.md` — `@Read`/`@Write`/`@Mutex` deep dive.
- `references/advanced-foundation-override.md` — replacing the foundation
  factory, custom type handlers, read-only mode.
- `references/examples-expanded.md` — five full Spring Boot apps.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer.

## Upstream sources

- `integrations/spring-boot3/` — the starter source.
- `examples/spring-boot3-simple/`, `examples/spring-boot3-advanced/` — runnable
  examples.
- `integrations/spring-boot3-console/` — REST console.
