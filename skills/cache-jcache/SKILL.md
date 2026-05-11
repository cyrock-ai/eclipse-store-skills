---
name: cache-jcache
description: >
  Guide Claude on using Eclipse Store's JCache (JSR-107) provider — standalone
  caches, caches backed by an `EmbeddedStorageManager`, expiry and eviction
  policies, entry listeners, read-through / write-through with `CacheLoader` /
  `CacheWriter`, properties-file configuration, and integrations with
  Hibernate second-level cache and Spring's cache abstraction.

  **Apply this skill whenever a service / repository / facade method has an
  expensive read** (database query, HTTP call, cross-aggregate computation),
  whenever a Spring `@Service` is being designed and `@Cacheable` may apply,
  whenever a Hibernate model is being designed and a second-level cache is on
  the table, or whenever a read-heavy aggregate is being reviewed for
  performance. The decisions taken here — *which* operation to memoize, *what*
  TTL, persistent vs. ephemeral entries, cache-aside vs. read-through, where
  the cache lives in the bean graph — ossify in the service-layer signature
  the moment it is committed; retrofitting them later means changing every
  caller. Load this skill *before* a `@Cacheable` annotation or
  `JCacheManagerCustomizer` bean is added.

  Also use this skill when the user asks to "use JCache", "JSR-107",
  "Hibernate second-level cache", "@Cacheable", "JCacheManagerCustomizer",
  "CachingProvider", "CacheConfiguration.Builder", "CacheConfiguration.load",
  "eclipsestore-cache.properties", "storeByValue", "ModifiedExpiryPolicy",
  "AccessedExpiryPolicy", "EvictionManager.Interval",
  "EvictionPolicy.LeastRecentlyUsed", "CacheLoader", "CacheWriter",
  "read-through", "write-through", "cache-aside", "JMX cache stats",
  or "spring.jpa.properties.hibernate.cache.eclipsestore".
version: 0.4.0
---

# Eclipse Store — JCache (JSR-107) Cache

JSR-107 provider with optional persistence via `EmbeddedStorageManager`.
Integrates with Hibernate L2 cache and Spring Cache.

## Do NOT use this skill

- User wants a persistent **data store with queries**, not a cache
  → `getting-started`, `root-and-object-graph`, `storing-data`.
- User wants an **indexed large collection** (queries, full-text, vector
  search) → `gigamap`.
- User wants Spring Boot integration of Eclipse Store **as a database**
  → `spring-boot`.
- User wants concurrency / locking around their persistent graph
  → `concurrency-and-locking`.
- User wants the standalone serializer (no cache, no storage)
  → `serializer-standalone`.

## Mental model

Two uses of Eclipse Store as a JSR-107 provider:

1. **Standalone JCache** — a pure in-memory cache (not persistent) using the
   JCache standard `MutableConfiguration`. Use as a drop-in replacement for
   any other JSR-107 provider.
2. **Backed by Eclipse Store** — pass an `EmbeddedStorageManager` to Eclipse
   Store's `CacheConfiguration`. Cache entries are persisted through that
   storage, so restarting the JVM does not lose them.

A storage-backed cache **automatically acts as both `CacheReader` and
`CacheWriter`** — `readThrough` and `writeThrough` default to `true`. On
miss, the entry is loaded from storage; on `put`, it is written through.
You do not need to also configure a `CacheLoader` / `CacheWriter` to get
that behavior — it is built in. (You *can* layer your own `CacheLoader` for,
e.g., a database read-through; see Pattern I.)

Eclipse Store's `Cache<K,V>` and `CacheManager` extend the JCache types, so
they slot in anywhere a `javax.cache.Cache` / `javax.cache.CacheManager` is
expected. Eclipse Store-specific methods (`size()`, `putSilent(k,v)`,
`removeCache(name)`) are available when the narrowed return type of
`cacheManager.createCache(...)` is kept. With `storeByValue(false)` cache
values do not need to be `Serializable`.

## Maven setup

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>cache</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>

<!-- Transitively brings: jcache-api, storage-embedded -->

<!-- Optional: Hibernate L2 integration -->
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>cache-hibernate</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

## Core API

Standard JCache (JSR-107):

