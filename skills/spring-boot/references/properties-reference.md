# Properties reference — spring-boot

All properties under the `org.eclipse.store.` prefix.

## Core

| Property | Default | Purpose |
|---|---|---|
| `root` | — | FQCN of the root class. Must have a public no-arg constructor. |
| `auto-start` | `true` | Start the storage manager at app startup. |
| `auto-create-default-storage` | `true` | Create an `EmbeddedStorageManager` bean. |

## Storage directory & lifecycle

| Property | Default | Purpose |
|---|---|---|
| `storage-directory` | `storage` | Live file location. |
| `deletion-directory` | unset | If set, deleted files moved here. |
| `truncation-directory` | unset | If set, truncated files copied here. |
| `backup-directory` | unset | Continuous backup target. |

## Channels

| Property | Default | Purpose |
|---|---|---|
| `channel-count` | `1` | Power of 2 channels. |
| `channel-directory-prefix` | `channel_` | Subdirectory prefix. |
| `data-file-prefix` | `channel_` | Data file prefix. |
| `data-file-suffix` | `dat` | Data file suffix. |
| `transaction-file-prefix` | `transactions_` | Transaction file prefix. |
| `transaction-file-suffix` | `sft` | Transaction file suffix. |
| `type-dictionary-filename` | `PersistenceTypeDictionary.ptd` | Dictionary file name. |
| `rescued-file-suffix` | `bak` | Rescued file suffix. |
| `lock-filename` | `used.lock` | Lock file name. |

## Housekeeping

| Property | Default | Purpose |
|---|---|---|
| `housekeeping-interval` | `1s` | Cycle interval. |
| `housekeeping-time-budget` | `10ms` | Budget per cycle. |
| `housekeeping-adaptive` | `false` | Adapt budget under pressure. |
| `housekeeping-increase-threshold` | `5s` | Adaptive trigger. |
| `housekeeping-increase-amount` | `50ms` | Adaptive step. |
| `housekeeping-maximum-time-budget` | `500ms` | Adaptive cap. |

## Entity cache (loaded data in memory)

| Property | Default | Purpose |
|---|---|---|
| `entity-cache-threshold` | `1000000000` | Abstract weight. |
| `entity-cache-timeout` | `1d` | Idle timeout. |

## Data files

| Property | Default | Purpose |
|---|---|---|
| `data-file-minimum-size` | `1 MiB` | Merge floor. |
| `data-file-maximum-size` | `8 MiB` | Split ceiling. |
| `data-file-minimum-use-ratio` | `0.75` | Compaction threshold. |
| `data-file-cleanup-head-file` | `false` | Compact current write-head. |
| `transaction-file-maximum-size` | `100 MB` | Per-channel tx log cap. |

## AWS S3 (storage-filesystem)

```properties
org.eclipse.store.storage-filesystem.aws.s3.region=eu-north-1
org.eclipse.store.storage-filesystem.aws.s3.endpoint-override=...
org.eclipse.store.storage-filesystem.aws.s3.directory-bucket=false
org.eclipse.store.storage-filesystem.aws.s3.cache=true
org.eclipse.store.storage-filesystem.aws.s3.credentials.type=default
org.eclipse.store.storage-filesystem.aws.s3.credentials.access-key-id=...
org.eclipse.store.storage-filesystem.aws.s3.credentials.secret-access-key=...
```

Same structure for backup:

```properties
org.eclipse.store.backup-filesystem.aws.s3.region=eu-north-1
# ...
```

## Azure Storage

```properties
org.eclipse.store.storage-filesystem.azure.storage.connection-string=...
```

## GCP Firestore

```properties
org.eclipse.store.storage-filesystem.googlecloud.firestore.credentials.path=...
```

## Oracle Cloud Object Storage

```properties
org.eclipse.store.storage-filesystem.oraclecloud.objectstorage.config-file.path=...
```

## Other backends

Redis, Kafka, DynamoDB, SQL — similar nested structure. See the starter's
`configuration/` package for exhaustive nested config keys.

## REST console (optional)

```properties
org.eclipse.store.rest.enabled=true
vaadin.url-mapping=/store-console/*
```

## Relaxed binding

Spring accepts all these with either kebab-case or camelCase:

- `storage-directory` or `storageDirectory`
- `channel-count` or `channelCount`
- etc.

Pick one style per properties file.
