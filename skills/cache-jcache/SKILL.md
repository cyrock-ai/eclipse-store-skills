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
version: 0.3.0
---

# Eclipse Store — JCache (JSR-107) Cache

Eclipse Store ships a JCache (JSR-107) provider. Use it as a drop-in
replacement for any other JCache implementation, with optional backing by an
`EmbeddedStorageManager` so entries survive restarts. Integrates with Hibernate
L2 cache and Spring Cache.

## When to use this skill

**Design-time triggers (apply proactively):**

- User is **adding a service / repository / facade method** with an
  expensive read (DB query, HTTP call, expensive compute) — flag the
  cache-aside vs. read-through decision *before* the method signature is
  committed.
- User is about to add `@Cacheable` / `@CacheEvict` / `@CachePut` on a
  Spring `@Service` — pin the JCache provider and decide ephemeral vs.
  storage-backed *now*.
- User is **designing a Hibernate model / aggregate** and L2 caching is
  potentially load-bearing for read-heavy entities.
- User is **comparing cache providers** (Caffeine / Ehcache / Infinispan)
  and wants to know whether Eclipse Store JCache fits.
- User is **deciding whether cached entries should survive a JVM restart**
  — that is the storage-backed-vs-standalone decision and it must be
  made at config time.
- User is sketching a **near-cache topology** (fast local cache in front
  of a durable cache).

**Reactive triggers:**

- User types `CachingProvider`, `CacheManager`, `Cache<K,V>`, `@Cacheable`,
  `JCacheManagerCustomizer`, `MutableConfiguration`,
  `CacheConfiguration.Builder`, `CacheConfiguration.load`,
  `EvictionManager`, `EvictionPolicy`.
- User asks how to wire Hibernate L2 to Eclipse Store.
- User asks why their cache loses entries on restart.
- User asks how to set TTL, evict, or measure hit rate.
- User asks about `eclipsestore-cache.properties` or
  `eclipsestore.cache.configuration.path`.

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

JCache defines a `Cache<K,V>` — a map-like API with expiry, listeners, and
statistics. Providers plug in; Eclipse Store's provider is one.

Two uses:

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
e.g., a database read-through; see Pattern H.)

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
| `EvictionManager.OnEntryCreation(policy)` | Evict on every put. |
| `EvictionManager.Interval(policy, intervalMs)` | Evict periodically. |
| `EvictionPolicy.LeastRecentlyUsed(maxSize)` | LRU policy. |
| `EvictionPolicy.LeastFrequentlyUsed(maxSize)` | LFU policy. |
| `EvictionPolicy.FirstInFirstOut(elementCount, maxSize)` | FIFO policy. |
| `EvictionPolicy.BiggestObjects(elementCount, maxSize)` | Evict largest entries first. |
| `CacheConfigurationPropertyNames` | Constants for the properties-file keys. |

## Idiomatic patterns

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

### Pattern C — Expiry policies

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

### Pattern D — Entry listeners

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

### Pattern E — Eviction (LRU / LFU / FIFO)

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

### Pattern F — Spring `@Cacheable` with Eclipse Store

Wire caches through a `JCacheManagerCustomizer` bean. For a storage-backed
cache, constructor-inject the `EmbeddedStorageManager` — that ordering
guarantee is what keeps the customizer from running before the storage
bean exists (see Pitfall 8).

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

### Pattern G — Hibernate second-level cache

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

### Pattern H — Read-through / write-through with `CacheLoader`

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

### Pattern I — Loading config from a properties file

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
   `references/pitfalls-deep-dive.md` for mitigation.
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
   `cache.unwrap(CacheStatisticsMXBean.class)`.
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

## Recipes

**"How do I persist cache entries?"** → Back the configuration with an
`EmbeddedStorageManager`. Same storage as the main data graph, or a
separate one — either works.

**"Can my cache values be non-`Serializable`?"** → Yes. Use
`storeByReference()`.

**"How do I read-through to a database?"** → `cacheLoaderFactory(...)` +
`readThrough(true)`. See Pattern H. Mirror with `cacheWriterFactory(...)` +
`writeThrough(true)` for write-through.

**"How do I use it with Spring `@Cacheable`?"** → `@EnableCaching` +
`JCacheManagerCustomizer` bean. See Pattern F.

**"How do I use it as Hibernate L2?"** → `cache-hibernate` artifact +
`hibernate.cache.region.factory_class=...CacheRegionFactory`. See
Pattern G.

**"Why does my TTL'd cache entry come back to life after a JVM restart?"**
→ Expected behavior of storage-backed caches; the expiry counter resets on
load. See Pitfall 1 / `references/pitfalls-deep-dive.md`.

**"Can I configure from a properties file?"** → Yes:
`CacheConfiguration.load("cache-config.properties", K.class, V.class)`.
Default file is `eclipsestore-cache.properties` on the classpath, override
via system property `eclipsestore.cache.configuration.path`.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — full Eclipse Store + JCache API tables,
  property keys, and integration matrices.
- `references/examples-expanded.md` — end-to-end examples (standalone,
  storage-backed, listeners, Spring Boot, Hibernate, read-through,
  properties file).
- `references/pitfalls-deep-dive.md` — each pitfall with a reproducer and
  fix.

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