| Symbol | Purpose |
|---|---|
| `Caching.getCachingProvider()` | Default provider (works only with one impl on the classpath). |
| `Caching.getCachingProvider(String)` | Named provider — use with multi-impl classpaths. |
| `provider.getCacheManager()` | Get a `CacheManager`. |
| `cacheManager.createCache(name, config)` | Create. |
| `cacheManager.getCache(name, K.class, V.class)` | Retrieve typed. |
| `cache.put(k, v)` / `get(k)` / `remove(k)` | Standard JCache. |
| `MutableConfiguration<K,V>` | Standard config (no storage backing). |
| `CreatedExpiryPolicy`, `ModifiedExpiryPolicy`, `AccessedExpiryPolicy`, `EternalExpiryPolicy`, `TouchedExpiryPolicy` | Standard expiry policies. |
| `CacheLoader<K,V>` / `CacheWriter<K,V>` | Read-through / write-through SPI. |

Eclipse Store-specific (package `org.eclipse.store.cache.types`):

| Symbol | Purpose |
|---|---|
| `CachingProvider` (FQN `org.eclipse.store.cache.types.CachingProvider`) | The provider class — the magic string Spring / JCache discovery looks up. |
| `CacheConfiguration.Builder(K.class, V.class)` | Builder, no storage backing. |
| `CacheConfiguration.Builder(K.class, V.class, name, storageManager)` | Builder, storage-backed. |
| `CacheConfiguration.Builder(K.class, V.class, configuration)` | Builder from a serializer `Configuration`. |
| `CacheConfiguration.load(path, K.class, V.class)` | Load `CacheConfiguration` from a properties file. |
| `.expiryPolicyFactory(factory)` | Plug expiry. |
| `.evictionManagerFactory(factory)` | Plug eviction (Eclipse Store only). |
| `.cacheLoaderFactory(factory)` / `.cacheWriterFactory(factory)` | Read-through / write-through. |
| `.readThrough(true)` / `.writeThrough(true)` | Enable read/write-through. |
| `.storeByValue(false)` / `.storeByReference()` | Reference vs. value semantics. |
| `.enableStatistics()` / `.enableManagement()` | Stats + JMX. |
| `.serializerFoundation(foundation)` | Plug a custom Eclipse Serializer foundation. |
| `.build()` | Returns `CacheConfiguration<K,V>`. |
| `Cache<K,V>` (Eclipse Store) | Adds `size()`, `putSilent(k,v)`, `unwrap(...)`. |
| `CacheManager` (Eclipse Store) | Adds `removeCache(name)`. |
| `org.eclipse.store.cache.types.CacheStatisticsMXBean` | Returned by `cache.unwrap(CacheStatisticsMXBean.class)`. **Extends** `javax.cache.management.CacheStatisticsMXBean` — either FQN works as the `unwrap` target; the Eclipse Store one is a strict superset. |
| `EvictionManager.OnEntryCreation(policy)` | Evict on every put. |
| `EvictionManager.Interval(policy, intervalMs)` | Evict periodically. |
| `EvictionPolicy.LeastRecentlyUsed(maxSize)` | LRU policy. |
| `EvictionPolicy.LeastFrequentlyUsed(maxSize)` | LFU policy. |
| `EvictionPolicy.FirstInFirstOut(elementCount, maxSize)` | FIFO policy. |
| `EvictionPolicy.BiggestObjects(elementCount, maxSize)` | Evict largest entries first. |
| `CacheConfigurationPropertyNames` | Constants for the properties-file keys. |

## Idiomatic patterns

**Start here** — pick by the decision the user is making:

| If… | Use |
|---|---|
| In-memory only, JVM restart clears the cache | Pattern A (standalone) |
| Entries must survive restart | Pattern B (storage-backed) |
| Read-through to a non-storage source (DB, HTTP) | Pattern I (`CacheLoader`) |
| Plain cache-aside in service code | Pattern C (manual) |
| Spring `@Cacheable` integration | Pattern G |
| Hibernate second-level cache | Pattern H |
| Config from `eclipsestore-cache.properties` | Pattern J |

Patterns D (expiry), E (listeners), F (eviction) are orthogonal — combine
with whichever base pattern fits.

### Pattern A — Standalone (in-memory) JCache

```java
import javax.cache.*;
import javax.cache.configuration.*;
import javax.cache.expiry.*;

CachingProvider provider     = Caching.getCachingProvider();
CacheManager    cacheManager = provider.getCacheManager();

MutableConfiguration<Integer, String> cfg = new MutableConfiguration<Integer, String>()
    .setTypes(Integer.class, String.class)
    .setStoreByValue(false)                                        // (1)
    .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_MINUTE))
    .setStatisticsEnabled(true);

Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
cache.put(1, "Hello");
String v = cache.get(1);
```

(1) `setStoreByValue(false)` is reference-based — fastest. The JCache default
is `true` (defensive copies on every op).

