# Pitfalls deep-dive — cache-jcache

## 1. Cache not persisting across restart

**Reproducer.** Standalone config (no `storageManager`):

```java
cacheManager.createCache("x", new MutableConfiguration<>()...);
```

Restart → entries gone.

**Fix.** Use `CacheConfiguration.Builder(K.class, V.class, name, storageManager)`.

## 2. Ambiguous provider

**Reproducer.** Multiple JCache impls on the classpath.

```java
Caching.getCachingProvider();   // throws
```

**Fix.**

```java
Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider");
```

## 3. Listener blocks cache operations

```java
MutableCacheEntryListenerConfiguration<...>(listener, null, true, /*synchronous=*/ true);
```

Slow listener → slow puts.

**Fix.** `synchronous=false` and/or delegate to a queue in the listener.

## 4. `storeByValue(true)` with large values

Every `get` serializes the value. On 10 MB values, this is measurable.

**Fix.** `storeByValue(false)` unless semantics need defensive copies.

## 5. Expiry never fires because nothing reads the entry

**Reproducer.** `CreatedExpiryPolicy(1 minute)`; entry put at t=0; never read.

**Symptom.** Entry is technically expired but still occupies memory until
someone reads or the cache is iterated.

**Root cause.** Expiry is lazy.

**Fix.** Periodic sweep: iterate the cache on a schedule, or use eviction policy
that triggers actively.

## 6. `cacheManager.close()` closes all caches

Once closed, the manager is done. Creating new caches through it throws.

**Fix.** Don't close the manager in the middle of application lifetime. In
tests, use fresh manager per test.

## 7. Statistics silently off

**Reproducer.**

```java
cache.unwrap(CacheStatisticsMXBean.class).getCacheHits();   // always 0
```

**Fix.** `cfg.setStatisticsEnabled(true)` at build time.

## 8. Storage-backed cache pointing at the same directory as your main storage

Two `EmbeddedStorageManager` instances against the same directory → lock
conflict.

**Fix.** Separate directory for the cache, or share one manager (cache uses the
same manager as your app's data).

## 9. Spring `@Cacheable` but Spring picks a different JCache provider

If Ehcache is also on the classpath, Spring may discover it first.

**Fix.**

```properties
spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider
```

## 10. Cache-to-cache copy errors on `storeByValue(true)`

Moving an entry between caches with `storeByValue(true)` copies — mutations on
the destination don't affect the source and vice versa. This may or may not be
what you want.

**Fix.** Match `storeByValue` semantics across related caches; or use
`storeByValue(false)` if you want shared state.

## 11. `getCache(name)` returns null after `createCache` with explicit types

```java
cm.getCache("jCache")   // untyped — may return null if typed was created
cm.getCache("jCache", Integer.class, String.class)   // correct
```

JCache's quirk: typed-create requires typed-get.

## 12. Hibernate region factory mismatch

Wrong or missing `hibernate.cache.region.factory_class` → L2 doesn't use Eclipse
Store; silently falls back to whatever Hibernate decides.

**Fix.** Set it to
`org.eclipse.store.cache.hibernate.types.CacheRegionFactory` and verify
with Hibernate's logs.
