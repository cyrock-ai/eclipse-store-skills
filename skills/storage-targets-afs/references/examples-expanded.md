# Examples-expanded — storage-targets-afs

## Example 1 — AWS S3 (general bucket) with environment credentials

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>afs-aws-s3</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
<dependency>
  <groupId>software.amazon.awssdk</groupId>
  <artifactId>s3</artifactId>
  <version>2.30.11</version>
</dependency>
```

```java
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.regions.Region;

import org.eclipse.serializer.afs.types.BlobStoreFileSystem;
import org.eclipse.store.afs.aws.s3.types.S3Connector;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

S3Client s3 = S3Client.builder()
    .region(Region.EU_NORTH_1)
    // credentials via default chain: env vars, profile, EC2 IAM, etc.
    .build();

BlobStoreFileSystem fs = BlobStoreFileSystem.New(S3Connector.Caching(s3));
EmbeddedStorageManager storage =
    EmbeddedStorage.start(root, fs.ensureDirectoryPath("my-bucket", "data"));
```

## Example 2 — External config for S3

`eclipsestore.properties`:

```properties
storage-filesystem.target=aws.s3
storage-directory=my-bucket/data

storage-filesystem.aws.s3.region=eu-north-1
storage-filesystem.aws.s3.credentials.type=default
channel-count=2
```

```java
EmbeddedStorageManager storage = EmbeddedStorageConfiguration.load()
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();
```

## Example 3 — S3 directory bucket (low-latency)

```java
S3Client s3 = S3Client.builder()
    .region(Region.EU_NORTH_1)
    .endpointOverride(URI.create(
        "https://s3express-eun1-az1.eu-north-1.amazonaws.com"))
    .build();

BlobStoreFileSystem fs = BlobStoreFileSystem.New(S3Connector.CachingDirectory(s3));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("my-bucket", "data"));
```

## Example 4 — Live on NIO, backup on S3

```java
NioFileSystem liveFs = NioFileSystem.New();
BlobStoreFileSystem backupFs = BlobStoreFileSystem.New(S3Connector.Caching(s3));

EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
    Storage.ConfigurationBuilder()
        .setStorageFileProvider(
            StorageLiveFileProvider.Builder()
                .setDirectory(liveFs.ensureDirectoryPath("data"))
                .createFileProvider()
        )
        .setBackupSetup(StorageBackupSetup.New(
            backupFs.ensureDirectoryPath("my-bucket", "backup")
        ))
        .createConfiguration()
).start(root);
```

Or config-driven:

```properties
storage-directory=data

backup-filesystem.target=aws.s3
backup-directory=my-bucket/backup
backup-filesystem.aws.s3.region=eu-north-1
backup-filesystem.aws.s3.credentials.type=default
```

## Example 5 — Azure Blob

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>afs-azure-storage</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
<dependency>
  <groupId>com.azure</groupId>
  <artifactId>azure-storage-blob</artifactId>
  <version>12.25.0</version>
</dependency>
```

```java
import com.azure.storage.blob.BlobServiceClientBuilder;
import org.eclipse.store.afs.azure.storage.types.AzureStorageConnector;

BlobServiceClient blob = new BlobServiceClientBuilder()
    .connectionString(System.getenv("AZURE_STORAGE_CONN_STR"))
    .buildClient();

BlobStoreFileSystem fs = BlobStoreFileSystem.New(
    AzureStorageConnector.Caching(blob));

EmbeddedStorage.start(root, fs.ensureDirectoryPath("container-name", "data"));
```

## Example 6 — Redis-backed storage

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>afs-redis</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
<dependency>
  <groupId>io.lettuce</groupId>
  <artifactId>lettuce-core</artifactId>
  <version>6.3.2.RELEASE</version>
</dependency>
```

Eclipse Store's Redis AFS uses **Lettuce** (`io.lettuce.core.RedisClient`),
NOT Jedis. The `Caching` factory has a `String redisUri` overload that builds
the client internally:

```java
import org.eclipse.store.afs.redis.types.RedisConnector;

BlobStoreFileSystem fs = BlobStoreFileSystem.New(
    RedisConnector.Caching("redis://localhost:6379"));

EmbeddedStorage.start(root, fs.ensureDirectoryPath("eclipsestore", "data"));
```

If you need to share an existing client across the app:

```java
import io.lettuce.core.RedisClient;

RedisClient client = RedisClient.create("redis://localhost:6379");
BlobStoreFileSystem fs = BlobStoreFileSystem.New(RedisConnector.Caching(client));
```

Redis AFS is intentionally for specific use cases — e.g., in-memory data
distributed across a Redis cluster.

## Example 7 — Kafka (append-only audit)

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>afs-kafka</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

```java
import java.util.Properties;

import org.eclipse.store.afs.kafka.types.KafkaConnector;

Properties props = new Properties();
props.put("bootstrap.servers", "broker1:9092");
// ... other Kafka props

BlobStoreFileSystem fs = BlobStoreFileSystem.New(KafkaConnector.Caching(props));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("eclipse-store", "data"));
```

Caveats: Kafka compaction vs. Eclipse Store's housekeeping can interact
awkwardly. Use this only if you understand both systems.

## Example 8 — DynamoDB-backed

```java
DynamoDbClient ddb = DynamoDbClient.builder().region(Region.EU_NORTH_1).build();
BlobStoreFileSystem fs = BlobStoreFileSystem.New(DynamoDbConnector.Caching(ddb));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("eclipse-store-table", "data"));
```

## Example 9 — SQL-blob (JDBC)

`SqlConnector.Caching(...)` takes a `SqlProvider` — the dialect-specific class
that adapts a `DataSource` to AFS. There is one provider per supported engine:
`SqlProviderPostgres` / `SqlProviderMariaDb` / `SqlProviderOracle` /
`SqlProviderSqlite` / `SqlProviderHana`.

```java
import javax.sql.DataSource;
import org.eclipse.store.afs.sql.types.SqlConnector;
import org.eclipse.store.afs.sql.types.SqlProviderPostgres;

DataSource ds = ...;   // any JDBC DataSource
SqlProviderPostgres provider = SqlProviderPostgres.New(ds);   // overload with catalog/schema also available

BlobStoreFileSystem fs = BlobStoreFileSystem.New(SqlConnector.Caching(provider));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("app", "data"));
```

Useful when ops requires "everything in the RDBMS".
