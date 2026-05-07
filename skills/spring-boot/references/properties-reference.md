# Properties reference — spring-boot

All properties under the `org.eclipse.store.` prefix. Bound to
`EclipseStoreProperties` and its nested `StorageFilesystem` / backend classes.
Spring's relaxed binding accepts kebab-case (`storage-directory`) or camelCase
(`storageDirectory`) — pick one style per file.

## Core

| Property | Default | Purpose |
|---|---|---|
| `root` | — | FQCN of the root class. When set, the starter reflectively instantiates it via the no-arg constructor — must be accessible. Skip this property and build the manager yourself if your root needs constructor args. Bound to a `Class<?>` field. |
| `auto-start` | `true` | Start the storage manager at app startup. |
| `auto-create-default-foundation` | `true` | Create the default `EmbeddedStorageFoundationSupplier` bean. |
| `auto-create-default-storage` | `true` | Create an `EmbeddedStorageManager` bean. |
| `register-jdk8-handlers` | `false` | Register the optional JDK 8 binary handlers. |

## Storage directory & lifecycle

| Property | Default | Purpose |
|---|---|---|
| `storage-directory` | `storage` | Live file location. |
| `deletion-directory` | unset | If set, deleted files moved here. |
| `truncation-directory` | unset | If set, truncated files copied here. |
| `backup-directory` | unset | Continuous backup target. |

## Channels & file naming

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

## Storage filesystem (`storage-filesystem.*`)

`storage-filesystem` selects and configures the AFS backend. Add the matching
`afs-*` artifact (e.g. `afs-aws-s3`) to your dependencies. The same nested
schema applies under `backup-filesystem.*` for the continuous backup target.

| Property | Purpose |
|---|---|
| `storage-filesystem.target` | Optional explicit backend target id. |
| `storage-filesystem.aws.s3.*` | Amazon S3. |
| `storage-filesystem.aws.dynamodb.*` | Amazon DynamoDB. |
| `storage-filesystem.azure.storage.*` | Azure Blob Storage. |
| `storage-filesystem.googlecloud.firestore.*` | GCP Firestore. |
| `storage-filesystem.oraclecloud.object-storage.*` | Oracle Cloud Object Storage. |
| `storage-filesystem.redis.uri` | Redis. |
| `storage-filesystem.sql.{mariadb,oracle,postgres,sqlite}.*` | SQL backends. |
| `storage-filesystem.kafka-properties.<key>` | Map of Kafka client properties. |

### AWS S3

| Property | Purpose |
|---|---|
| `storage-filesystem.aws.s3.region` | AWS region (e.g. `eu-north-1`). |
| `storage-filesystem.aws.s3.endpoint-override` | Custom endpoint URL. |
| `storage-filesystem.aws.s3.cache` | Connector cache. Default `true`. |
| `storage-filesystem.aws.s3.directory-bucket` | `true` for Express One Zone (directory) buckets. Default `false`. |
| `storage-filesystem.aws.s3.credentials.type` | `default` / `environment-variables` / `system-properties` / `static`. |
| `storage-filesystem.aws.s3.credentials.access-key-id` | Used when `type=static`. |
| `storage-filesystem.aws.s3.credentials.secret-access-key` | Used when `type=static`. |

### AWS DynamoDB

Same fields as S3 except `directory-bucket` (DynamoDB has no equivalent).

| Property | Purpose |
|---|---|
| `storage-filesystem.aws.dynamodb.region` | AWS region. |
| `storage-filesystem.aws.dynamodb.endpoint-override` | Custom endpoint URL. |
| `storage-filesystem.aws.dynamodb.cache` | Connector cache. Default `true`. |
| `storage-filesystem.aws.dynamodb.credentials.{type,access-key-id,secret-access-key}` | Same as S3. |

### Azure Storage

