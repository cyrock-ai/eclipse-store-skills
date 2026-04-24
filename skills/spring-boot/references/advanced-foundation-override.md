# Advanced foundation override — spring-boot

For use cases the starter doesn't cover via properties:

- Custom type handlers.
- Eager field evaluators.
- Replaced `StorageChannelCountProvider` (e.g., read from ZooKeeper).
- Read-only mode.
- A second independent database.

## Pattern 1 — `StorageContextInitializer` for foundation hooks

Recommended: you get the default property-driven foundation, plus your tweaks.

```java
@Configuration
public class StorageConfig {

    @Bean
    public StorageContextInitializer init() {
        return foundation -> {
            foundation.onConnectionFoundation(cf -> {
                // Custom type handlers
                cf.registerCustomTypeHandler(new MoneyHandler());

                // Eager field evaluator
                cf.setReferenceFieldEagerEvaluator(
                    (type, field) -> field.isAnnotationPresent(StoreEagerly.class)
                );

                // Custom root resolver for constants, aux roots, etc.
                // cf.getRootResolverProvider().registerConstantInstance(AppConstants.SYSTEM_USER);
            });
        };
    }
}
```

## Pattern 2 — Read-only mode

Wrap the write controller from the foundation:

```java
@Bean
public StorageContextInitializer readOnlyInit() {
    return foundation -> {
        var ro = new StorageWriteControllerReadOnlyMode(foundation.getWriteController());
        foundation.setWriteController(ro);
    };
}
```

All `@Write` calls on Eclipse Store operations will throw. Useful for reporting
replicas.

## Pattern 3 — Replacing `EmbeddedStorageFoundationFactory`

If you need complete control (e.g., build the foundation from code, skipping
the property-driven path entirely):

```java
@Configuration
public class StorageConfig {

    @Bean
    @Primary
    public EmbeddedStorageFoundationFactory customFactory() {
        return (props, root) -> {
            // Build foundation manually
            return EmbeddedStorage.Foundation(
                StorageConfiguration.Builder()
                    .setChannelCountProvider(StorageChannelCountProvider.New(4))
                    // ... etc
                    .createConfiguration()
            );
        };
    }
}
```

Downside: you lose the starter's cloud property wiring. Only use when the
property path truly can't express your setup.

## Pattern 4 — Two independent databases

No first-class support. Manual:

```java
@Configuration
public class MultiStorageConfig {

    @Bean
    @Qualifier("ordersStorage")
    public EmbeddedStorageManager ordersStorage() {
        return EmbeddedStorage.start(new OrdersRoot(), Paths.get("data/orders"));
    }

    @Bean
    @Qualifier("inventoryStorage")
    public EmbeddedStorageManager inventoryStorage() {
        return EmbeddedStorage.start(new InventoryRoot(), Paths.get("data/inventory"));
    }
}
```

Disable the default bean:

```properties
org.eclipse.store.auto-create-default-storage=false
```

Inject with `@Qualifier`:

```java
public MyService(@Qualifier("ordersStorage") EmbeddedStorageManager s) { ... }
```

Warning: you're off the well-trodden path. Each manager needs its own root, its
own directory, its own lifecycle. AOP aspects share a single lock unless you
use distinct `@Mutex` names.

## Pattern 5 — Programmatic type handler registration without a Spring bean

If you're using the foundation pattern but want type handlers registered via a
utility function:

```java
public static StorageContextInitializer registerHandlers(CustomBinaryHandler<?>... hs) {
    return foundation -> foundation.onConnectionFoundation(cf -> {
        for (var h : hs) cf.registerCustomTypeHandler(h);
    });
}
```

```java
@Bean
public StorageContextInitializer init() {
    return registerHandlers(new MoneyHandler(), new ZoneIdHandler());
}
```

## Caveats

- `StorageContextInitializer` runs **once** at startup. Per-request
  customization is not possible.
- Overriding beans causes Spring to log a warning; ensure `@Primary` or
  `@ConditionalOnMissingBean` semantics are explicit.
- If you bypass the property path entirely, document it — future maintainers
  will look for `org.eclipse.store.*` properties and be confused.