JVM restart clears the cache.

### Pattern B — Storage-backed JCache

```java
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.cache.types.CacheConfiguration;

EmbeddedStorageManager storage = EmbeddedStorage.start();          // (1)

CachingProvider provider     = Caching.getCachingProvider();
CacheManager    cacheManager = provider.getCacheManager();

CacheConfiguration<Integer, String> cfg = CacheConfiguration
    .Builder(Integer.class, String.class, "jCache", storage)       // (2)
    .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_HOUR))
    .build();

Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
cache.put(1, "persists across restarts");
```

(1) The cache uses this storage manager as its `CacheReader` and
`CacheWriter`. `readThrough` and `writeThrough` default to `true`.
(2) `CacheConfiguration` extends `javax.cache.configuration.CompleteConfiguration`,
so it can be passed directly to `cacheManager.createCache(name, cfg)`.

**Method naming — builder vs `MutableConfiguration`.** The Eclipse Store
`CacheConfiguration.Builder` uses **unprefixed fluent** methods
(`.expiryPolicyFactory(...)`, `.storeByValue(...)`, `.readThrough(true)`,
`.enableStatistics()`). The JCache `MutableConfiguration` (Pattern A)
uses **JavaBeans setters** (`.setExpiryPolicyFactory(...)`,
`.setStoreByValue(...)`, etc.). Pick one configuration shape per cache;
do not mix.

**Teardown order.** Close `cacheManager` (and any individual `Cache`s
via `cacheManager.close()`) **before** `storage.shutdown()`. Storage-backed
`writeThrough` is synchronous, so no explicit flush is needed — closing the
cache simply releases its handles before the storage closes.

### Pattern C — Manual cache-aside (without Spring)

Plain cache-aside against any cache (standalone or storage-backed). The
`@Cacheable` semantics from Pattern F, written by hand:

```java
public Product findBySku(String sku) {
    Product hit = cache.get(sku);
    if (hit != null) return hit;
    Product loaded = db.load(sku);    // or any expensive source
    if (loaded != null) cache.put(sku, loaded);
    return loaded;
}
```

For a JSR-107 `read-through` setup that auto-loads on miss, plug a
`CacheLoader` and set `readThrough(true)` — see Pattern I. Cache-aside is
the simpler option when the data source isn't a `CacheLoader`-compatible
thing (e.g. an arbitrary service method).

### Pattern D — Expiry policies

From `javax.cache.expiry`:

```java
// TTL from creation
cfg.setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
    new Duration(TimeUnit.MINUTES, 15)));

// TTL from last modification
cfg.setExpiryPolicyFactory(ModifiedExpiryPolicy.factoryOf(
    new Duration(TimeUnit.HOURS, 1)));

// TTL from last access (read or write)
cfg.setExpiryPolicyFactory(AccessedExpiryPolicy.factoryOf(
    new Duration(TimeUnit.MINUTES, 30)));
```

Pick one per cache; usually `ModifiedExpiryPolicy` or `CreatedExpiryPolicy`.
Beware the storage-backed expiry-after-restart quirk (Pitfall 1).

### Pattern E — Entry listeners

Notify on create / update / remove / expire:

```java
import javax.cache.event.*;
import javax.cache.configuration.*;

CacheEntryCreatedListener<Integer, String> listener = events ->
    events.forEach(e -> System.out.println("created " + e.getKey()));

CacheEntryListenerConfiguration<Integer, String> listenerCfg =
    new MutableCacheEntryListenerConfiguration<>(
        FactoryBuilder.factoryOf(listener),
        null,      // event filter
        true,      // oldValueRequired
        false);    // synchronous? false → async; true blocks the cache op

cfg.addCacheEntryListenerConfiguration(listenerCfg);
```

Listeners are synchronous by default — a slow listener throttles cache
operations.

### Pattern F — Eviction (LRU / LFU / FIFO)

`EvictionPolicy` decides *which* entries to evict; `EvictionManager` decides
*when* to evict (on every put, or on a timer):

```java
import org.eclipse.store.cache.types.CacheConfiguration;
import org.eclipse.store.cache.types.EvictionManager;
import org.eclipse.store.cache.types.EvictionPolicy;

// LRU, capped at 10_000 entries, checked once per minute
cfg.evictionManagerFactory(() ->
    EvictionManager.Interval(
        EvictionPolicy.LeastRecentlyUsed(10_000L),
        60_000L));

// LFU, evict eagerly on every put
cfg.evictionManagerFactory(() ->
    EvictionManager.OnEntryCreation(
        EvictionPolicy.LeastFrequentlyUsed(10_000L)));

// FIFO, evict 4 entries at a time when above 10_000
cfg.evictionManagerFactory(() ->
    EvictionManager.OnEntryCreation(
        EvictionPolicy.FirstInFirstOut(4, 10_000L)));
```

