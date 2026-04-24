---
name: storage-targets-afs
description: >
  Guide Claude on using Eclipse Store's Abstract File System (AFS) to run storage
  against backends other than the local filesystem — AWS S3 (general & directory
  buckets), Azure Blob, Google Cloud Firestore, Oracle Cloud Object Storage, Redis,
  Kafka, DynamoDB, SQL-backed blob stores, plus local NIO. Use this skill when the
  user asks to "use S3", "use Azure Blob", "use Redis as storage", "store in Kafka",
  "use a cloud storage backend", "NioFileSystem", "BlobStoreFileSystem",
  "S3Connector", "ADirectory", "AFS", "caching connector", "alternate storage
  target", or needs help choosing a backend and configuring it with the right AFS
  module.
version: 0.1.0
---

# Eclipse Store — Storage Targets (AFS)

Eclipse Store's Abstract File System (AFS) lets you swap the local filesystem for a
variety of cloud / distributed backends. The storage engine treats every backend
through the same Directory/File abstraction. You pick the backend by choosing a
connector and a Maven artifact.

## When to use this skill

- User asks how to run Eclipse Store against S3, Azure, GCP, Redis, Kafka.
- User asks about `BlobStoreFileSystem`, `NioFileSystem`, `S3Connector`, `ADirectory`.
- User is wiring cloud credentials into Eclipse Store.
- User is weighing latency/performance of a blob-store backend vs. local SSD.
- User asks about the `storage-filesystem` / `backup-filesystem` complex config
  properties.

**Route elsewhere** when:

- User is just using local filesystem → `getting-started` + `configuration` are
  enough; NIO is the default.
- User wants a backup destination (separate from live storage) → this skill covers
  the AFS side, `configuration` covers `backup-directory`.
- User wants SQL-as-a-database (not blob) → Eclipse Store does not target that;
  AFS SQL is blob-in-table.

## Mental model

AFS is a three-layer abstraction:

1. **`AFileSystem`** — the filesystem (NIO, S3-backed, Azure-backed, …).
2. **`ADirectory`** — a path inside the filesystem.
3. **`AFile`** — a file in the filesystem.

Storage configuration takes an `ADirectory` (or a path that AFS resolves into
one). Everything else — lock files, channels, transaction logs — routes through
AFS.

Connectors (`S3Connector`, `AzureStorageConnector`, etc.) adapt a backend SDK
(AWS, Azure, …) to the AFS contract. Most connectors have a `.Caching(...)`
factory that adds an in-memory read-through cache — essential for latency-
sensitive backends.

## Maven matrix

All AFS modules live under groupId `org.eclipse.store`:

| Backend | Artifact | Notes |
|---|---|---|
| Local NIO (default) | (bundled in `storage-embedded`) | Zero extra config. |
| AWS S3 | `afs-aws-s3` | General & directory buckets. |
| AWS DynamoDB | `afs-aws-dynamodb` | Blob-in-table. |
| Azure Storage | `afs-azure-storage` | Blob Storage. |
| Google Cloud Firestore | `afs-googlecloud-firestore` | Document-per-blob. |
| Oracle Cloud Object Storage | `afs-oraclecloud-objectstorage` | OCI blob. |
| Redis | `afs-redis` | Keys map to AFS paths. |
| Kafka | `afs-kafka` | Append-only log. |
| SQL (generic) | `afs-sql` | Blob-in-row with JDBC. |

Each requires its backend SDK at runtime (e.g., `software.amazon.awssdk:s3` for
S3).

## Core API

From `org.eclipse.serializer.afs.types`:

- `AFileSystem` / `ADirectory` / `AFile` — the abstraction.
- `NioFileSystem.New()` — local filesystem.
- `BlobStoreFileSystem.New(connector)` — blob-store backends.

Connectors (per backend package):

- `S3Connector.Caching(S3Client)` / `S3Connector.CachingDirectory(S3Client)`
- `AzureStorageConnector.Caching(BlobServiceClient)`
- `GoogleCloudFirestoreConnector.Caching(Firestore)`
- `OracleCloudObjectStorageConnector.Caching(ObjectStorage)`
- `RedisConnector.Caching(...)`
- `KafkaConnector.Caching(...)`
- `DynamoDbConnector.Caching(DynamoDbClient)`
- `SqlConnector.Caching(...)`

**`.Caching(...)`** is almost always what you want. The non-caching variant exists
for rare cases (transactional audits, tiny workloads).

## Idiomatic patterns

### Pattern A — Local NIO (default, no code change)

