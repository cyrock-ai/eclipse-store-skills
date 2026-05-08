# Examples-expanded — cache-jcache

## Example 1 — Standalone cache (in-memory only)

```java
import java.util.concurrent.TimeUnit;
import javax.cache.*;
import javax.cache.configuration.*;
import javax.cache.expiry.*;

CachingProvider provider = Caching.getCachingProvider();
CacheManager    cm       = provider.getCacheManager();

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
    .storeByReference()
    .enableStatistics()
    .build();

Cache<String, Customer> cache = cm.createCache("customers", cfg);
cache.put("alice@acme.com", customer);
// Restart JVM — the entry is still there.
// Note: TTL counter resets on the next get after restart (Pitfall 5).
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

`pom.xml`:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>cache</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

Wire caches through a `JCacheManagerCustomizer` bean. Constructor-inject
the `EmbeddedStorageManager` so storage-backed caches always see an
initialized manager (Pitfall 8):

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
        // In-memory
        cacheManager.createCache("sessions", new MutableConfiguration<>()
            .setTypes(String.class, Session.class)
            .setStoreByValue(false)
            .setExpiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
                new Duration(TimeUnit.MINUTES, 30)))
            .setStatisticsEnabled(true));

        // Storage-backed — entries persist across restarts
        cacheManager.createCache("customers", CacheConfiguration
            .Builder(String.class, Customer.class, "customers", storage)
            .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(Duration.ONE_HOUR))
            .build());
    }
}

@Service
public class CustomerService {
    @Cacheable("customers")
    public Customer findById(String id) { return loadExpensive(id); }

    @CacheEvict("customers")
    public void invalidate(String id) {}
}
```

## Example 5 — Hibernate second-level cache

`pom.xml`:

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>cache-hibernate</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

Configuration (`application.properties`):

```properties
spring.jpa.properties.hibernate.cache.eclipsestore.missing_cache_strategy=create
spring.jpa.properties.hibernate.cache.region.factory_class=org.eclipse.store.cache.hibernate.types.CacheRegionFactory
spring.jpa.properties.hibernate.cache.use_query_cache=true
spring.jpa.properties.hibernate.cache.use_second_level_cache=true
spring.jpa.properties.javax.persistence.sharedCache.mode=ALL
```

For plain Hibernate (`hibernate.properties` / `persistence.xml`), drop the
`spring.jpa.properties.` prefix.

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
session.createQuery("from Customer c", Customer.class)
    .setCacheable(true)
    .setCacheRegion("customers")
    .list();
```

Eclipse Store is now the L2 backing store. Region behavior follows
Hibernate's standard region settings.

## Example 6 — Measuring effectiveness

Statistics are off by default. Enable on the configuration, then read via
`Cache.unwrap(...)`:

```java
import javax.cache.management.CacheMXBean;
import javax.cache.management.CacheStatisticsMXBean;

cfg.setStatisticsEnabled(true);                                 // (1)
// ... use the cache ...

CacheStatisticsMXBean stats = cache.unwrap(CacheStatisticsMXBean.class);
System.out.println("hits:   " + stats.getCacheHits());
System.out.println("misses: " + stats.getCacheMisses());
System.out.println("rate:   " + stats.getCacheHitPercentage() + "%");

CacheMXBean cfgMBean = cache.unwrap(CacheMXBean.class);         // (2)
```

(1) Or `.enableStatistics()` on the Eclipse Store builder. Off by default.
(2) The same MBeans are also registered with the platform `MBeanServer`
under `javax.cache:type=CacheStatistics,CacheManager=…,Cache=…` for
external monitoring tools (JConsole, VisualVM, Prometheus exporters).

## Example 7 — Read-through to a database with `CacheLoader`

A storage-backed cache is already read- and write-through *to its storage*.
For read-through to a **different** system of record (a JDBC database
here), layer a `CacheLoader`:

```java
import javax.cache.integration.*;
import javax.cache.configuration.FactoryBuilder;

public class JdbcCustomerLoader implements CacheLoader<String, Customer> {
    private final DataSource ds;
    public JdbcCustomerLoader(DataSource ds) { this.ds = ds; }

    @Override
    public Customer load(String email) throws CacheLoaderException {
        try (Connection c = ds.getConnection();
             PreparedStatement p = c.prepareStatement(
                 "select * from customers where email = ?")) {
            p.setString(1, email);
            try (ResultSet rs = p.executeQuery()) {
                return rs.next() ? Customer.of(rs) : null;
            }
        } catch (SQLException ex) {
            throw new CacheLoaderException(ex);
        }
    }

    @Override
    public Map<String, Customer> loadAll(Iterable<? extends String> keys) {
        Map<String, Customer> out = new HashMap<>();
        for (String k : keys) out.put(k, load(k));
        return out;
    }
}

CacheConfiguration<String, Customer> cfg = CacheConfiguration
    .Builder(String.class, Customer.class)
    .cacheLoaderFactory(FactoryBuilder.factoryOf(new JdbcCustomerLoader(ds)))
    .readThrough(true)
    .expiryPolicyFactory(CreatedExpiryPolicy.factoryOf(
        new Duration(TimeUnit.MINUTES, 5)))
    .build();
```

Mirror with `CacheWriter` + `cacheWriterFactory(...)` + `writeThrough(true)`
to write-through inserts/updates back to the database.

## Example 8 — Loading config from `eclipsestore-cache.properties`

`cache-config.properties` (on the classpath):

```properties
key-type   = java.lang.Integer
value-type = java.lang.String

read-through  = true
write-through = true

storage-configuration-resource-name = eclipsestore-storage.properties
```

`eclipsestore-storage.properties`:

```properties
storage-directory = ~/cache-data
channel-count     = 4
```

Java:

```java
CacheConfiguration<Integer, String> cfg = CacheConfiguration
    .load("cache-config.properties", Integer.class, String.class);
Cache<Integer, String> cache = cacheManager.createCache("jCache", cfg);
```

Or place a file named `eclipsestore-cache.properties` on the classpath and
call the no-arg variant:

```java
CacheConfiguration<Integer, String> cfg = CacheConfiguration
    .load(Integer.class, String.class);
```

The system property `eclipsestore.cache.configuration.path` overrides the
default file lookup if set.