The `Interval` variant uses a background sweeper; `OnEntryCreation`
piggybacks on inserts. `Interval` smooths latency; `OnEntryCreation`
caps memory more aggressively.

### Pattern G — Spring `@Cacheable` with Eclipse Store

Wire caches through a `JCacheManagerCustomizer` bean. For a storage-backed
cache, constructor-inject the `EmbeddedStorageManager` — that ordering
guarantee is what keeps the customizer from running before the storage
bean exists (see Pitfall 2).

```java
@Configuration
@EnableCaching
public class CachingSetup implements JCacheManagerCustomizer {
    private final EmbeddedStorageManager storage;

    public CachingSetup(EmbeddedStorageManager storage) {
        this.storage = storage;
    }

    @Override
    public void customize(CacheManager cacheManager) {
        // In-memory cache
        cacheManager.createCache("sessions", new MutableConfiguration<>()
            .setTypes(String.class, Session.class)
            .setStoreByValue(false)
            .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
                new Duration(TimeUnit.MINUTES, 30))));

        // Storage-backed cache — entries persist across restarts
        cacheManager.createCache("customers", CacheConfiguration
            .Builder(String.class, Customer.class, "customers", storage)
            .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_HOUR))
            .build());
    }
}

@Service
public class CustomerService {
    @Cacheable("customers")
    public Customer find(String id) { ... }
}
```

### Pattern H — Hibernate second-level cache

Add `cache-hibernate` and point the region factory at Eclipse Store's
`CacheRegionFactory` — that single property is the whole wiring:

```properties
hibernate.cache.use_second_level_cache=true
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
```

Spring Boot variant — same keys under the `spring.jpa.properties.` prefix.
Eclipse Store-specific Hibernate options live under
`spring.jpa.properties.hibernate.cache.eclipsestore.*` (for example
`missing_cache_strategy=create`). Per-region expiry / eviction follows
standard Hibernate region settings.

### Pattern I — Read-through / write-through with `CacheLoader`

A storage-backed cache is already read- and write-through *to its storage*.
For read-through to a **different** system of record (e.g. a relational
database), layer a `CacheLoader`:

```java
import javax.cache.integration.*;

CacheLoader<String, Customer> dbLoader = new CacheLoader<>() {
    @Override public Customer load(String id) { return db.findCustomer(id); }
    @Override public Map<String, Customer> loadAll(Iterable<? extends String> keys) {
        return db.findCustomers(keys);
    }
};

CacheConfiguration<String, Customer> cfg = CacheConfiguration
    .Builder(String.class, Customer.class)
    .cacheLoaderFactory(FactoryBuilder.factoryOf(dbLoader))
    .readThrough(true)
    .build();
```

Mirror with `cacheWriterFactory(...)` + `writeThrough(true)` for write-through.

### Pattern J — Loading config from a properties file

Eclipse Store cache parses a small INI-style properties file. Drop it on
the classpath as `eclipsestore-cache.properties` (or set the system
property `eclipsestore.cache.configuration.path`):

```properties
key-type   = java.lang.Integer
value-type = java.lang.String

read-through  = true
write-through = true

storage-configuration-resource-name = eclipsestore-storage.properties
```

```java
CacheConfiguration<Integer, String> cfg = CacheConfiguration
    .load("cache-config.properties", Integer.class, String.class);
Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
```

Keys are listed in `org.eclipse.store.cache.types.CacheConfigurationPropertyNames`;
the storage-side file follows the rules in `configuration` skill.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Assuming cached entries persist via the cache alone

```java
cache.put(1, something);
// JVM restart
cache.get(1);   // null — if the cache is standalone (not storage-backed)
```

**Fix.** Use `CacheConfiguration.Builder(..., storageManager)` for persistence.

### Anti-pattern 2 — Blocking work in a synchronous listener

```java
listener.onCreated(events -> httpClient.post(...));   // blocks cache puts
```

**Fix.** Set `isSynchronous=false` in
`MutableCacheEntryListenerConfiguration`, or delegate to a queue.

### Anti-pattern 3 — `storeByValue(true)` with big values

Serializing 10 MB on every `get` is measurable. Profile; consider
`storeByReference()` if semantics allow.

