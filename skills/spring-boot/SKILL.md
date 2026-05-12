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
version: 0.2.0
---

# Eclipse Store — Spring Boot 3 Integration

The `integrations-spring-boot3` starter wires Eclipse Store into Spring Boot:
properties-based configuration, auto-created beans, AOP aspects for concurrent
access, and an optional REST console. The patterns here differ from the
standalone storage skills because Spring owns bean lifecycle — but the
fundamentals (root, `store()`, lazy loading, housekeeping) are identical.

## Do NOT use this skill

- Standalone (non-Spring) app → `getting-started` and friends.
- JCache caching via Spring (`@Cacheable`) → `cache-jcache`.
- CDI / Jakarta EE instead of Spring — not yet covered by this plugin.

## Mental model

The starter registers:

- An `EmbeddedStorageFoundationFactory` bean that reads `org.eclipse.store.*`
  properties and builds a foundation.
- A singleton `EmbeddedStorageManager` bean (if
  `org.eclipse.store.auto-create-default-storage=true`, the default).
- The root instance — **only when `org.eclipse.store.root` is set**; the factory
  reflects the no-arg ctor. Otherwise provide the root via Pattern D.
- A `LockAspect` that wraps `@Read` / `@Write` / `@Mutex`-annotated methods in
  a `ReentrantReadWriteLock`.

Boot sequence:

1. Starter reflects root's no-arg ctor (only when `org.eclipse.store.root` is set;
   otherwise root comes from your bean).
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

<!-- Optional: REST console (read-only browser) — see Pattern F -->
```

## Core properties

All under prefix `org.eclipse.store`:

| Property | Default | Purpose |
|---|---|---|
| `root` | — | FQCN of the root class. Required for auto-create. Bound to a `Class<?>` field. |
| `auto-start` | `true` | Start the storage manager at app startup. |
| `auto-create-default-foundation` | `true` | Create the default `EmbeddedStorageFoundationSupplier` bean. |
| `auto-create-default-storage` | `true` | Create an `EmbeddedStorageManager` bean. |
| `register-jdk8-handlers` | `false` | Register the optional JDK 8 binary handlers. |
| `storage-directory` | `storage` | Where the data lives. |
| `deletion-directory` | unset | Move deleted files here. |
| `truncation-directory` | unset | Move truncated files here. |
| `backup-directory` | unset | Continuous backup target. |
| `channel-count` | `1` | Parallel channels (power of 2). |
| `housekeeping-*` | defaults | Same as the storage config properties. |
| `data-file-*` | defaults | Same as the storage config properties. |
| `console.ui.enabled` | `true` (when console artifact is present) | Vaadin REST console. Adding `integrations-spring-boot3-console` auto-enables it. |

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
    public AppRoot() {}    // starter reflects this ctor (org.eclipse.store.root path)

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
        this.root    = storage.root();
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

### Pattern D — Custom foundation configuration

When properties aren't enough, define the `EmbeddedStorageManager` bean yourself.
The default manager is `@ConditionalOnMissingBean`, so it steps aside; the default
foundation supplier still exists but goes unused. You inject the same
property-driven factory the starter uses, build the foundation, configure it,
and hand the manager back:

```java
@Configuration
public class StorageConfig {

    private final EclipseStoreProperties           props;
    private final EmbeddedStorageFoundationFactory foundationFactory;
    private final EmbeddedStorageManagerFactory    managerFactory;

    public StorageConfig(
        EclipseStoreProperties           props,
        EmbeddedStorageFoundationFactory foundationFactory,
        EmbeddedStorageManagerFactory    managerFactory
    ) {
        this.props             = props;
        this.foundationFactory = foundationFactory;
        this.managerFactory    = managerFactory;
    }

