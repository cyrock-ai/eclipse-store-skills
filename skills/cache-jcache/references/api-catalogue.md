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

| Builder method | Purpose |
|---|---|
| `CacheConfiguration.Builder(K.class, V.class, name)` | Not storage-backed. |
| `CacheConfiguration.Builder(K.class, V.class, name, EmbeddedStorageManager)` | Storage-backed. |
| `.expiryPolicyFactory(Factory<ExpiryPolicy>)` | Plug expiry. |
| `.evictionManagerFactory(...)` | Plug eviction. |
| `.writeThroughFactory(...)` | Plug write-through. |
| `.readThroughFactory(...)` | Plug read-through. |
| `.storeByValue(boolean)` | Serialize on every op. |
| `.statisticsEnabled(boolean)` | Enable JMX/stats. |
| `.managementEnabled(boolean)` | Enable JMX. |
| `.build()` | Returns `CacheConfiguration`. |

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
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.EclipseStoreCacheRegionFactory
hibernate.javax.cache.provider=org.eclipse.store.cache.types.CachingProvider
```

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