```java
EmbeddedStorage.start(root, Paths.get("data"));
```

Internally:

```java
NioFileSystem fs = NioFileSystem.New();
EmbeddedStorage.start(root, fs.ensureDirectoryPath("data"));
```

Use the explicit form only when customizing the NIO filesystem (rare).

### Pattern B — AWS S3 (general bucket)

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
S3Client s3 = S3Client.builder()
    .credentialsProvider(StaticCredentialsProvider.create(
        AwsBasicCredentials.create(accessKey, secretKey)))
    .region(Region.EU_NORTH_1)
    .build();

BlobStoreFileSystem fs = BlobStoreFileSystem.New(S3Connector.Caching(s3));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("my-bucket", "data"));
```

### Pattern C — S3 directory buckets (low-latency)

Directory buckets (S3 Express One Zone) have lower latency but require a zonal
endpoint:

```java
S3Client s3 = S3Client.builder()
    .credentialsProvider(...)
    .region(Region.EU_NORTH_1)
    .endpointOverride(URI.create("https://s3express-eun1-az1.eu-north-1.amazonaws.com"))
    .build();

BlobStoreFileSystem fs = BlobStoreFileSystem.New(S3Connector.CachingDirectory(s3));
EmbeddedStorage.start(root, fs.ensureDirectoryPath("my-bucket", "data"));
```

### Pattern D — External configuration

Place S3 config in `eclipsestore.properties`:

```properties
storage-filesystem.target=aws.s3
storage-directory=my-bucket/data
storage-filesystem.aws.s3.credentials.type=static
storage-filesystem.aws.s3.credentials.access-key-id=${S3_ACCESS_KEY_ID}
storage-filesystem.aws.s3.credentials.secret-access-key=${S3_SECRET_ACCESS_KEY}
storage-filesystem.aws.s3.region=eu-north-1
```

Load via `EmbeddedStorageConfiguration.load()`. The `configuration` skill covers
the loader mechanics.

### Pattern E — Backup to a different AFS

Live on local SSD, backup to S3:

```java
NioFileSystem live = NioFileSystem.New();
BlobStoreFileSystem backup = BlobStoreFileSystem.New(S3Connector.Caching(s3));

EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
    Storage.ConfigurationBuilder()
        .setStorageFileProvider(
            StorageLiveFileProvider.Builder()
                .setDirectory(live.ensureDirectoryPath("data"))
                .createFileProvider()
        )
        .setBackupSetup(StorageBackupSetup.New(
            backup.ensureDirectoryPath("my-bucket", "backup")
        ))
        .createConfiguration()
).start(root);
```

Or via external config:

```properties
storage-directory=data

backup-filesystem.target=aws.s3
backup-directory=my-bucket/backup
backup-filesystem.aws.s3.region=eu-north-1
# ...credentials...
```

### Pattern F — Other backends (same shape)

All blob-store backends follow the same pattern:

```java
// Azure
AzureStorageConnector connector = AzureStorageConnector.Caching(blobServiceClient);
BlobStoreFileSystem fs = BlobStoreFileSystem.New(connector);

// Redis
RedisConnector connector = RedisConnector.Caching(jedisPool);

