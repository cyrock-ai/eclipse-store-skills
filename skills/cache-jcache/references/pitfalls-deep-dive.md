# Pitfalls deep-dive — cache-jcache

## 1. Cache not persisting across restart

**Reproducer.** Standalone config (no `storageManager`):

```java
cacheManager.createCache("x", new MutableConfiguration<>()...);
```

Restart → entries gone.

**Fix.** Use `CacheConfiguration.Builder(K.class, V.class, name, storageManager)`.

## 2. Ambiguous provider when multiple JCache impls are on the classpath

**Reproducer.** Caffeine + Eclipse Store both on the classpath.

```java
Caching.getCachingProvider();   // throws CacheException — ambiguous
```

With a single provider, the no-arg variant works fine — it returns the
only one. The skill's recommendation to always pin the provider is
defensive; it is *required* only with multiple impls.

**Fix.**

```java
Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider");
```

There is no `PROVIDER_CLASS_NAME` constant in the Eclipse Store cache
module — the FQN is a magic string.

## 3. Listener blocks cache operations

```java
new MutableCacheEntryListenerConfiguration<>(listener, null, true, /*synchronous=*/ true);
```

Slow listener → slow puts.

**Fix.** `synchronous=false` and/or delegate to a queue inside the listener.

## 4. `storeByValue(true)` with large values

Every `get` serializes the value. On 10 MB values, this is measurable.

**Fix.** `storeByReference()` (or `storeByValue(false)`) unless semantics
need defensive copies.

## 5. Storage-backed cache TTL counter resets across JVM restart

**Reproducer.**

1. Configure a 1-minute TTL on a storage-backed cache.
2. Put an entry at `t=0`.
3. Shut the application down at `t=30s` (entry not yet read post-`put`).
4. Wait an hour.
5. Restart. Read the entry.

**Symptom.** The entry is returned (not expired), and a *new* 1-minute
expiry counter starts from this read.

**Root cause.** Documented in `configuration/storage.adoc`:

> Since the validity of a Cache entry is only determined when the value is
> retrieved, the expiry durations are not always respected when using the
> StorageManager when the application is restarted. … When we start up the
> application again, when we request the cache entry, it is loaded from
> the Eclipse Store StorageManager and 'created' with a new expiry of 1
> minute.

The cache entry's wall-clock creation time is not persisted alongside the
value; only the value itself is.

**Fix / mitigation.** Pick one:

- Accept the at-most-TTL-after-restart semantics (good enough for most
  caches — restarts are rare).
- Embed a `createdAt` timestamp in the value itself and check it
  application-side after every `get` — invalidate manually if stale.
- Use a periodic warm-up sweeper that explicitly removes stale entries on
  startup, before traffic is allowed in.

## 6. `cacheManager.close()` closes all caches

Once closed, the manager is done. Creating new caches through it throws.

**Fix.** Don't close the manager mid-application-lifetime. In tests, use
a fresh manager per test.

## 7. Statistics silently off

**Reproducer.** Configuration left at the JCache default (statistics
disabled); the MBean is still wired and `unwrap` returns it, but every
counter stays at zero.

```java
// cfg.setStatisticsEnabled(...) never called → false by default
cache.put("a", customer);
cache.get("a");

CacheStatisticsMXBean stats = cache.unwrap(CacheStatisticsMXBean.class);
stats.getCacheHits();    // 0 — counters never incremented
```

**Fix.** Enable on the configuration at build time, then read via `unwrap`:

```java
cfg.setStatisticsEnabled(true);          // MutableConfiguration
// ... or
.enableStatistics()                      // Eclipse Store builder

long hits = cache.unwrap(CacheStatisticsMXBean.class).getCacheHits();
```

The same MBeans are also registered on the platform `MBeanServer` under
`javax.cache:type=CacheStatistics,CacheManager=…,Cache=…` for external
monitoring tools.

## 8. `JCacheManagerCustomizer` runs before `EmbeddedStorageManager` is initialized

**Reproducer.** A `@Component` customizer that grabs the storage manager
without dependency-ordering hints:

```java
@Component
public class CachingSetup implements JCacheManagerCustomizer {
    @Autowired EmbeddedStorageManager storage;     // null at customize() time
    @Override public void customize(CacheManager cm) {
        cm.createCache("c", CacheConfiguration
            .Builder(K.class, V.class, "c", storage)   // NPE
            .build());
    }
}
```

**Root cause.** `JCacheManagerCustomizer` is invoked by Spring Boot during
its cache auto-configuration, which can be earlier in the bean graph than
the storage bean's initialization.

**Fix.** Constructor-inject the storage manager — Spring resolves the
dependency before instantiating the customizer, so `storage` is non-null
by the time `customize` runs:

```java
@Configuration
public class CachingSetup implements JCacheManagerCustomizer {
    private final EmbeddedStorageManager storage;

    public CachingSetup(EmbeddedStorageManager storage) {
        this.storage = storage;
    }
    // ...
}
```

## 9. Storage-backed cache silently replaced by Spring's default in-memory cache

**Reproducer.** `application.properties` has
`spring.cache.cache-names=customers,orders`, and the application uses
`@Cacheable("customers")`. Programmatic `CacheConfiguration.Builder(...,
storageManager)` runs *after* Spring has already created `customers` as a
default in-memory cache.

**Symptom.** `@Cacheable` works, but entries vanish on restart — the
in-memory cache is being used, not the storage-backed one.

**Fix.** Create the storage-backed cache inside a
`JCacheManagerCustomizer` — Spring invokes it during the cache manager's
own initialization, *before* it materializes any cache implied by
`spring.cache.cache-names`. Alternatively, drop `spring.cache.cache-names`
entirely and let the customizer be the sole source of cache definitions.

## 10. Spring `@Cacheable` but Spring picks a different JCache provider

If Caffeine / Ehcache is also on the classpath, Spring may discover one of
them first.

**Fix.**

```properties
spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider
```

Pairs naturally with the `JCacheManagerCustomizer` pattern — the
customizer wires the cache, the property pins the provider.

## 11. Hibernate region factory mismatch

Wrong or missing `hibernate.cache.region.factory_class` → L2 doesn't use
Eclipse Store; silently falls back to whatever Hibernate picks.

**Fix.** Set it to
`org.eclipse.store.cache.hibernate.types.CacheRegionFactory` and verify
with Hibernate's own logs (region factory is logged at startup).
