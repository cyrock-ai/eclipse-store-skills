# API catalogue — cache-jcache

## JSR-107 core (`javax.cache`)

| Symbol | Purpose |
|---|---|
| `CachingProvider` | Provider discovery (SPI). |
| `CacheManager` | Named cache registry. |
| `Cache<K,V>` | Cache instance. |
| `MutableConfiguration<K,V>` | Standard config (no storage backing). |
| `CompleteConfiguration<K,V>` | Full config contract (Eclipse Store's `CacheConfiguration` extends this). |
| `CacheEntryListener` (sub: `Created`, `Updated`, `Removed`, `Expired`) | Notifications. |
| `MutableCacheEntryListenerConfiguration` | Wrap a listener into config. |
| `Factory`, `FactoryBuilder` | JCache factory plumbing. |
| `CacheLoader<K,V>` / `CacheWriter<K,V>` | Read-through / write-through SPI. |
| `CacheException` / `CacheLoaderException` / `CacheWriterException` | JSR-107 exception types. |

## JSR-107 expiry (`javax.cache.expiry`)

| Class | Behaviour |
|---|---|
| `CreatedExpiryPolicy` | TTL from creation. |
| `ModifiedExpiryPolicy` | TTL from last write. |
| `AccessedExpiryPolicy` | TTL from last access (read or write). |
| `EternalExpiryPolicy` | Never expire. |
| `TouchedExpiryPolicy` | TTL from any "touch". |
| `Duration(TimeUnit, long)` | Specifier. |

Use via `factoryOf(policy)`:

```java
.setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(new Duration(TimeUnit.HOURS, 1)));
```

## Eclipse Store cache package (`org.eclipse.store.cache.types`)

Source: `cache/cache/src/main/java/org/eclipse/store/cache/types/`.

### Provider

| Symbol | Purpose |
|---|---|
| `CachingProvider` | `Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider")`. No `PROVIDER_CLASS_NAME` constant — magic string. |

### `CacheConfiguration<K,V>`

Extends `javax.cache.configuration.CompleteConfiguration<K,V>`.

Static `Builder(...)` factories:

| Signature | Purpose |
|---|---|
| `Builder(Class<K>, Class<V>)` | Not storage-backed. |
| `Builder(Class<K>, Class<V>, String name, StorageManager)` | Storage-backed. |
| `Builder(Class<K>, Class<V>, URI uri, String name, StorageManager)` | Storage-backed with URI. |
| `Builder(Configuration)` | Builder from a serializer `Configuration`. |
| `Builder(Class<K>, Class<V>, Configuration)` | Typed builder from a serializer `Configuration`. |

Static `load(...)` factories — load `CacheConfiguration` from a properties
file (overloads accept path, charset, key/value classes, file, URL):

| Signature | Purpose |
|---|---|
| `load()` | Load default file (`eclipsestore-cache.properties` or system-property path), untyped. |
| `load(Class<K>, Class<V>)` | Same, typed. |
| `load(String path)` | Load from path (classpath / URL / file), untyped. |
| `load(String path, Class<K>, Class<V>)` | Same, typed. |
| `load(File / URL / Path, …)` | Variants for explicit sources. |

Discovery contract:

| Symbol | Value |
|---|---|
| `CacheConfiguration.PathProperty()` | `"eclipsestore.cache.configuration.path"` |
| `CacheConfiguration.DefaultResourceName()` | `"eclipsestore-cache.properties"` |

Builder methods (`CacheConfiguration.Builder<K,V>`):

| Method | Purpose |
|---|---|
| `expiryPolicyFactory(Factory<ExpiryPolicy>)` | Plug expiry. |
| `evictionManagerFactory(Factory<EvictionManager<K,V>>)` | Plug eviction. |
| `cacheLoaderFactory(Factory<CacheLoader<K,V>>)` | Read-through SPI. |
| `cacheWriterFactory(Factory<CacheWriter<? super K, ? super V>>)` | Write-through SPI. |
| `addListenerConfiguration(CacheEntryListenerConfiguration<K,V>)` | Add a listener. |
| `readThrough(boolean)` / `readThrough()` | Enable read-through. |
| `writeThrough(boolean)` / `writeThrough()` | Enable write-through. |
| `storeByValue(boolean)` / `storeByValue()` / `storeByReference()` | Value vs. reference semantics. |
| `enableStatistics(boolean)` / `enableStatistics()` / `disableStatistics()` | Stats toggle. |
| `enableManagement(boolean)` / `enableManagement()` / `disableManagement()` | JMX management toggle. |
| `serializerFoundation(SerializerFoundation<?>)` | Plug a custom Eclipse Serializer foundation. |
| `build()` | Returns `CacheConfiguration<K,V>`. |

### `Cache<K,V>` (Eclipse Store)

Extends `javax.cache.Cache<K,V>` and `Unwrappable`. Adds:

| Method | Purpose |
|---|---|
| `getCacheManager()` | Narrowed to Eclipse Store `CacheManager`. |
| `getConfiguration()` | Returns `CacheConfiguration<K,V>`. |
| `size()` | Current entry count. |
| `putSilent(K, V)` | Put without firing listeners. |
| `unwrap(Class<T>)` | Unwrap to `CacheStatisticsMXBean` / `CacheMXBean` (configuration MBean), or to `Cache.Default` and supertypes. Throws `IllegalArgumentException` for any other class. |

### `CacheManager` (Eclipse Store)

Extends `javax.cache.CacheManager`. Narrows the return type of
`createCache` / `getCache` to Eclipse Store `Cache<K,V>`. Adds:

| Method | Purpose |
|---|---|
| `removeCache(String cacheName)` | Remove and close a single cache. |

### Eviction

`EvictionManager<K,V>` — *when* to evict.

| Static factory | Purpose |
|---|---|
| `EvictionManager.OnEntryCreation(EvictionPolicy)` | Evict on every put. |
| `EvictionManager.Interval(EvictionPolicy, long milliTimeInterval)` | Evict periodically. |
| `EvictionManager.Interval(EvictionPolicy, _longReference intervalProvider)` | Evict periodically with a dynamic interval. |

`EvictionPolicy` — *which* entries to evict (functional interface).

| Static factory | Purpose |
|---|---|
| `EvictionPolicy.LeastRecentlyUsed(long maxCacheSize)` | LRU, default sample count. |
| `EvictionPolicy.LeastRecentlyUsed(int elementCount, long maxCacheSize)` | LRU with sample count. |
| `EvictionPolicy.LeastFrequentlyUsed(long maxCacheSize)` | LFU. |
| `EvictionPolicy.LeastFrequentlyUsed(int elementCount, long maxCacheSize)` | LFU with sample count. |
| `EvictionPolicy.BiggestObjects(int elementCount, long maxCacheSize)` | Evict largest entries first. |
| `EvictionPolicy.FirstInFirstOut(int elementCount, long maxCacheSize)` | FIFO. |
| `EvictionPolicy.Sampling(...)` / `EvictionPolicy.Searching(...)` | Lower-level building blocks. |

### Entry & event types

| Class | Purpose |
|---|---|
| `CacheEntry<K,V>` | Eclipse Store's entry type — extends `javax.cache.Cache.Entry`. |
| `CacheEvent<K,V>` | Event payload — extends `CacheEntryEvent`. |
| `CacheEventDispatcher<K,V>` | Internal dispatch interface. |

### Property names

`CacheConfigurationPropertyNames` is the canonical source of property keys
used in `eclipsestore-cache.properties`:

| Constant | Key |
|---|---|
| `KEY_TYPE` | `key-type` |
| `VALUE_TYPE` | `value-type` |
| `STORAGE_CONFIGURATION_RESOURCE_NAME` | `storage-configuration-resource-name` |
| `STORAGE` | `storage` (sub-config prefix) |
| `STORAGE_KEY` | `key` |
| `CACHE_LOADER_FACTORY` | `cache-loader-factory` |
| `CACHE_WRITER_FACTORY` | `cache-writer-factory` |
| `EXPIRY_POLICY_FACTORY` | `expiry-policy-factory` |
| `EVICTION_MANAGER_FACTORY` | `eviction-manager-factory` |
| `READ_THROUGH` | `read-through` |
| `WRITE_THROUGH` | `write-through` |
| `STORE_BY_VALUE` | `store-by-value` |
| `STATISTICS_ENABLED` | `statistics-enabled` |
| `MANAGEMENT_ENABLED` | `management-enabled` |

## Configuration via files

Discovery search order (per `CacheConfiguration.load()` Javadoc):

1. System property `eclipsestore.cache.configuration.path` (file path).
2. `eclipsestore-cache.properties` on the classpath, in the application
   directory, or in `~`.

Example `cache-config.properties`:

```properties
key-type   = java.lang.Integer
value-type = java.lang.String

read-through  = true
write-through = true

# Either point at an external storage-config file:
storage-configuration-resource-name = eclipsestore-storage.properties

# …or embed storage config inline with the `storage.` prefix:
storage.storage-directory = ~/cache-data
storage.channel-count     = 4
```

Parser is INI-style (`ConfigurationParserIni`).

## Hibernate integration (`cache-hibernate`)

Source:
`cache/hibernate/src/main/java/org/eclipse/store/cache/hibernate/types/`.

Key classes:

- `CacheRegionFactory` — Hibernate `RegionFactoryTemplate` impl.
  FQN: `org.eclipse.store.cache.hibernate.types.CacheRegionFactory`.
- `ConfigurationPropertyNames` — Eclipse-Store-specific Hibernate property
  names (prefix `hibernate.cache.eclipsestore.`):
  - `MISSING_CACHE_STRATEGY` (`missing_cache_strategy`)
  - `CACHE_MANAGER` (`cache_manager`)
  - `CACHE_LOCK_TIMEOUT` (`cache_lock_timeout`)
  - `CONFIGURATION_RESOURCE_NAME` (`configuration_resource_name`)

Required Hibernate property:

```properties
hibernate.cache.use_second_level_cache=true
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
```

Spring Boot variant — the `spring.jpa.properties.hibernate.…` prefix:

```properties
spring.jpa.properties.hibernate.cache.use_second_level_cache=true
spring.jpa.properties.hibernate.cache.use_query_cache=true
spring.jpa.properties.hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
spring.jpa.properties.hibernate.cache.eclipsestore.missing_cache_strategy=create
spring.jpa.properties.javax.persistence.sharedCache.mode=ALL
```

The docs do **not** prescribe `hibernate.javax.cache.provider=…` — the
region factory class is enough.

Per-region expiry uses Hibernate's standard region settings.

## Spring integration

Wire caches via a `JCacheManagerCustomizer` bean (per
`use-cases/spring-cache.adoc`); `@EnableCaching` + `@Cacheable` work as
usual on top. If multiple JCache providers are on the classpath, pin
Eclipse Store with `spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider`.

## Interactions with `EmbeddedStorageManager`

- A storage-backed cache uses the given `EmbeddedStorageManager` as its
  `CacheReader` and `CacheWriter`. `readThrough` / `writeThrough` default
  to `true` (per `configuration/storage.adoc`).
- You can share the same manager with the rest of your app's data, or
  isolate caches in a dedicated storage directory.
- Cache metadata (stats) is not persisted across restarts — only the
  entries themselves.
- Storage-backed cache **TTL counter resets on JVM restart**: an entry is
  given a fresh expiry the next time it is loaded after restart, even if
  the original creation was long ago. Documented in
  `configuration/storage.adoc`.

## Exceptions

- `CacheException` — JSR-107 base.
- `CacheLoaderException` / `CacheWriterException` — for read/write-through.
