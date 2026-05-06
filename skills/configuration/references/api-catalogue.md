# API catalogue — configuration

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `EmbeddedStorageConfiguration` (factory + loader)

Artifact: `org.eclipse.store:storage-embedded-configuration`.

| Method | Purpose |
|---|---|
| `static EmbeddedStorageConfigurationBuilder Builder()` | New fluent builder. |
| `static EmbeddedStorageConfigurationBuilder load()` | Loads the default config (classpath `eclipsestore.properties` or path in system property `org.eclipse.store.storage.configuration.path`). |
| `static EmbeddedStorageConfigurationBuilder load(String path)` | Loads from classpath path; auto-detects INI/XML/properties. |
| `static EmbeddedStorageConfigurationBuilder load(ConfigurationLoader, ConfigurationParser)` | Loads from any source + parser; used for YAML/HOCON/JSON. |

## `EmbeddedStorageConfigurationBuilder` setters

Full list corresponds to property names in `EmbeddedStorageConfigurationPropertyNames`.

### Directories & file system

| Setter | Property | Default |
|---|---|---|
| `setStorageDirectory(String)` | `storage-directory` | `"storage"` |
| `setStorageDirectoryInUserHome(String)` | — | `"~/" + arg` |
| `setStorageFileSystem(...)` | `storage-filesystem` | local NIO |
| `setDeletionDirectory(String)` | `deletion-directory` | unset (files are deleted) |
| `setTruncationDirectory(String)` | `truncation-directory` | unset |
| `setBackupDirectory(String)` | `backup-directory` | unset (no backup) |
| `setBackupFileSystem(...)` | `backup-filesystem` | local NIO |

### Channels & file names

| Setter | Property | Default |
|---|---|---|
| `setChannelCount(int)` | `channel-count` | `1` (must be power of 2) |
| `setChannelDirectoryPrefix(String)` | `channel-directory-prefix` | `"channel_"` |
| `setDataFilePrefix(String)` | `data-file-prefix` | `"channel_"` |
| `setDataFileSuffix(String)` | `data-file-suffix` | `"dat"` |
| `setTransactionFilePrefix(String)` | `transaction-file-prefix` | `"transactions_"` |
| `setTransactionFileSuffix(String)` | `transaction-file-suffix` | `"sft"` |
| `setTypeDictionaryFileName(String)` | `type-dictionary-file-name` | `"PersistenceTypeDictionary.ptd"` |
| `setRescuedFileSuffix(String)` | `rescued-file-suffix` | `"bak"` |
| `setLockFileName(String)` | `lock-file-name` | `"used.lock"` |

### Housekeeping

| Setter | Property | Default |
|---|---|---|
| `setHousekeepingInterval(Duration)` | `housekeeping-interval` | `1 s` |
| `setHousekeepingTimeBudget(Duration)` | `housekeeping-time-budget` | `10 ms` |
| `setHousekeepingAdaptive(boolean)` | `housekeeping-adaptive` | `false` |
| `setHousekeepingIncreaseThreshold(Duration)` | `housekeeping-increase-threshold` | `5 s` |
| `setHousekeepingIncreaseAmount(Duration)` | `housekeeping-increase-amount` | `50 ms` |
| `setHousekeepingMaximumTimeBudget(Duration)` | `housekeeping-maximum-time-budget` | `500 ms` |

### Entity cache (LRU for loaded entities)

| Setter | Property | Default |
|---|---|---|
| `setEntityCacheThreshold(long)` | `entity-cache-threshold` | `1_000_000_000` |
| `setEntityCacheTimeout(Duration)` | `entity-cache-timeout` | `1 d` |

### Data file thresholds

| Setter | Property | Default |
|---|---|---|
| `setDataFileMinimumSize(ByteSize)` | `data-file-minimum-size` | `1 MiB` |
| `setDataFileMaximumSize(ByteSize)` | `data-file-maximum-size` | `8 MiB` |
| `setDataFileMinimumUseRatio(double)` | `data-file-minimum-use-ratio` | `0.75` |
| `setDataFileCleanupHeadFile(boolean)` | `data-file-cleanup-head-file` | `false` |
| `setTransactionFileMaximumSize(ByteSize)` | `transaction-file-maximum-size` | `100 MB` (max 1 GB) |

### Completion

| Method | Returns |
|---|---|
| `createConfiguration()` | `StorageConfiguration` |
| `createEmbeddedStorageFoundation()` | `EmbeddedStorageFoundation<?>` |
| `createEmbeddedStorageManager()` | `EmbeddedStorageManager` (unstarted; call `.start()`) |

## `EmbeddedStorageConfigurationPropertyNames`

Constants for every property. Use when programmatically building or parsing:

```java
String key = EmbeddedStorageConfigurationPropertyNames.STORAGE_DIRECTORY;
```

## `ConfigurationLoader` & `ConfigurationParser`

Package: `org.eclipse.serializer.configuration.types`.

| Method | Purpose |
|---|---|
| `ConfigurationLoader.New(String path)` | Classpath resource loader. |
| `ConfigurationLoader.New(File)` | File system loader. |
| `ConfigurationParserIni.New()` | INI parser. |
| `ConfigurationParserXml.New()` | XML parser. |
| `ConfigurationParserYaml.New()` | YAML parser — `org.eclipse.serializer.configuration.yaml.types`; requires `configuration-yaml`. |
| `ConfigurationParserHocon.New()` | HOCON/JSON parser — `org.eclipse.serializer.configuration.hocon.types`; requires `configuration-hocon`. |

## Foundation-level configuration (advanced)

For one-off customization that the builder doesn't expose:

| Type | Purpose |
|---|---|
| `StorageConfiguration` | The immutable aggregate of all settings. |
| `StorageConfiguration.Builder` | Lower-level than the `EmbeddedStorage*` one. |
| `StorageFileProvider` / `StorageLiveFileProvider` | Where the live files go. |
| `StorageChannelCountProvider` | Supplies channel count; can be dynamic. |
| `StorageBackupSetup` | Backup destination configuration. |
| `StorageHousekeepingController` | The interval/budget policy. |
| `StorageDataFileEvaluator` | Decides when files are cleaned / merged. |
| `StorageEntityCacheEvaluator` | Decides when loaded entities are evicted. |
| `StorageWriteController` | Gate for all writes; the hook used for read-only. |
| `StorageWriteControllerReadOnlyMode` | Wraps a write controller to block writes. |

## Byte size and duration parsers

Files:

- `configuration/configuration/src/main/java/org/eclipse/serializer/configuration/types/DurationParser.java`
- `configuration/configuration/src/main/java/org/eclipse/serializer/configuration/types/ByteSizeParser.java`

Accepted forms:

| Duration | Bytes |
|---|---|
| `ns`, `ms`, `s`, `m`, `h`, `d` | `b`, `kb`, `kib`, `mb`, `mib`, `gb`, `gib`, `tb`, `tib`, `pb`, `pib` |
| ISO-8601: `PT1H30M`, `P1DT2H` | |

Whitespace between number and unit is tolerated.
