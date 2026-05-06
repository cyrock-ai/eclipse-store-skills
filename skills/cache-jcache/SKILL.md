---
name: cache-jcache
description: >
  Guide Claude on using Eclipse Store's JCache (JSR-107) provider — standalone
  caches, caches backed by an EmbeddedStorageManager, expiry and eviction
  policies, entry listeners, and integrations with Hibernate second-level cache
  and Spring's cache abstraction. This skill should be used when the user asks to
  "use JCache", "JSR-107", "second-level cache", "Hibernate L2 cache",
  "@Cacheable", "Spring cache with Eclipse Store", "CachingProvider",
  "CacheManager", "CacheConfiguration.Builder", "storeByValue", "expiry policy",
  "cache eviction", or asks how Eclipse Store compares to Ehcache / Caffeine /
  Infinispan.
version: 0.1.0
---

# Eclipse Store — JCache (JSR-107) Cache

Eclipse Store ships a JCache (JSR-107) provider. Use it as a drop-in replacement for
any other JCache implementation, with optional backing by an
`EmbeddedStorageManager` so entries survive restarts. Integrates with Hibernate L2
cache and Spring Cache.

## When to use this skill

- User needs a cache, wants a standard API (JSR-107), and doesn't want to lock in
  to Caffeine / Ehcache / Infinispan.
- User wants cache entries persisted by Eclipse Store (survives restarts).
- User wants Hibernate second-level cache backed by Eclipse Store.
- User wants Spring's `@Cacheable` with Eclipse Store as the backing cache.
- User asks about any JCache API symbol (`CachingProvider`, `CacheManager`,
  `Cache`, `MutableConfiguration`, expiry policies, listeners).

**Route elsewhere** when:

- User wants a persistent data store with queries, not a cache → Eclipse Store
  itself (the other skills).
- User wants GigaMap (indexed large collection) → `gigamap`.
- User wants Spring Boot starter for Eclipse Store generally → `spring-boot`.

## Mental model

JCache defines a `Cache<K,V>` — a simple map-like API with expiry, listeners, and
statistics. Providers plug in; Eclipse Store's provider is one.

Two uses:

1. **Standalone JCache** — a pure in-memory cache (not persistent) using JCache
   standard `MutableConfiguration`. Use as a drop-in.
2. **Backed by Eclipse Store** — pass an `EmbeddedStorageManager` to Eclipse
   Store's `CacheConfiguration`. The cache state is persisted through that
   storage, so restarting the JVM doesn't lose entries.

Key advantage over Ehcache/Caffeine: you aren't restricted to `Serializable`
values. Any POJO can be a cache value.

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
| `Caching.getCachingProvider()` | Default provider. |
| `Caching.getCachingProvider(String)` | Named provider (for multi-impl classpaths). |
| `provider.getCacheManager()` | Get a `CacheManager`. |
| `cacheManager.createCache(name, config)` | Create. |
| `cacheManager.getCache(name, K, V)` | Retrieve. |
| `cache.put(k, v)` / `get(k)` / `remove(k)` | Standard JCache. |
| `MutableConfiguration<K,V>` | Standard config. |
| `CreatedExpiryPolicy`, `ModifiedExpiryPolicy`, `AccessedExpiryPolicy` | Standard expiry policies. |

Eclipse Store-specific:

| Symbol | Purpose |
|---|---|
| `CacheConfiguration.Builder(K.class, V.class, name, storageManager)` | Builder for storage-backed config. |
| `.expiryPolicyFactory(factory)` | Plug in expiry. |
| `.evictionManagerFactory(factory)` | Plug in eviction. |
| `.build()` | Returns an Eclipse-Store `CacheConfiguration`. |

Provider class name: `org.eclipse.store.cache.types.CachingProvider`.

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
    .setStoreByValue(false)   // reference-based; fastest
    .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_MINUTE));

Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
cache.put(1, "Hello");
String v = cache.get(1);
```

Nothing persistent — JVM restart clears it. Faster than backed variant because
no serialization occurs.

### Pattern B — Storage-backed JCache

```java
EmbeddedStorageManager storage = EmbeddedStorage.start();   // or start(dir)