| Property | Purpose |
|---|---|
| `storage-filesystem.azure.storage.endpoint` | Blob service endpoint (also parses SAS token). |
| `storage-filesystem.azure.storage.connection-string` | Connection string. |
| `storage-filesystem.azure.storage.encryption-scope` | Server-side encryption scope. |
| `storage-filesystem.azure.storage.credentials.type` | `basic` or `shared-key`. |
| `storage-filesystem.azure.storage.credentials.username` | Used when `type=basic`. |
| `storage-filesystem.azure.storage.credentials.password` | Used when `type=basic`. |
| `storage-filesystem.azure.storage.credentials.account-mame` | Used when `type=shared-key`. *(Field name is misspelled in the upstream class — `accountMame`.)* |
| `storage-filesystem.azure.storage.credentials.account-key` | Used when `type=shared-key`. |

### Google Cloud Firestore

| Property | Purpose |
|---|---|
| `storage-filesystem.googlecloud.firestore.project-id` | GCP project id. |
| `storage-filesystem.googlecloud.firestore.quota-project-id` | Project for quota / billing. |
| `storage-filesystem.googlecloud.firestore.database-id` | Database id. |
| `storage-filesystem.googlecloud.firestore.host` | Service host. |
| `storage-filesystem.googlecloud.firestore.emulator-host` | Emulator host. |
| `storage-filesystem.googlecloud.firestore.credentials.type` | `none` / `input-stream` / `default`. |

### Oracle Cloud Object Storage

| Property | Purpose |
|---|---|
| `storage-filesystem.oraclecloud.object-storage.region` | Region (e.g. `us-phoenix-1`). |
| `storage-filesystem.oraclecloud.object-storage.endpoint` | Endpoint URL. |
| `storage-filesystem.oraclecloud.object-storage.config-file.path` | OCI config file path (default `~/.oci/config`). |
| `storage-filesystem.oraclecloud.object-storage.config-file.profile` | Profile name (default `DEFAULT`). |
| `storage-filesystem.oraclecloud.object-storage.config-file.charset` | Config-file encoding. |
| `storage-filesystem.oraclecloud.object-storage.client.connection-timeout-millis` | Default `10000`. |
| `storage-filesystem.oraclecloud.object-storage.client.read-timeout-millis` | Default `60000`. |
| `storage-filesystem.oraclecloud.object-storage.client.max-async-threads` | Default `50`. |

### Redis

| Property | Purpose |
|---|---|
| `storage-filesystem.redis.uri` | Redis URI (host/port + auth + db). |

### SQL (`mariadb` / `oracle` / `postgres` / `sqlite`)

Same schema for all four — replace `<engine>` with the chosen one:

| Property | Purpose |
|---|---|
| `storage-filesystem.sql.<engine>.url` | JDBC URL. |
| `storage-filesystem.sql.<engine>.user` | Username. |
| `storage-filesystem.sql.<engine>.password` | Password. |
| `storage-filesystem.sql.<engine>.catalog` | JDBC catalog. |
| `storage-filesystem.sql.<engine>.schema` | JDBC schema. |
| `storage-filesystem.sql.<engine>.data-source-provider` | Custom `DataSource` provider class. |

### Kafka

| Property | Purpose |
|---|---|
| `storage-filesystem.kafka-properties.<key>` | Free-form Kafka client property — `<key>` is any client-config key from the Kafka docs. |

## Backup filesystem (`backup-filesystem.*`)

Identical nested schema to `storage-filesystem.*`. Set both prefixes when you
want continuous backup to a different backend than the primary store:

```properties
org.eclipse.store.storage-filesystem.aws.s3.region=eu-north-1
org.eclipse.store.backup-filesystem.aws.s3.region=eu-north-1
```

## REST console (optional)

Add the `integrations-spring-boot3-console` artifact and the console
auto-activates (default `org.eclipse.store.console.ui.enabled=true`).

| Property | Purpose |
|---|---|
| `console.ui.enabled` | Set to `false` to disable the Vaadin UI. |
| `vaadin.url-mapping` | Vaadin frontend mount path. |

## Relaxed binding

Spring accepts all keys with either kebab-case or camelCase:

- `storage-directory` or `storageDirectory`
- `channel-count` or `channelCount`
- `console.ui.enabled` or `console.ui.enabled` (already lowercased)

Pick one style per properties file.
