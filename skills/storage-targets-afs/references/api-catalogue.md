# API catalogue — storage-targets-afs

## Core AFS interfaces

Package: `org.eclipse.serializer.afs.types` (in the *serializer* repository).

| Interface | Purpose |
|---|---|
| `AFileSystem` | A filesystem. |
| `ADirectory` | Directory path inside the filesystem. |
| `AFile` | File within a directory. |

Filesystem factories (in the *store* repository, each in its own package):

- `org.eclipse.store.afs.nio.types.NioFileSystem.New()` — local NIO.
- `org.eclipse.store.afs.nio.types.NioFileSystem.New(Path baseDir)` — local NIO
  rooted at a specific base.
- `org.eclipse.store.afs.blobstore.types.BlobStoreFileSystem.New(BlobStoreConnector)`
  — blob-store wrapper.

Usage:

```java
NioFileSystem fs = NioFileSystem.New();
ADirectory storageDir = fs.ensureDirectoryPath("data", "sub");
EmbeddedStorage.start(root, storageDir);
```

## Built-in backends + Maven artifacts

| Backend | Artifact | Connector factory |
|---|---|---|
| Local NIO | bundled | `NioFileSystem.New()` |
| AWS S3 (general) | `afs-aws-s3` | `S3Connector.Caching(s3Client)` |
| AWS S3 (directory) | `afs-aws-s3` | `S3Connector.CachingDirectory(s3Client)` |
| AWS DynamoDB | `afs-aws-dynamodb` | `DynamoDbConnector.Caching(ddbClient)` |
| Azure Blob | `afs-azure-storage` | `AzureStorageConnector.Caching(blobService)` |
| GCP Firestore | `afs-googlecloud-firestore` | `GoogleCloudFirestoreConnector.Caching(firestore)` |
| Oracle Cloud Object | `afs-oraclecloud-objectstorage` | `OracleCloudObjectStorageConnector.Caching(objectStorage)` |
| Redis | `afs-redis` | `RedisConnector.Caching(String redisUri)` or `RedisConnector.Caching(io.lettuce.core.RedisClient)` — Eclipse Store's Redis AFS uses **Lettuce**, not Jedis |
| Kafka | `afs-kafka` | `KafkaConnector.Caching(kafkaProps)` |
| SQL (generic) | `afs-sql` | `SqlConnector.Caching(SqlProvider)` — provider built via `SqlProviderPostgres.New(dataSource)` (also `SqlProviderMariaDb` / `SqlProviderOracle` / `SqlProviderSqlite` / `SqlProviderHana`) |

All `BlobStoreFileSystem`-based backends share the same pattern:

```java
BlobStoreFileSystem fs = BlobStoreFileSystem.New(connector);
ADirectory dir = fs.ensureDirectoryPath(...);
EmbeddedStorage.start(root, dir);
```

## External configuration keys

Storage filesystem keys are complex properties under `storage-filesystem.*`:

```properties
storage-filesystem.target=aws.s3          # optional — enforces type match
storage-directory=my-bucket/folder

# backend-specific
storage-filesystem.aws.s3.region=eu-north-1
storage-filesystem.aws.s3.credentials.type=default
storage-filesystem.aws.s3.directory-bucket=false
storage-filesystem.aws.s3.endpoint-override=...
```

Same structure for `backup-filesystem.*` (a backup AFS, independent from live).

### S3-specific keys

| Key | Values |
|---|---|
| `.target` | `aws.s3` |
| `.aws.s3.region` | region id |
| `.aws.s3.endpoint-override` | URL |
| `.aws.s3.directory-bucket` | true/false |
| `.aws.s3.credentials.type` | `environment-variables`, `system-properties`, `static`, `default` |
| `.aws.s3.credentials.access-key-id` | static only |
| `.aws.s3.credentials.secret-access-key` | static only |
| `.aws.s3.cache` | true/false |

### Azure-specific keys

| Key | Values |
|---|---|
| `.target` | `azure.storage` |
| `.azure.storage.endpoint` | blob service endpoint URL |
| `.azure.storage.connection-string` | full connection string |
| `.azure.storage.encryption-scope` | server-side encryption scope |
| `.azure.storage.cache` | true/false (default `true`) |
| `.azure.storage.credentials.type` | `basic` / `shared-key` |
| `.azure.storage.credentials.username` / `.password` | when `type=basic` |
| `.azure.storage.credentials.account-name` / `.account-key` | when `type=shared-key` |