### Anti-pattern 4 — `Caching.getCachingProvider()` with multiple providers on the classpath

```java
Caching.getCachingProvider();   // ambiguous when >1 provider → CacheException
```

**Fix.** Either keep only one JCache provider on the classpath, or pin
Eclipse Store explicitly:

```java
Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider");
```

## Pitfalls & gotchas

1. **Storage-backed cache TTL counter resets across JVM restart.** When the
   app restarts and an entry is later requested, it is loaded from storage
   and given a *new* expiry counter — even if the original creation was
   hours/days ago. Quoted directly from `configuration/storage.adoc`. See
   `references/pitfalls-deep-dive.md` for mitigation. Note: a load-through
   miss after restart counts as a **cache miss + a load** in JSR-107 stats
   (not a hit) — `cache.unwrap(CacheStatisticsMXBean.class).getCacheMisses()`
   increments.
2. **`JCacheManagerCustomizer` runs before `EmbeddedStorageManager`.**
   Without constructor-injecting the storage bean, the customizer NPEs or
   wires a vanilla in-memory cache.
3. **A programmatic storage-backed cache must be created *before* Spring
   looks it up.** Otherwise Spring's auto-config creates a same-named
   in-memory cache and the storage-backed one is never used. Create caches
   inside `JCacheManagerCustomizer` (not via `spring.cache.cache-names`).
4. **Spring picks a different JCache provider** if Caffeine / Ehcache is
   also on the classpath. Pin with `spring.cache.jcache.provider=…`.
5. **Statistics are off by default.** `cfg.setStatisticsEnabled(true)` (or
   builder `.enableStatistics()`); read via
   `cache.unwrap(javax.cache.management.CacheStatisticsMXBean.class)`
   (or the Eclipse Store-specific subtype
   `org.eclipse.store.cache.types.CacheStatisticsMXBean` — both `unwrap`
   targets resolve to the same instance).
6. **Listeners execute synchronously unless configured otherwise.** Slow
   listeners throttle puts/gets — set `synchronous=false` on the
   `MutableCacheEntryListenerConfiguration`.

## Interactions with other skills

- **`getting-started`** — a storage-backed cache needs an
  `EmbeddedStorageManager`. Set it up there first.
- **`spring-boot`** — Spring Boot apps typically want Eclipse Store as a
  data store *plus* JCache as a cache. Both can coexist; the same
  `EmbeddedStorageManager` bean can back both, or use a separate one.
- **`configuration`** — `eclipsestore-storage.properties` (referenced from
  `storage-configuration-resource-name`) is configured per the rules there.
- **`serializer-standalone`** — the cache uses Eclipse Serializer under the
  hood when `storeByValue(true)` is set.
- **`gigamap`** — unrelated in purpose; a cache is ephemeral, a GigaMap is
  a long-lived indexed collection.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a method overload,
  property-file key, or builder/setter beyond the in-line tables — e.g.
  every `CacheConfiguration.Builder` method, the full `EvictionPolicy`
  factory list, `CacheConfigurationPropertyNames` constants, or
  Hibernate region-factory specifics.
- **Load `references/examples-expanded.md`** when you want a complete
  end-to-end program template — standalone JCache app, storage-backed
  app, listener setup, Spring Boot `JCacheManagerCustomizer`, Hibernate
  L2 wiring, read-through with `CacheLoader`, or properties-file config.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a bug —
  cache empty after restart, `UniqueConstraintViolationException`,
  listener-blocking-puts, statistics returning zero, provider-mismatch
  on Spring auto-config, or storage-backed cache replaced by Spring's
  in-memory default.

## Upstream sources

Cache module (`cache/cache/src/main/java/org/eclipse/store/cache/types/`):

- `CachingProvider.java`
- `Cache.java`
- `CacheManager.java`
- `CacheConfiguration.java`
- `CacheConfigurationPropertyNames.java`
- `EvictionManager.java`
- `EvictionPolicy.java`
- `CacheEntry.java`, `CacheEvent.java`, `CacheEventDispatcher.java`

Hibernate L2 (`cache/hibernate/src/main/java/org/eclipse/store/cache/hibernate/types/`):

- `CacheRegionFactory.java`
- `ConfigurationPropertyNames.java`

Documentation (`docs/modules/cache/pages/`):

- `index.adoc`
- `getting-started.adoc`
- `configuration/index.adoc`, `configuration/properties.adoc`,
  `configuration/storage.adoc`
- `use-cases/hibernate-second-level-cache.adoc`,
  `use-cases/spring-cache.adoc`