CachingProvider provider     = Caching.getCachingProvider();
CacheManager    cacheManager = provider.getCacheManager();

CacheConfiguration<Integer, String> cfg = CacheConfiguration
    .Builder(Integer.class, String.class, "jCache", storage)
    .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_HOUR))
    .build();

Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
cache.put(1, "persists across restarts");
```

Note: `CacheConfiguration` extends JCache's `CompleteConfiguration<K,V>`, so it
can be passed to `createCache(name, cfg)` as-is.

### Pattern C — Store by value vs. by reference

```java
cfg.setStoreByValue(true);    // default — serializes on every put/get
cfg.setStoreByValue(false);   // faster — references shared between cache and app
```

**False** is usually what you want with Eclipse Store's provider — you get fast
reference-based caching without the JCache mandate that values be
`Serializable`. **True** means the cache returns a fresh object on every `get`
(mutations don't reflect back) — safer in complex scenarios.

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

### Pattern E — Entry listeners

Notify on create / update / remove / expire:

```java
import javax.cache.event.*;
import javax.cache.configuration.*;

CacheEntryListener<Integer, String> listener = new CacheEntryCreatedListener<>() {
    @Override public void onCreated(Iterable<CacheEntryEvent<? extends Integer, ? extends String>> events) {
        events.forEach(e -> System.out.println("created " + e.getKey()));
    }
};

CacheEntryListenerConfiguration<Integer, String> listenerCfg =
    new MutableCacheEntryListenerConfiguration<>(
        FactoryBuilder.factoryOf(listener),
        null,      // event filter
        true,      // oldValueRequired
        true);     // synchronous

cfg.addCacheEntryListenerConfiguration(listenerCfg);
```

Listeners are synchronous by default — a slow listener blocks cache operations.

### Pattern F — Eviction (LRU / LFU / TTL)

```java
Factory<EvictionManager<Integer, String>> eviction =
    // Eclipse Store-specific: your own evictor, or built-in LRU
    ...;

cfg.evictionManagerFactory(eviction);
```

Exact factory names depend on the Eclipse Store version; check
`org.eclipse.store.cache.types.EvictionManager` sub-interfaces.

### Pattern G — Spring `@Cacheable` with Eclipse Store

Spring auto-detects JCache providers on the classpath. With the `cache`
artifact, `@EnableCaching` picks up Eclipse Store.

```java
@Configuration
@EnableCaching
public class CacheConfig {}

@Service
public class CustomerService {
    @Cacheable("customers")
    public Customer find(String id) { ... }
}
```

Spring's JCache manager hands out Eclipse Store's caches. For storage-backed
caches, programmatically create the cache first (Pattern B) with the name
Spring expects.

### Pattern H — Hibernate second-level cache

Add `cache-hibernate` and set Hibernate properties:

```properties
hibernate.cache.use_second_level_cache=true
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
hibernate.javax.cache.provider=org.eclipse.store.cache.types.CachingProvider
```

Configure expiry/eviction per region via standard Hibernate region settings
plus (optionally) an Eclipse-Store-specific properties file.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Assuming cached entries persist via the cache alone

```java
cache.put(1, something);
// JVM restart
cache.get(1);   // null — if the cache is standalone (not storage-backed)
```

**Fix.** Use `CacheConfiguration.Builder(..., storageManager)` for persistence.

### Anti-pattern 2 — Very short TTL for rarely-accessed entries

```java
cfg.setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_MINUTE));
// Entries accessed every 5 minutes — always miss the cache
```

Match TTL to the access cadence. For dashboards / infrequently-accessed data,
use longer TTL or `ModifiedExpiryPolicy` so reads don't reset.

### Anti-pattern 3 — Blocking work in a synchronous listener

```java
listener.onCreated(events -> httpClient.post(...));   // blocks cache puts
```

**Fix.** Either make the listener async (send to a queue) or set
`isSynchronous=false` in `MutableCacheEntryListenerConfiguration`.

### Anti-pattern 4 — `storeByValue(true)` with big values

Serializing 10 MB on every `get` is measurable. Profile; consider
`storeByValue(false)` (reference-based) if semantics allow.

### Anti-pattern 5 — Multiple `CachingProvider` implementations on the classpath

```java
Caching.getCachingProvider();   // ambiguous → throws
```

**Fix.** Use `Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider")`.