// Kafka
KafkaConnector connector = KafkaConnector.Caching(kafkaProperties);
```

See `references/s3.md`, `references/azure.md`, `references/redis.md`,
`references/kafka.md` for full setup per backend.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Non-caching connector for a latency-sensitive workload

```java
// WRONG for production
S3Connector.New(s3);   // no caching — every read hits S3
```

**Symptom.** Catastrophic latency on `start()` (the root load pulls many small
files), every housekeeping cycle is slow.

**Fix.** `S3Connector.Caching(s3)`.

### Anti-pattern 2 — Storing credentials in code

```java
AwsBasicCredentials.create("AKIA...", "SECRET/Y+...");
```

**Fix.** Use env vars (`credentials.type=environment-variables`), instance
profile, or a secrets manager.

### Anti-pattern 3 — Pointing multiple managers at the same S3 prefix

Same rule as local: one live manager per "directory". AFS backends enforce it via
the lock file, but eventual consistency (S3 general buckets) can make this
fragile.

**Fix.** Use directory buckets (strong consistency) or a dedicated coordination
primitive if multiple processes need access.

### Anti-pattern 4 — Running on a slow WAN link for live storage

Eclipse Store expects IO latency in the millisecond range. Opening storage
against an S3 bucket in another region, over a slow VPN, means every
housekeeping cycle stalls.

**Fix.** Live storage on local or in-region AFS. Use remote AFS only for backup
or replicas.

### Anti-pattern 5 — Mixing channel count with blob size limits

Default `data-file-maximum-size = 8 MiB`. Some blob stores have per-request size
limits; 8 MiB works with all, but if you push the storage configuration toward
64 MiB files, verify the backend.

## Pitfalls & gotchas

1. **`BlobStoreFileSystem` is eventually consistent on some backends.** S3
   general buckets used to be; now read-after-write is consistent, but list-after-
   write can lag. Directory buckets remove this.
2. **Locking depends on backend semantics.** Eclipse Store's lock file is a
   regular AFS file. Backends without atomic create-if-not-exists can race.
   Known safe: NIO, S3 directory, Azure Blob. Verify on exotic backends.
3. **Latency is cumulative.** Every `start()` reads many small files (dictionary,
   channel headers, root). Without caching, that's many round-trips.
4. **Costs.** Per-request pricing on S3/Azure adds up. Aggressive housekeeping +
   uncached connector = large bill.
5. **Credential refresh.** Most SDKs handle IAM role rotation; be sure to pass a
   `DefaultCredentialsProvider` (`credentials.type=default`) in container
   environments.
6. **Channel count and latency.** More channels = more parallel backend
   requests. Useful on local SSDs, sometimes counterproductive on metered
   APIs. Test.
7. **Kafka AFS semantics.** Append-only with compaction; conceptually different
   from random-access blob stores. Use carefully — Eclipse Store's housekeeping
   compaction interacts non-trivially with Kafka retention.
8. **SQL AFS.** Blob-in-row; useful for "database is the allowed storage" scenarios
   but adds a transaction layer Eclipse Store doesn't otherwise need.

## Interactions with other skills

- **`configuration`** — the `storage-filesystem` / `backup-filesystem` complex
  properties are authored here. `configuration` covers generic config; this skill
  covers the AFS-specific sub-properties.
- **`getting-started`** — a custom `ADirectory` is passed to
  `EmbeddedStorage.start(root, directory)` or the Foundation.
- **`housekeeping-and-deletion`** — compaction writes new files and deletes old
  ones. On a blob store, that's per-request cost.
- **`custom-type-handlers`** and **`storing-data`** — unaffected by backend.

## Recipes

**"Which backend should I use?"** → Default to local NIO. S3 (directory bucket)
or Azure Blob for a cloud native app. Redis / Kafka / DynamoDB / SQL are for
niche integrations — think carefully about performance.

**"Do I need caching?"** → Yes, almost always. The non-caching connector is only
for extreme cases where you can't tolerate stale reads.

**"How do I supply credentials?"** → IAM role > env vars > credentials file >
static. Never code.

**"How do I run multiple instances against one S3 bucket?"** → Don't, unless you
have a directory bucket and application-level coordination. Eclipse Store's
single-writer rule applies.

**"Can I change backend without losing data?"** → Copy the files. AFS treats
them as opaque blobs; a plain file-level copy from NIO to S3 (or between two S3
buckets) works as long as paths are preserved.

**"Is backup to a different AFS a good idea?"** → Yes. Live locally, backup to
cloud is the typical safe setup.

**"What about S3 versioning / object lock?"** → Eclipse Store writes, updates,
deletes blobs; S3 versioning captures all versions. Useful as a disaster-
recovery safety net; costs extra.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — full AFS interfaces, connector factories per
  backend.
- `references/s3.md` — S3 config per credential strategy (static / env / default),
  general vs. directory buckets, endpoint override.
- `references/azure.md` — Azure Blob config (connection string, MSI).
- `references/redis.md` — Redis AFS config, TTL considerations.
- `references/kafka.md` — Kafka AFS semantics and retention interaction.
- `references/nio-tuning.md` — filesystem tuning for local SSDs (page cache, fsync
  behaviour).
- `references/examples-expanded.md` — five full setups across backends.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer.

## Upstream sources

- `docs/modules/storage/pages/storage-targets/index.adoc` — overview.
- `docs/modules/storage/pages/storage-targets/file-system.adoc` — NIO.
- `docs/modules/storage/pages/storage-targets/blob-stores/aws-s3.adoc`,
  `.../azure-storage.adoc`, `.../google-cloud-firestore.adoc`,
  `.../oracle-cloud-object-storage.adoc`, `.../redis.adoc`, `.../kafka.adoc`,
  `.../aws-dynamodb.adoc`.
- `afs/` module in the source tree — implementations.
- `examples/filesystems/`, `examples/blobs/` — runnable examples.
