# API catalogue — cache-jcache

## JSR-107 core (from `javax.cache`)

| Symbol | Purpose |
|---|---|
| `CachingProvider` | Provider discovery. |
| `CacheManager` | Named cache registry. |
| `Cache<K,V>` | Cache instance. |
| `MutableConfiguration<K,V>` | Standard config. |
| `CompleteConfiguration<K,V>` | Full config contract. |
| `CacheEntryListener` (sub: Created, Updated, Removed, Expired) | Notifications. |
| `MutableCacheEntryListenerConfiguration` | Wrap a listener into config. |
| `Factory`, `FactoryBuilder` | JCache factory plumbing. |

## JSR-107 expiry

Package: `javax.cache.expiry`.

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

## Eclipse Store cache package

Package: `org.eclipse.store.cache.types`.

### Provider

| Symbol | Purpose |
|---|---|
| `CachingProvider` | `Caching.getCachingProvider("org.eclipse.store.cache.types.CachingProvider")` |

### `CacheConfiguration<K,V>`

Extends `javax.cache.configuration.CompleteConfiguration<K,V>`.

Static factory methods on `CacheConfiguration` (verified against
`store/cache/cache/.../CacheConfiguration.java`):

| Factory | Purpose |
|---|---|
| `CacheConfiguration.Builder(Class<K>, Class<V>)` | Not storage-backed. The cache name is supplied later in `cacheManager.createCache(name, cfg)`. |
| `CacheConfiguration.Builder(Class<K>, Class<V>, String cacheName, StorageManager)` | Storage-backed. Accepts an `EmbeddedStorageManager` (subtype of `StorageManager`). |
| `CacheConfiguration.Builder(Class<K>, Class<V>, URI, String cacheName, StorageManager)` | Storage-backed with a custom URI prefix for the slot in the storage root. |
| `CacheConfiguration.Builder(Configuration)` | Build from an Eclipse `Configuration` instance (e.g. loaded from a properties file). |
| `CacheConfiguration.Builder(Class<K>, Class<V>, Configuration)` | Typed variant of the above. |

Builder fluent methods:

| Method | Purpose |
|---|---|
| `.expiryPolicyFactory(Factory<ExpiryPolicy>)` | Plug expiry. |
| `.evictionManagerFactory(Factory<EvictionManager<K, V>>)` | Plug eviction. The default factory is `CacheConfiguration.DefaultEvictionManagerFactory()`. |
| `.cacheLoaderFactory(Factory<CacheLoader<K, V>>)` | Plug a read-through loader. |
| `.cacheWriterFactory(Factory<CacheWriter<? super K, ? super V>>)` | Plug a write-through writer. |
| `.readThrough(boolean)` | Toggle read-through mode (requires a `cacheLoaderFactory`). |
| `.writeThrough(boolean)` | Toggle write-through mode (requires a `cacheWriterFactory`). |
| `.storeByValue(boolean)` | Serialize on every op. |
| `.enableStatistics(boolean)` | Enable JMX statistics (off by default). |
| `.enableManagement(boolean)` | Enable JMX management bean. |
| `.addListenerConfiguration(CacheEntryListenerConfiguration<K, V>)` | Attach a listener (Eclipse Store builder method, equivalent to JCache `MutableConfiguration.addCacheEntryListenerConfiguration`). |
| `.serializerFoundation(SerializerFoundation<?>)` | Override the serializer used for store-by-value. |
| `.build()` | Returns `CacheConfiguration<K, V>`. |

### `CacheManager`

Eclipse Store's impl extends `javax.cache.CacheManager` — use it through the
standard API.

### Entry & event types

| Class | Purpose |
|---|---|
| `CacheEntry<K,V>` | Eclipse Store's entry type with extras. |
| `CacheEvent<K,V>` | Event payload. |
| `CacheEventDispatcher` | Internal dispatch. |

## Configuration via files

Eclipse Store discovers cache properties from:

1. `eclipsestore.cache.configuration.path` system property (file path).
2. `eclipsestore-cache.properties` on the classpath.

Example:

```properties
eclipsestore.cache.defaultConfig=...
```

For most applications, programmatic configuration (Patterns A-F in SKILL.md) is
simpler.

## Hibernate integration (`cache-hibernate`)

```properties
hibernate.cache.use_second_level_cache=true
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
```

Short aliases `jcache` and `CacheRegionFactory` are also registered.

Do **not** also set `hibernate.javax.cache.provider` — that property is for
Hibernate's own `JCacheRegionFactory` (a different strategy).

Per-region expiry uses Hibernate's standard `hibernate.cache.<region>.ttl`.

## Spring integration

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
```

```properties
spring.cache.type=jcache
spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider
```

`@EnableCaching` + `@Cacheable` work as usual.

## Interactions with `EmbeddedStorageManager`

- A storage-backed cache uses the given `EmbeddedStorageManager` for persistence.
- You can share the same manager with the rest of your app's data, or isolate
  caches in a dedicated storage directory.
- Cache metadata (stats, expiry state) is not persisted across restarts by
  default — only the entries themselves.

## Exceptions

- `CacheException` — JSR-107 base.
- `CacheWriterException` / `CacheLoaderException` — for read/write-through.
- Eclipse Store-specific wrappers for serialization issues.
