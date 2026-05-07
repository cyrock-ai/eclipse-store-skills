# API catalogue — spring-boot

## Starter

Artifact: `org.eclipse.store:integrations-spring-boot3`.

Transitive: `storage-embedded`, `storage-embedded-configuration`.

## Auto-configured beans

| Bean | Qualifier | Type | Provided when |
|---|---|---|---|
| `EclipseStoreProperties` | `defaultEclipseStore` | `@ConfigurationProperties("org.eclipse.store")` | always |
| `EmbeddedStorageFoundationFactory` | — | builds foundations from `EclipseStoreProperties` | always (component scan) |
| `EmbeddedStorageFoundationSupplier<EmbeddedStorageFoundation<?>>` | `defaultEclipseStore` | factory of foundations | `auto-create-default-foundation=true` and `@ConditionalOnMissingBean` |
| `EmbeddedStorageManager` | `defaultEclipseStore` | storage manager | `auto-create-default-storage=true` and `@ConditionalOnMissingBean` |
| `LockAspect` | — | AOP lock around `@Read/@Write/@Mutex` | when `org.aspectj.lang.ProceedingJoinPoint` is on the classpath |

The qualifier constant is exposed as
`DefaultEclipseStoreConfiguration.DEFAULT_QUALIFIER`.

## AOP annotations

Package: `org.eclipse.store.integrations.spring.boot.types.concurrent`.

| Annotation | `@Target` | Purpose |
|---|---|---|
| `@Read` | `METHOD` only | Read-lock during method. |
| `@Write` | `METHOD` only | Write-lock during method. |
| `@Mutex(String value)` | `TYPE`, `METHOD` | Named lock scope. The `value` is mandatory (no default). Method-level wins over class-level. |

`LockAspect` keeps a `ConcurrentHashMap<String, ReentrantReadWriteLock>` for named
locks plus one shared global lock used when no `@Mutex` applies. The aspect is
non-fair by default. Activation condition: `ProceedingJoinPoint` on the classpath
(implied by `aspectjweaver`, which is a regular dep of the starter; AOP weaving
itself still needs `spring-boot-starter-aop` to be on the user's classpath so
Spring Boot enables `AopAutoConfiguration`).

## Config class

`org.eclipse.store.integrations.spring.boot.types.configuration.EclipseStoreProperties`
binds everything under `org.eclipse.store.*` (`@ConfigurationProperties(prefix
= "org.eclipse.store")` in `DefaultEclipseStoreConfiguration`). Nested AFS
config lives on `StorageFilesystem` (and the `aws/`, `azure/`, `googlecloud/`,
`oraclecloud/`, `redis/`, `sql/` subpackages).

For the full property list — including every cloud backend's keys, defaults,
and credentials variants — see `references/properties-reference.md`.

## Startup hooks

`org.eclipse.store.integrations.spring.boot.types.initializers.StorageContextInitializer`:

```java
public interface StorageContextInitializer {
    void initialize();
}
```

Declare as a `@Bean`; the factory looks it up via
`applicationContext.getBean(StorageContextInitializer.class)` and calls
`initialize()` **before** the foundation is built. The hook receives no foundation
reference, so use it only for global side-effects (e.g. installing a custom
`LazyReferenceManager`, application-side logging).

For foundation-level configuration, define your own `EmbeddedStorageManager` bean
— the default manager is `@ConditionalOnMissingBean` so it steps aside, and no
qualifiers are needed in a single-database app. See
`references/advanced-foundation-override.md`.

## REST console

Artifact: `integrations-spring-boot3-console` (Vaadin-based UI). Activates simply by
being on the classpath (the auto-config keys off the artifact, not a master enable
toggle in the storage starter).

Properties bound to `RestConsoleProperties` (prefix `org.eclipse.store.console`):

| Property | Default | Purpose |
|---|---|---|
| `org.eclipse.store.console.ui.enabled` | `true` | Disable the Vaadin UI explicitly. |
| `vaadin.url-mapping` | — | Path for the Vaadin frontend. |

The console is read-only — the protocol does not expose writes. The data exposed is
your application's data, so apply the same auth/network controls as on the
application itself.

## Profiles

Standard Spring Boot profiles work. Typical layout:

- `application.properties` — common settings (root class, auto-start).
- `application-dev.properties` — local directory, small channel count.
- `application-prod.properties` — cloud storage + credentials + backup.

## Testing

Standard `@SpringBootTest`; override storage directory per test:

```java
@DynamicPropertySource
static void props(DynamicPropertyRegistry reg) {
    reg.add("org.eclipse.store.storage-directory",
        () -> Files.createTempDirectory("es").toString());
}
```

Or use `@TestPropertySource`.
