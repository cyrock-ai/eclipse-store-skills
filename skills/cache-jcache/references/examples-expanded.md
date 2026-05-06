# Examples-expanded — cache-jcache

## Example 1 — Standalone cache (in-memory only)

```java
import java.util.concurrent.TimeUnit;
import javax.cache.*;
import javax.cache.configuration.*;
import javax.cache.expiry.*;

CachingProvider provider = Caching.getCachingProvider();
CacheManager cm = provider.getCacheManager();

MutableConfiguration<String, Customer> cfg =
    new MutableConfiguration<String, Customer>()
        .setTypes(String.class, Customer.class)
        .setStoreByValue(false)
        .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
            new Duration(TimeUnit.MINUTES, 30)))
        .setStatisticsEnabled(true);

Cache<String, Customer> cache = cm.createCache("customers", cfg);
cache.put("alice@acme.com", loadFromDb("alice@acme.com"));
Customer c = cache.get("alice@acme.com");
```

JVM restart clears the cache.

## Example 2 — Storage-backed cache (persistent)

```java
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.cache.types.CacheConfiguration;

EmbeddedStorageManager storage = EmbeddedStorage.start(
    java.nio.file.Paths.get("cache-storage"));

CachingProvider provider = Caching.getCachingProvider(
    "org.eclipse.store.cache.types.CachingProvider");
CacheManager cm = provider.getCacheManager();

CacheConfiguration<String, Customer> cfg = CacheConfiguration
    .Builder(String.class, Customer.class, "customers", storage)
    .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
        new Duration(TimeUnit.HOURS, 1)))
    .storeByValue(false)
    .enableStatistics(true)
    .build();

Cache<String, Customer> cache = cm.createCache("customers", cfg);
cache.put("alice@acme.com", customer);
// Restart JVM — the entry is still there
```

## Example 3 — With entry listener

```java
import javax.cache.event.*;

CacheEntryCreatedListener<String, Customer> createdListener = events -> {
    for (CacheEntryEvent<? extends String, ? extends Customer> e : events) {
        System.out.println("created " + e.getKey());
    }
};

cfg.addCacheEntryListenerConfiguration(
    new MutableCacheEntryListenerConfiguration<>(
        FactoryBuilder.factoryOf(createdListener),
        null,
        /*oldValueRequired=*/ false,
        /*synchronous=*/ false));
```

Async listener — the cache doesn't wait on its completion.

## Example 4 — Spring Boot + Eclipse Store JCache

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
  </dependency>
  <dependency>
    <groupId>org.eclipse.store</groupId>
    <artifactId>cache</artifactId>
    <version>${eclipse-store.version}</version>
  </dependency>
</dependencies>
```

`application.properties`:

```properties
spring.cache.type=jcache
spring.cache.jcache.provider=org.eclipse.store.cache.types.CachingProvider
spring.cache.cache-names=customers,orders
```

`CacheConfig.java`:

```java
@Configuration
@EnableCaching
public class CacheConfig {}
```

Use:

```java
@Service
public class CustomerService {
    @Cacheable("customers")
    public Customer findById(String id) {
        return loadExpensive(id);
    }

    @CacheEvict("customers")
    public void invalidate(String id) {}
}
```

For storage-backed caches, create the cache programmatically at startup before
Spring tries to use it, or via a JCache XML config referenced from
`spring.cache.jcache.config`.

## Example 5 — Hibernate second-level cache

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>cache-hibernate</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

`hibernate.properties`:

```properties
hibernate.cache.use_second_level_cache=true
hibernate.cache.use_query_cache=true
hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
# Or use the registered short alias: hibernate.cache.region.factory_class=jcache
```

Eclipse Store's region factory does not delegate through JCache, so do **not**
also set `hibernate.javax.cache.provider`. (That property only matters if you use
Hibernate's own `JCacheRegionFactory`, a different strategy.)

Entities:

```java
@Entity
@org.hibernate.annotations.Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
public class Customer {
    @Id private String email;
    // ...
}
```

Queries:

```java
session.createQuery("from Customer c")
    .setCacheable(true)
    .setCacheRegion("customers")
    .list();
```

Eclipse Store is now the L2 backing store. Persist or not per-region via
standard JCache configuration.

## Example 6 — Measuring effectiveness

```java
CacheStatisticsMXBean stats = cache.unwrap(CacheStatisticsMXBean.class);
System.out.println("hits: "    + stats.getCacheHits());
System.out.println("misses: "  + stats.getCacheMisses());
System.out.println("rate: "    + stats.getCacheHitPercentage() + "%");
```

Requires `.enableStatistics(true)` on the config (off by default).

## Example 7 — Near-cache topology

Common pattern: fast local cache in front of a durable storage-backed cache.

```java
// Local: pure in-memory, 10k entries, short TTL
Cache<String, Customer> near = cm.createCache("customers-near",
    new MutableConfiguration<String, Customer>()
        .setTypes(String.class, Customer.class)
        .setStoreByValue(false)
        .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
            new Duration(TimeUnit.SECONDS, 30))));

// Durable: storage-backed
Cache<String, Customer> durable = cm.createCache("customers-durable",
    CacheConfiguration.Builder(String.class, Customer.class, "customers-durable", storage)
        .build());

public Customer find(String id) {
    Customer c = near.get(id);
    if (c != null) return c;
    c = durable.get(id);
    if (c != null) near.put(id, c);
    return c;
}
```

A higher-level caching library might automate this; JCache itself does not.
