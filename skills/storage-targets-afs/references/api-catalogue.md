# API catalogue — storage-targets-afs

## Core AFS interfaces

Package: `org.eclipse.serializer.afs.types`.

| Interface | Purpose |
|---|---|
| `AFileSystem` | A filesystem. |
| `ADirectory` | Directory path inside the filesystem. |
| `AFile` | File within a directory. |

Factories:

- `NioFileSystem.New()` — local.
- `NioFileSystem.New(Path baseDir)` — local with a specific base.
- `BlobStoreFileSystem.New(BlobStoreConnector)` — blob-store wrapper.

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
| Redis | `afs-redis` | `RedisConnector.Caching(jedisPool)` |
| Kafka | `afs-kafka` | `KafkaConnector.Caching(kafkaProps)` |
| SQL (generic) | `afs-sql` | `SqlConnector.Caching(dataSource, table)` |

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
| `.azure.storage.connection-string` | string |
| `.azure.storage.account-name` / `.account-key` | alt to connection string |

### Redis-specific keys

| Key | Values |
|---|---|
| `.target` | `redis` |
| `.redis.uri` | connection string |
| `.redis.client.user-database` | bool |

### Kafka-specific keys

| Key | Values |
|---|---|
| `.target` | `kafka` |
| `.kafka.properties.<any-kafka-prop>` | passthrough |

Exact key list per backend is in the upstream `.adoc` under
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
