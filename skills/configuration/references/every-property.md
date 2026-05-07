# Every configuration property

Reference table mirroring the upstream `properties.adoc`. Use for quick lookup when the
user asks "what does property X do / default?".

| Property | Type | Default | Description |
|---|---|---|---|
| `storage-directory` | String | `"storage"` | Base directory of live files. `~` expands to user home. |
| `storage-filesystem` | Complex | NIO | File system backend; see `storage-targets-afs`. |
| `deletion-directory` | String | unset | If set, files are moved here instead of deleted. |
| `truncation-directory` | String | unset | If set, truncated files are copied here before truncation. |
| `backup-directory` | String | unset | Continuous backup destination. |
| `backup-filesystem` | Complex | NIO | File system backend for the backup. |
| `channel-count` | Integer | `1` | Number of IO channels. Must be power of 2. |
| `channel-directory-prefix` | String | `"channel_"` | Subdirectory name prefix. |
| `data-file-prefix` | String | `"channel_"` | Data file name prefix. |
| `data-file-suffix` | String | `"dat"` | Data file extension. |
| `transaction-file-prefix` | String | `"transactions_"` | |
| `transaction-file-suffix` | String | `"sft"` | |
| `type-dictionary-file-name` | String | `"PersistenceTypeDictionary.ptd"` | |
| `rescued-file-suffix` | String | `"bak"` | |
| `lock-file-name` | String | `"used.lock"` | |
| `housekeeping-interval` | Duration | `1s` | Interval between housekeeping cycles. |
| `housekeeping-time-budget` | Duration | `10ms` | Budget per cycle (best effort). |
| `housekeeping-adaptive` | Boolean | `false` | Auto-raise budget when GC falls behind. |
| `housekeeping-increase-threshold` | Duration | `5s` | Adaptive controller cycle. |
| `housekeeping-increase-amount` | Duration | `50ms` | Adaptive step size. |
| `housekeeping-maximum-time-budget` | Duration | `500ms` | Upper cap for adaptive budgets. |
| `entity-cache-threshold` | Long | `1_000_000_000` | Abstract cache lifetime weight. |
| `entity-cache-timeout` | Duration | `1d` | Time after which unused entities evict. |
| `data-file-minimum-size` | Bytes | `1 MiB` | Below this, files are merged up. Hard max 2 GB. |
| `data-file-maximum-size` | Bytes | `8 MiB` | Above this, files are split. Hard max 2 GB. |
| `data-file-minimum-use-ratio` | Double | `0.75` | Below this ratio of live data, files are compacted. |
| `data-file-cleanup-head-file` | Boolean | `false` | Whether to compact the currently-written file. |
| `transaction-file-maximum-size` | Bytes | `100 MB` | Per-channel transaction log cap. Max 1 GB. |

## Property-to-type map

Each property configures one internal type. Useful when diagnosing "I set X but it
doesn't seem to take effect".

| Property | Configures |
|---|---|
| `storage-directory`, `deletion-directory`, `truncation-directory`, `storage-filesystem` | `StorageLiveFileProvider` |
| `backup-directory`, `backup-filesystem` | `StorageBackupSetup` |
| `channel-count` | `StorageChannelCountProvider` |
| `channel-directory-prefix`, `data-file-prefix`, `data-file-suffix`, `transaction-file-prefix`, `transaction-file-suffix`, `type-dictionary-file-name`, `rescued-file-suffix`, `lock-file-name` | `StorageFileNameProvider` |
| `housekeeping-*` | `StorageHousekeepingController` |
| `entity-cache-threshold`, `entity-cache-timeout` | `StorageEntityCacheEvaluator` |
| `data-file-*`, `transaction-file-maximum-size` | `StorageDataFileEvaluator` |
