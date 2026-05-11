# Examples-expanded — configuration

## Example 1 — Fluent builder, typical app

```java
import java.time.Duration;
import org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

EmbeddedStorageManager storage = EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data")
    .setBackupDirectory("backup")
    .setChannelCount(4)
    .setHousekeepingInterval(Duration.ofSeconds(1))
    .setHousekeepingTimeBudget(Duration.ofMillis(50))
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

## Example 2 — INI on the classpath

`src/main/resources/META-INF/eclipsestore/storage.ini`:

```ini
storage-directory = data
backup-directory = backup
channel-count = 4

housekeeping-interval = 1s
housekeeping-time-budget = 50ms
housekeeping-adaptive = true

data-file-minimum-size = 1 MiB
data-file-maximum-size = 8 MiB
data-file-minimum-use-ratio = 0.75

entity-cache-timeout = 1h
```

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration
    .load("META-INF/eclipsestore/storage.ini")
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

## Example 3 — XML config with user-home directory

`storage.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<properties>
    <property name="storage-directory" value="~/my-app/data"/>
    <property name="backup-directory"  value="~/my-app/backup"/>
    <property name="channel-count"     value="2"/>
    <property name="deletion-directory" value="~/my-app/deleted"/>
</properties>
```

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration
    .load("storage.xml")
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

## Example 4 — YAML config (requires `configuration-yaml`)

```xml
<dependency>
    <groupId>org.eclipse.serializer</groupId>
    <artifactId>configuration-yaml</artifactId>
    <version>${eclipse-serializer.version}</version>
</dependency>
```

```yaml
storage-directory: data
channel-count: 4
housekeeping-interval: 1s
housekeeping-time-budget: 50ms
```

```java
import org.eclipse.serializer.configuration.types.ConfigurationLoader;
import org.eclipse.serializer.configuration.yaml.types.ConfigurationParserYaml;

EmbeddedStorageManager storage = EmbeddedStorageConfiguration.load(
    ConfigurationLoader.New("META-INF/eclipsestore/storage.yaml"),
    ConfigurationParserYaml.New()
)
.createEmbeddedStorageFoundation()
.createEmbeddedStorageManager();
storage.start();
```

## Example 5 — Read-only manager over a file-system snapshot

```java
import org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageFoundation;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.storage.types.StorageWriteControllerReadOnlyMode;

EmbeddedStorageFoundation<?> foundation = EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data-readonly-copy")
    .setChannelCount(4)                         // MUST match the writer's channel count
    .createEmbeddedStorageFoundation();

var ro = new StorageWriteControllerReadOnlyMode(foundation.getWriteController());
foundation.setWriteController(ro);

try (EmbeddedStorageManager storage = foundation.createEmbeddedStorageManager()) {
    storage.start();
    AppRoot root = (AppRoot) storage.root();
    root.orders().forEach(System.out::println);
    // any storage.store(...) call throws AfsExceptionReadOnly
}
```

## Example 6 — Deep customization via raw foundation (custom file provider)

```java
import org.eclipse.store.afs.nio.types.NioFileSystem;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;
import org.eclipse.store.storage.types.Storage;
import org.eclipse.store.storage.types.StorageBackupSetup;
import org.eclipse.store.storage.types.StorageChannelCountProvider;
import org.eclipse.store.storage.types.StorageLiveFileProvider;

NioFileSystem fs = NioFileSystem.New();

EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
    Storage.ConfigurationBuilder()
        .setChannelCountProvider(StorageChannelCountProvider.New(4))
        .setStorageFileProvider(
            StorageLiveFileProvider.Builder()
                .setDirectory(fs.ensureDirectoryPath("data"))
                .createFileProvider()
        )
        .setBackupSetup(StorageBackupSetup.New(fs.ensureDirectoryPath("backup")))
        .createConfiguration()
).start(new AppRoot());
```

Use this style when the fluent builder doesn't cover your scenario — e.g., a
custom `StorageChannelCountProvider` that reads the count from ZooKeeper.

## Example 7 — System-property-driven config

Default on classpath: `src/main/resources/eclipsestore.properties`:

```properties
storage-directory = data
channel-count = 2
```

Prod override: `-Dorg.eclipse.store.storage.configuration.path=/etc/myapp/storage.ini`.

Java code:

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration.load()
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```

Ops changes the prod INI, restarts the service; no code change needed.

## Example 8 — Per-environment builders

Small helper to avoid repeating boilerplate:

```java
public final class StorageConfigs {
    public static EmbeddedStorageConfigurationBuilder dev() {
        return EmbeddedStorageConfiguration.Builder()
            .setStorageDirectory("data-dev")
            .setChannelCount(1)
            .setHousekeepingTimeBudget(Duration.ofMillis(5));
    }

    public static EmbeddedStorageConfigurationBuilder prod() {
        return EmbeddedStorageConfiguration.Builder()
            .setStorageDirectory("/var/lib/myapp/data")
            .setBackupDirectory("/var/lib/myapp/backup")
            .setDeletionDirectory("/var/lib/myapp/deleted")
            .setChannelCount(4)
            .setHousekeepingAdaptive(true)
            .setHousekeepingMaximumTimeBudget(Duration.ofMillis(500));
    }

    private StorageConfigs() {}
}
```

Call site:

```java
EmbeddedStorageManager storage = StorageConfigs.prod()
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
storage.start();
```