    @Bean
    public EmbeddedStorageManager storage() {
        EmbeddedStorageFoundation<?> foundation =
            foundationFactory.createStorageFoundation(props);
        foundation.onConnectionFoundation(cf -> {
            // Apply connection-foundation customizations here.
        });
        return managerFactory.createStorage(foundation, props.isAutoStart());
    }
}
```

`StorageContextInitializer` is a no-arg hook (`void initialize()`) that fires
*before* the foundation is built — it receives no `EmbeddedStorageFoundation`
reference. Use it only for global side-effects (e.g. installing a custom
`LazyReferenceManager`) that don't need the foundation.

### Pattern E — Disable auto-start (manual control)

```properties
org.eclipse.store.auto-start=false
```

Inject the manager, call `.start()` yourself when ready. Useful if your root
bean needs DB lookups before Eclipse Store is started.

### Pattern F — REST console (read-only browser)

Add the artifact:

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>integrations-spring-boot3-console</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

The console auto-activates (`org.eclipse.store.console.ui.enabled=true` by default).
To disable explicitly:

```properties
org.eclipse.store.console.ui.enabled=false
```

Adds a Vaadin UI for browsing the object graph. Useful for ops debugging.

**In production:** disable or place behind auth and an internal network. The
protocol is read-only but the data is your application's data — see
pitfall #11.

### Pattern G — Multiple storages (`@Qualifier`)

When the app needs more than one independent database, qualifiers stop being
optional. Disable the defaults, bind one `EclipseStoreProperties` per prefix,
and produce a named manager for each.

```properties
org.eclipse.store.auto-create-default-foundation=false
org.eclipse.store.auto-create-default-storage=false

org.eclipse.store.orders.root=com.example.OrdersRoot
org.eclipse.store.orders.storage-directory=data/orders

org.eclipse.store.inventory.root=com.example.InventoryRoot
org.eclipse.store.inventory.storage-directory=data/inventory
```

```java
@Configuration
public class StorageConfig {
    private final EmbeddedStorageFoundationFactory foundationFactory;
    private final EmbeddedStorageManagerFactory    managerFactory;

    public StorageConfig(
        EmbeddedStorageFoundationFactory foundationFactory,
        EmbeddedStorageManagerFactory    managerFactory
    ) {
        this.foundationFactory = foundationFactory;
        this.managerFactory    = managerFactory;
    }

    @Bean("orders")    @ConfigurationProperties("org.eclipse.store.orders")
    EclipseStoreProperties ordersProperties()    { return new EclipseStoreProperties(); }

    @Bean("inventory") @ConfigurationProperties("org.eclipse.store.inventory")
    EclipseStoreProperties inventoryProperties() { return new EclipseStoreProperties(); }

    @Bean @Qualifier("orders")
    EmbeddedStorageManager ordersStore(@Qualifier("orders") EclipseStoreProperties p) {
        return managerFactory.createStorage(
            foundationFactory.createStorageFoundation(p), p.isAutoStart());
    }