### Redis-specific keys

| Key | Values |
|---|---|
| `.target` | `redis` |
| `.redis.uri` | Redis URI (host/port + auth + database) |
| `.redis.cache` | true/false (default `true`) |

### Kafka-specific keys

| Key | Values |
|---|---|
| `.target` | `kafka` |
| `.kafka.<any-kafka-property>` | Pass-through to Kafka client `Properties` (e.g. `kafka.bootstrap.servers=…`). |
| `.kafka.cache` | true/false (default `true`) |

### DynamoDB-specific keys

Same shape as S3 minus `directory-bucket`.

| Key | Values |
|---|---|
| `.target` | `aws.dynamodb` |
| `.aws.dynamodb.region` | AWS region id |
| `.aws.dynamodb.endpoint-override` | URL |
| `.aws.dynamodb.cache` | true/false (default `true`) |
| `.aws.dynamodb.credentials.type` | `environment-variables` / `system-properties` / `static` / `default` |
| `.aws.dynamodb.credentials.access-key-id` / `.secret-access-key` | when `type=static` |

### Google Cloud Firestore-specific keys

| Key | Values |
|---|---|
| `.target` | `googlecloud.firestore` |
| `.googlecloud.firestore.project-id` | GCP project id |
| `.googlecloud.firestore.quota-project-id` | project for quota / billing |
| `.googlecloud.firestore.database-id` | database id |
| `.googlecloud.firestore.host` | service host |
| `.googlecloud.firestore.emulator-host` | emulator host |
| `.googlecloud.firestore.client-lib-token` | client library token |
| `.googlecloud.firestore.cache` | true/false (default `true`) |
| `.googlecloud.firestore.credentials.type` | `none` / `input-stream` / `default` |
| `.googlecloud.firestore.credentials.input-stream` | path to credentials JSON when `type=input-stream` |

### Oracle Cloud Object Storage-specific keys

| Key | Values |
|---|---|
| `.target` | `oraclecloud.object-storage` |
| `.oraclecloud.object-storage.region` | OCI region (e.g. `us-phoenix-1`) |
| `.oraclecloud.object-storage.endpoint` | endpoint URL |
| `.oraclecloud.object-storage.cache` | true/false (default `true`) |
| `.oraclecloud.object-storage.config-file.path` | OCI config file path; supports `classpath:` prefix and URLs (default `~/.oci/config`) |
| `.oraclecloud.object-storage.config-file.profile` | profile within the config file (default `DEFAULT`) |
| `.oraclecloud.object-storage.config-file.charset` | config-file charset |
| `.oraclecloud.object-storage.client.connection-timeout-millis` | int (default `10000`) |
| `.oraclecloud.object-storage.client.read-timeout-millis` | int (default `60000`) |
| `.oraclecloud.object-storage.client.max-async-threads` | int (default `50`) |

### SQL-specific keys

One target id per dialect: `sql.mariadb`, `sql.oracle`, `sql.postgres`,
`sql.sqlite`, `sql.hana`. The keys below are read by all five (replace
`<engine>` with the chosen one).

| Key | Values |
|---|---|
| `.target` | `sql.<engine>` |
| `.sql.<engine>.data-source-provider` | FQCN of a class providing a `DataSource` for the connector |
| `.sql.<engine>.cache` | true/false (default `true`) |

The dialect creator builds the right `SqlProvider*` (Postgres, MariaDb,
Oracle, Sqlite, Hana) under the hood.

Exact key list per backend is also in the upstream `.adoc` under
`docs/modules/storage/pages/storage-targets/blob-stores/<backend>.adoc`.

## Credentials strategies (AWS)

| Type | Resolution |
|---|---|
| `static` | From `credentials.access-key-id` / `secret-access-key`. |
| `environment-variables` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`. |
| `system-properties` | `aws.accessKeyId`, `aws.secretKey`, `aws.sessionToken`. |
| `default` | AWS SDK default chain (sys props → env vars → profile → container → EC2 IAM). |

In production, prefer `default` (or omit — SDK default).

## `StorageFileProvider` / `StorageBackupSetup`

Programmatic wiring (foundation-level):

```java
StorageLiveFileProvider.Builder()
    .setDirectory(fileSystem.ensureDirectoryPath("data"))
    .createFileProvider();

StorageBackupSetup.New(backupFs.ensureDirectoryPath("backup"));
```

Used via `EmbeddedStorage.Foundation(Storage.ConfigurationBuilder()...)`.
