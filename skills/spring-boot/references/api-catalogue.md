# API catalogue — spring-boot

## Starter

Artifact: `org.eclipse.store:integrations-spring-boot3`.

Transitive: `storage-embedded`, `storage-embedded-configuration`.

## Auto-configured beans

| Bean | Type | Provided when |
|---|---|---|
| `EmbeddedStorageManager` | storage manager | `org.eclipse.store.auto-create-default-storage=true` (default) |
| `EmbeddedStorageFoundationFactory` | builds the foundation | always |
| `EclipseStoreProperties` | `@ConfigurationProperties("org.eclipse.store")` | always |
| `LockAspect` | AOP lock around `@Read/@Write/@Mutex` | when AOP is on the classpath |

## AOP annotations

Package: `org.eclipse.store.integrations.spring.boot.types.concurrent`.

| Annotation | Target | Purpose |
|---|---|---|
| `@Read` | method | Read-lock during method. |
| `@Write` | method | Write-lock during method. |
| `@Mutex(String name)` | class/method | Named lock scope. Default global if absent. |

`LockAspect.java` implements the behaviour — a single `ReentrantReadWriteLock`
per name (or one global lock without name).

## Config class

`org.eclipse.store.integrations.spring.boot.types.configuration.EclipseStoreProperties`
binds everything under `org.eclipse.store.*`. Key fields:

| Field | Property |
|---|---|
| `root` | `org.eclipse.store.root` (FQCN) |
| `storageDirectory` | `org.eclipse.store.storage-directory` |
| `storageFilesystem` | `org.eclipse.store.storage-filesystem.*` — nested AFS config |
| `deletionDirectory` | `org.eclipse.store.deletion-directory` |
| `truncationDirectory` | `org.eclipse.store.truncation-directory` |
| `backupDirectory` | `org.eclipse.store.backup-directory` |
| `backupFilesystem` | `org.eclipse.store.backup-filesystem.*` |
| `channelCount` | `org.eclipse.store.channel-count` |
| `channelDirectoryPrefix` | `org.eclipse.store.channel-directory-prefix` |
| `dataFilePrefix` / `dataFileSuffix` | … |
| `transactionFilePrefix` / `transactionFileSuffix` | … |
| `typeDictionaryFileName`, `rescuedFileSuffix`, `lockFileName` | naming |
| `housekeepingInterval`, `housekeepingTimeBudget` | housekeeping |
| `housekeepingAdaptive`, `housekeepingIncreaseThreshold`, `housekeepingIncreaseAmount`, `housekeepingMaximumTimeBudget` | housekeeping |
| `entityCacheThreshold`, `entityCacheTimeout` | entity cache |
| `dataFileMinimumSize`, `dataFileMaximumSize`, `dataFileMinimumUseRatio`, `dataFileCleanupHeadFile` | file compaction |
| `transactionFileMaximumSize` | transaction log cap |

Nested AWS S3 properties via
`org.eclipse.store.integrations.spring.boot.types.configuration.aws.S3`:

| Property | Values |
|---|---|
| `org.eclipse.store.storage-filesystem.aws.s3.region` | region id |
| `.endpoint-override` | URL |
| `.directory-bucket` | boolean |
| `.credentials.type` | static / env / system-properties / default |
| `.credentials.access-key-id` | static only |
| `.credentials.secret-access-key` | static only |
| `.cache` | boolean |

Similar nesting for Azure (`azure.storage.*`), GCP Firestore, OCI, etc.

## Startup hooks

`org.eclipse.store.integrations.spring.boot.types.StorageContextInitializer`:

```java
@FunctionalInterface
public interface StorageContextInitializer {
    void initialize(EmbeddedStorageFoundation<?> foundation);
}
```

Declare as a `@Bean`; runs before `EmbeddedStorageManager` is created. Use for:

- Custom type handlers.
- Eager field evaluators.
- Constant registration.

Example:

```java
@Bean
public StorageContextInitializer init() {
    return foundation -> foundation.onConnectionFoundation(cf ->
        cf.registerCustomTypeHandler(new MoneyHandler())
    );
}
```

## REST console

Artifact: `integrations-spring-boot3-console` (Vaadin-based UI).

Properties:

| Property | Default | Purpose |
|---|---|---|
| `org.eclipse.store.rest.enabled` | `false` | Enable the REST+UI console. |
| `vaadin.url-mapping` | — | Path for the Vaadin frontend. |

The console is read-only.

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
