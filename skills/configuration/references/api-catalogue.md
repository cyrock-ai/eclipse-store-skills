# API catalogue — configuration

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `EmbeddedStorageConfiguration` (factory + loader)

Artifact: `org.eclipse.store:storage-embedded-configuration`.

| Method | Purpose |
|---|---|
| `static EmbeddedStorageConfigurationBuilder Builder()` | New fluent builder. |
| `static EmbeddedStorageConfigurationBuilder load()` | Loads the default config (classpath `eclipsestore.properties` or path in system property `org.eclipse.store.storage.configuration.path`). |
| `static EmbeddedStorageConfigurationBuilder load(String path)` | Resolves `path` via (1) `ClassLoader.getResource(path)` — **no leading slash**, (2) URL, (3) filesystem `File(path)`. Auto-detects INI/XML/properties by extension. |
| `static EmbeddedStorageConfigurationBuilder load(ConfigurationLoader, ConfigurationParser)` | Loads from any source + parser; used for YAML/HOCON/JSON. |

## `EmbeddedStorageConfigurationBuilder` setters

Full list corresponds to property names in `EmbeddedStorageConfigurationPropertyNames`.

### Directories & file system

| Setter | Property | Type | Default | Description |
|---|---|---|---|---|
| `setStorageDirectory(String)` | `storage-directory` | String | `"storage"` | Base directory of live files. `~` expands to user home. |
| `setStorageDirectoryInUserHome(String)` | — | String | `"~/" + arg` | Shortcut: resolves to a directory under user home. |
| `setStorageFileSystem(...)` | `storage-filesystem` | Complex | local NIO | File system backend (see `storage-targets-afs`). |
| `setDeletionDirectory(String)` | `deletion-directory` | String | unset | If set, files are moved here instead of deleted. |
| `setTruncationDirectory(String)` | `truncation-directory` | String | unset | If set, truncated files are copied here before truncation. |
| `setBackupDirectory(String)` | `backup-directory` | String | unset | Continuous backup destination. |
| `setBackupFileSystem(...)` | `backup-filesystem` | Complex | local NIO | File system backend for the backup. |

### Channels & file names

| Setter | Property | Type | Default | Description |
|---|---|---|---|---|
| `setChannelCount(int)` | `channel-count` | Integer | `1` | Number of IO channels. **Must be power of 2.** |
| `setChannelDirectoryPrefix(String)` | `channel-directory-prefix` | String | `"channel_"` | Subdirectory name prefix. |
| `setDataFilePrefix(String)` | `data-file-prefix` | String | `"channel_"` | Data file name prefix. |
| `setDataFileSuffix(String)` | `data-file-suffix` | String | `"dat"` | Data file extension. |
| `setTransactionFilePrefix(String)` | `transaction-file-prefix` | String | `"transactions_"` | Transaction file name prefix. |
| `setTransactionFileSuffix(String)` | `transaction-file-suffix` | String | `"sft"` | Transaction file extension. |
| `setTypeDictionaryFileName(String)` | `type-dictionary-file-name` | String | `"PersistenceTypeDictionary.ptd"` | Type dictionary file name. |
| `setRescuedFileSuffix(String)` | `rescued-file-suffix` | String | `"bak"` | Suffix for rescued files. |
| `setLockFileName(String)` | `lock-file-name` | String | `"used.lock"` | Process-level lock file name. |

### Housekeeping

| Setter | Property | Type | Default | Description |
|---|---|---|---|---|
| `setHousekeepingInterval(Duration)` | `housekeeping-interval` | Duration | `1 s` | Interval between housekeeping cycles. |
| `setHousekeepingTimeBudget(Duration)` | `housekeeping-time-budget` | Duration | `10 ms` | Budget per cycle (best effort). |
| `setHousekeepingAdaptive(boolean)` | `housekeeping-adaptive` | Boolean | `false` | Auto-raise budget when GC falls behind. |
| `setHousekeepingIncreaseThreshold(Duration)` | `housekeeping-increase-threshold` | Duration | `5 s` | Adaptive controller cycle. |
| `setHousekeepingIncreaseAmount(Duration)` | `housekeeping-increase-amount` | Duration | `50 ms` | Adaptive step size. |
| `setHousekeepingMaximumTimeBudget(Duration)` | `housekeeping-maximum-time-budget` | Duration | `500 ms` | Upper cap for adaptive budgets. |

### Entity cache (LRU for loaded entities)

| Setter | Property | Type | Default | Description |
|---|---|---|---|---|
| `setEntityCacheThreshold(long)` | `entity-cache-threshold` | Long | `1_000_000_000` | Abstract cache lifetime weight. |
| `setEntityCacheTimeout(Duration)` | `entity-cache-timeout` | Duration | `1 d` | Time after which unused entities evict. |

### Data file thresholds

| Setter | Property | Type | Default | Description |
|---|---|---|---|---|
| `setDataFileMinimumSize(ByteSize)` | `data-file-minimum-size` | Bytes | `1 MiB` | Below this, files are merged up. Hard max 2 GB. |
| `setDataFileMaximumSize(ByteSize)` | `data-file-maximum-size` | Bytes | `8 MiB` | Above this, files are split. Hard max 2 GB. |
| `setDataFileMinimumUseRatio(double)` | `data-file-minimum-use-ratio` | Double | `0.75` | Below this ratio of live data, files are compacted. |
| `setDataFileCleanupHeadFile(boolean)` | `data-file-cleanup-head-file` | Boolean | `false` | Whether to compact the currently-written file. |
| `setTransactionFileMaximumSize(ByteSize)` | `transaction-file-maximum-size` | Bytes | `100 MB` (max 1 GB) | Per-channel transaction log cap. |

### Property → configured type

Each property maps to one internal type. Useful when diagnosing "I set X but
it doesn't seem to take effect":

| Property | Configures |
|---|---|
| `storage-directory`, `deletion-directory`, `truncation-directory`, `storage-filesystem` | `StorageLiveFileProvider` |
| `backup-directory`, `backup-filesystem` | `StorageBackupSetup` |
| `channel-count` | `StorageChannelCountProvider` |
| `channel-directory-prefix`, `data-file-prefix`, `data-file-suffix`, `transaction-file-prefix`, `transaction-file-suffix`, `type-dictionary-file-name`, `rescued-file-suffix`, `lock-file-name` | `StorageFileNameProvider` |
| `housekeeping-*` | `StorageHousekeepingController` |
| `entity-cache-threshold`, `entity-cache-timeout` | `StorageEntityCacheEvaluator` |
| `data-file-*`, `transaction-file-maximum-size` | `StorageDataFileEvaluator` |

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
| `ConfigurationLoader.New(String path)` | Classpath resource (no leading slash) → URL → filesystem fallback. Throws `ConfigurationExceptionNoConfigurationFound` if none match. |
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