### Anti-pattern 6 — Confusing cache with storage

Cache entries are ephemeral by design (TTL / eviction). Storage entries are
forever until deleted. Putting a cache in front of your main data store (Eclipse
Store) is fine; expecting the cache to be the system of record is not.

## Pitfalls & gotchas

1. **`storeByValue(true)` is the JCache default.** You may want `false` with
   Eclipse Store — but understand the implications (mutations visible through
   the cache).
2. **`CacheManager.close()` closes all caches.** Don't re-use after.
3. **Listeners execute synchronously unless configured otherwise.** Slow
   listeners throttle puts/gets.
4. **Expiry is lazy.** An expired entry remains physically in the cache until
   `get`/`remove`/iteration touches it.
5. **Generic types on `createCache` / `getCache`** are a JSR-107 quirk. The
   second form requires class arguments: `cm.getCache("name", K.class, V.class)`.
6. **Hibernate integration needs the `cache-hibernate` artifact.** And the
   region factory class must be on the classpath.
7. **Spring Boot's cache auto-config might pick a different provider** if
   multiple are on the classpath. Pin with
   `spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider`.
8. **Statistics must be enabled**: `cfg.setStatisticsEnabled(true)`. Off by
   default.

## Interactions with other skills

- **`serializer-standalone`** — the cache uses Eclipse Serializer under the hood
  when `storeByValue(true)` is set.
- **`getting-started`** — a storage-backed cache needs an
  `EmbeddedStorageManager`. Use the skills there to set one up.
- **`spring-boot`** — Spring Boot apps typically want Eclipse Store as a data
  store plus JCache as a cache. Both can coexist.
- **`gigamap`** — unrelated in purpose; don't confuse.

## Recipes

**"Is Eclipse Store JCache faster than Ehcache?"** → Comparable in-memory;
wins when you want persistence without ORM ceremony.

**"Can my cache values be non-`Serializable`?"** → Yes. Use `storeByValue(false)`.

**"How do I persist cache entries?"** → Back the configuration with an
`EmbeddedStorageManager`. Same binary storage as your main data (or a separate
one — either works).

**"How do I make a large cache not dominate heap?"** → Eviction policy + a short
TTL + offload via storage backing. Or use GigaMap if you need indexed access.

**"How do I use it in Hibernate?"** → `cache-hibernate` artifact + region
factory property + standard JCache provider property.

**"How do I use it with Spring `@Cacheable`?"** → `@EnableCaching` + ensure
Eclipse Store is the discovered provider. Spring handles the rest.

**"What about JCache's `Cache.Entry` vs. `Map.Entry`?"** → Different interfaces.
Don't assume `Map.Entry` interchangeability.

**"Can I configure from a properties file?"** → JCache supports `config` URIs
that point to XML — provider-specific. Eclipse Store honors
`eclipsestore-cache.properties` or the path in
`eclipsestore.cache.configuration.path`.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — full Eclipse Store + JCache API tables.
- `references/examples-expanded.md` — five end-to-end examples.
- `references/pitfalls-deep-dive.md` — each pitfall with reproducer.

## Upstream sources

- `docs/modules/cache/pages/index.adoc`, `getting-started.adoc`.
- `docs/modules/cache/pages/configuration/`.
- `docs/modules/cache/pages/use-cases/hibernate-second-level-cache.adoc`,
  `use-cases/spring-cache.adoc`.
- `cache/` module in source.
- `cache/cache-hibernate/` for the L2 adapter.