    @Bean @Qualifier("inventory")
    EmbeddedStorageManager inventoryStore(@Qualifier("inventory") EclipseStoreProperties p) {
        return managerFactory.createStorage(
            foundationFactory.createStorageFoundation(p), p.isAutoStart());
    }
}
```

Consumers inject by qualifier (`@Qualifier("orders") EmbeddedStorageManager s`).
Cross-storage operations are not atomic — design the domain so each write flows
into a single database. Full walkthrough in
`references/advanced-foundation-override.md` Pattern 4 (mirrors the upstream
`spring-boot3-advanced` example).

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

### Anti-pattern 2 — Mutation + `store()` outside any lock

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

Concurrent adds race; the in-memory mutation and the `store()` can interleave
across threads.

**Fix.** Wrap mutation and store together under one lock. Pick a mechanism and
apply it consistently — `@Write` (with `spring-boot-starter-aop`), a manual
`ReentrantReadWriteLock`, `synchronized`, or `XThreads.executeSynchronized`.
See `concurrency-and-locking` for the full strategy ladder.

### Anti-pattern 3 — Property-driven root with no accessible no-arg constructor

```java
// with org.eclipse.store.root=com.example.AppRoot
public class AppRoot {
    public AppRoot(String tenant) { ... }   // breaks reflective instantiation
}
```

The starter calls `rootClass.getDeclaredConstructor().newInstance()`. **Fix.**
Add `public AppRoot() {}`, or drop the property and build the manager yourself
(Pattern D — `foundation.setRoot(new AppRoot(tenantId))`). See
pitfalls-deep-dive #2.

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

1. **No-arg constructor required only on the `org.eclipse.store.root` path.**
   Eclipse Store itself never needs it; with Pattern D (manual manager) any
   constructor works.
2. **AOP requires `spring-boot-starter-aop`.** Without it, `@Read/@Write/@Mutex`
   are silently ignored — no warning.
3. **`@Transactional` is for databases.** Eclipse Store isn't a JDBC data
   source; it ignores transaction manager boundaries.
4. **Don't mix Eclipse Store with Spring Data JPA expectations.** It's not a
   repository-based ORM; no `findAll`, no `save` semantics.
5. **REST console: protocol is read-only, data is not.** Writes via the
   console are not supported, but the data exposed is your application's data.
   The same access controls (auth, network isolation) that govern the
   application must govern this endpoint. Off by default in production; only
   enable behind authentication and an internal network.
6. **`StorageContextInitializer` runs once, early.** If you need request-scope
   customization, you're on the wrong path — rethink the design.
7. **Auto-created storage stack: `EmbeddedStorageFoundationSupplier` →
   `EmbeddedStorageManager`**, both `@ConditionalOnMissingBean`. To customize the
   foundation, define your own `EmbeddedStorageManager` bean (Pattern D) — that
   alone steps the default manager aside and you keep the cloud property wiring.
   Replace the supplier instead only if you specifically need its lazy contract;
   replace the factory only when you must skip property-driven configuration
   entirely.
8. **`StorageContextInitializer.initialize()` has no foundation argument.**
   Don't use it for foundation tweaks — use the manager-bean pattern (D).

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
- **`custom-type-handlers`** — define and register handlers there; in Spring,
  hook them in via the `EmbeddedStorageFoundationSupplier` override (Pattern D).
- **`storage-targets-afs`** — cloud credentials flow through Spring properties,
  routed into the AFS layer automatically.
- **`cache-jcache`** — orthogonal; a Spring app can use both Eclipse Store (data
  store) and JCache over Eclipse Store (`@Cacheable`).

## Recipes

**"Minimal Spring Boot app with Eclipse Store?"** → Pattern A.

**"How do I get the typed root?"** → `this.root = storage.root();` in the
service constructor. Hold it in a typed field.

**"Do I really need `@Write`?"** → No, the AOP aspect is opt-in (it requires
`spring-boot-starter-aop` on the classpath). What is mandatory is that the
mutation and the matching `store()` run under the same lock. `@Read` / `@Write`
are one declarative way; `synchronized`, a manual `ReentrantReadWriteLock`, or
`XThreads.executeSynchronized` work just as well. Pick one mechanism per
codebase and apply it consistently — see `concurrency-and-locking` for the full
strategy ladder.

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

**"Can I have two Eclipse Store databases?"** → Yes — see Pattern G. The
`EmbeddedStorageFoundationFactory` is shared; you bind one `EclipseStoreProperties`
per prefix and produce a qualified `EmbeddedStorageManager` for each. The
upstream `spring-boot3-advanced` example demonstrates the same shape.

**"What if my root class has dependencies (e.g., services)?"** → It shouldn't.
The root is pure data. Inject services into your service layer; the root
contains what you persist, not what uses it.

**"How do I trigger a backup?"** → Configure `backup-directory`. Eclipse Store
backs up continuously.

**"Can I listen to startup events to seed data?"** → Yes:
`@EventListener(ApplicationReadyEvent.class)`. At that point the storage is
started; call `storage.store(...)` normally.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need the exact bean qualifier
  constants, the `LockAspect` internals, `EmbeddedStorageFoundationFactory` /
  `EmbeddedStorageManagerFactory` signatures, or the `StorageContextInitializer`
  hook contract.
- **Load `references/properties-reference.md`** when wiring a specific
  `org.eclipse.store.*` property — cloud backends (AWS S3 / Azure / GCP / Oracle
  Cloud / Redis / SQL credentials), nested AFS shapes, or non-obvious housekeeping
  / channel knobs.
- **Load `references/aop-aspects.md`** when designing concurrency boundaries —
  named-lock semantics, re-entrance rules, fairness, what happens without
  `spring-boot-starter-aop`.
- **Load `references/advanced-foundation-override.md`** when properties are
  insufficient — custom type handlers in Spring, read-only mode,
  multi-storage with `@Qualifier`, the upstream `spring-boot3-advanced`
  example shape.
- **Load `references/examples-expanded.md`** when you want a complete runnable
  Spring Boot app — full bootstrap with REST controller, `@Mutex`-per-aggregate
  service layer, profile-driven cloud storage, `@SpringBootTest` with
  `@DynamicPropertySource`.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a Spring-side bug
  — missing AOP starter, root-class no-arg-ctor failure, `@Transactional`
  confusion, two managers at the same directory, REST console in production.

## Upstream sources

- `integrations/spring-boot3/` — the starter source.
- `examples/spring-boot3-simple/`, `examples/spring-boot3-advanced/` — runnable
  examples.
- `integrations/spring-boot3-console/` — REST console.
