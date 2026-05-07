# Foundation override — spring-boot

When properties don't expose what you need (swapping a pluggable component on
the foundation, wrapping the write controller, registering custom type
handlers, tweaking the root resolver), reach for the foundation in code.

The mechanism is always the same: define your own `EmbeddedStorageManager`
bean. The default is `@ConditionalOnMissingBean`, so yours wins; you keep the
property-driven base config because you still inject the auto-configured
factories.

## The shape

Inject the auto-configured `EclipseStoreProperties`,
`EmbeddedStorageFoundationFactory`, and `EmbeddedStorageManagerFactory` via
constructor. In the bean method, build the foundation, configure it, hand it
to the manager factory.

```java
@Configuration
public class StorageConfig {

    private final EclipseStoreProperties           props;
    private final EmbeddedStorageFoundationFactory foundationFactory;
    private final EmbeddedStorageManagerFactory    managerFactory;

    public StorageConfig(
        EclipseStoreProperties           props,
        EmbeddedStorageFoundationFactory foundationFactory,
        EmbeddedStorageManagerFactory    managerFactory
    ) {
        this.props             = props;
        this.foundationFactory = foundationFactory;
        this.managerFactory    = managerFactory;
    }

    @Bean
    public EmbeddedStorageManager storage() {
        EmbeddedStorageFoundation<?> foundation =
            foundationFactory.createStorageFoundation(props);

        // Configure the foundation in code here.

        return managerFactory.createStorage(foundation, props.isAutoStart());
    }
}
```

The `// Configure …` line is the hook for everything below. Swap one line per
concern:

- **Connection-foundation tweaks** (custom type handlers, eager-field
  evaluators, root resolver):
  ```java
  foundation.onConnectionFoundation(cf -> { /* … */ });
  ```
  Handler details live in `custom-type-handlers`; constants and named roots
  in `root-and-object-graph`.

- **Read-only mode** — wrap the write controller:
  ```java
  foundation.setWriteController(
      new StorageWriteControllerReadOnlyMode(foundation.getWriteController())
  );
  ```
  All write operations throw. Useful for reporting replicas.

- **Replace any pluggable foundation component** — `setChannelCountProvider`,
  `setStorageSystem`, `setHousekeepingController`, … See
  `EmbeddedStorageFoundation` and its parent `StorageFoundation` for the full
  set of setters.

## Per-database foundation customization

Plain multi-database wiring (qualified managers, per-prefix
`EclipseStoreProperties`) lives in SKILL.md Pattern G — that uses the factory
unchanged for every store.

This page only adds value when *each* store needs a different foundation
configuration (one read-only, one with extra type handlers, one with a custom
channel-count provider, …). Build each foundation independently in its own
`@Bean` method and configure it inline:

```java
@Configuration
public class StorageConfig {

    private final EmbeddedStorageFoundationFactory foundationFactory;
    private final EmbeddedStorageManagerFactory    managerFactory;

    public StorageConfig(
        EmbeddedStorageFoundationFactory foundationFactory,
        EmbeddedStorageManagerFactory    managerFactory
    ) {
        this.foundationFactory = foundationFactory;
        this.managerFactory    = managerFactory;
    }

    @Bean("orders") @ConfigurationProperties("org.eclipse.store.orders")
    EclipseStoreProperties ordersProperties()  { return new EclipseStoreProperties(); }

    @Bean("reports") @ConfigurationProperties("org.eclipse.store.reports")
    EclipseStoreProperties reportsProperties() { return new EclipseStoreProperties(); }

    @Bean @Qualifier("orders")
    EmbeddedStorageManager ordersStore(@Qualifier("orders") EclipseStoreProperties p) {
        EmbeddedStorageFoundation<?> f = foundationFactory.createStorageFoundation(p);
        f.onConnectionFoundation(cf -> { /* orders-specific handlers / hooks */ });
        return managerFactory.createStorage(f, p.isAutoStart());
    }

    @Bean @Qualifier("reports")
    EmbeddedStorageManager reportsStore(@Qualifier("reports") EclipseStoreProperties p) {
        EmbeddedStorageFoundation<?> f = foundationFactory.createStorageFoundation(p);
        f.setWriteController(
            new StorageWriteControllerReadOnlyMode(f.getWriteController())
        );
        return managerFactory.createStorage(f, p.isAutoStart());
    }
}
```

Each foundation is independent — what you do to `f` in one bean has no effect
on the other. Don't forget to disable the auto-created defaults so they don't
race the named ones:

```properties
org.eclipse.store.auto-create-default-foundation=false
org.eclipse.store.auto-create-default-storage=false
```

## What `StorageContextInitializer` is *not* for

`StorageContextInitializer.initialize()` is a no-arg pre-foundation hook. It
runs **before** the foundation is built and receives no reference to it, so
it cannot register handlers or swap components. Reserve it for application-
side global setup (e.g. a custom `LazyReferenceManager`) that runs once at
startup.
