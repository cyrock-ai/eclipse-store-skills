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
version: 0.2.0
---

# Eclipse Store — Storage Targets (AFS)

Eclipse Store's Abstract File System (AFS) lets you swap the local filesystem for a
variety of cloud / distributed backends. The storage engine treats every backend
through the same Directory/File abstraction. You pick the backend by choosing a
connector and a Maven artifact.

## Do NOT use this skill

- Just using the local filesystem → `getting-started` + `configuration`; NIO
  is the default and needs no code change.
- The AFS for the backup destination only → this skill is the AFS half;
  `configuration` covers `backup-directory` semantics.
- SQL-as-a-relational-database — Eclipse Store does not do that; AFS SQL is
  blob-in-table.

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

## Core API

Core abstraction in `org.eclipse.serializer.afs.types`:

- `AFileSystem` / `ADirectory` / `AFile`.

Filesystem implementations (in the *store* repo, each in its own package):

- `org.eclipse.store.afs.nio.types.NioFileSystem.New()` — local filesystem.
- `org.eclipse.store.afs.blobstore.types.BlobStoreFileSystem.New(connector)` —
  blob-store backends.

## Backends

All AFS modules live under groupId `org.eclipse.store`. Connectors sit in
`org.eclipse.store.afs.<backend>.types`. Each backend additionally requires its
own SDK at runtime (e.g. `software.amazon.awssdk:s3`).

| Backend | Artifact | Connector factory | Notes |
|---|---|---|---|
| Local NIO (default) | bundled in `storage-embedded` | `NioFileSystem.New()` | Zero extra config. |
| AWS S3 | `afs-aws-s3` | `S3Connector.Caching(S3Client)` / `S3Connector.CachingDirectory(S3Client)` | General & directory buckets. |
| AWS DynamoDB | `afs-aws-dynamodb` | `DynamoDbConnector.Caching(DynamoDbClient)` | Blob-in-table. |
| Azure Storage | `afs-azure-storage` | `AzureStorageConnector.Caching(BlobServiceClient)` | Blob Storage. |
| Google Cloud Firestore | `afs-googlecloud-firestore` | `GoogleCloudFirestoreConnector.Caching(Firestore)` | Document-per-blob. |
| Oracle Cloud Object Storage | `afs-oraclecloud-objectstorage` | `OracleCloudObjectStorageConnector.Caching(ObjectStorage)` | OCI blob. |
| Redis | `afs-redis` | `RedisConnector.Caching(...)` | Keys map to AFS paths. |
| Kafka | `afs-kafka` | `KafkaConnector.Caching(Properties)` | Append-only log. |
| SQL | `afs-sql` | `SqlConnector.Caching(SqlProvider)` — wrap a `DataSource` in `SqlProviderPostgres` / `SqlProviderMariaDb` / `SqlProviderOracle` / `SqlProviderSqlite` / `SqlProviderHana` | Blob-in-row with JDBC. |

**`.Caching(...)`** is almost always what you want. The non-caching variant
exists for rare cases (transactional audits, tiny workloads).

## Idiomatic patterns

### Pattern A — Local NIO (default)

`EmbeddedStorage.start(root, Paths.get("data"))` already runs through
`NioFileSystem.New()`. Use the explicit `NioFileSystem.New()` →
`fs.ensureDirectoryPath(...)` form only when customizing the NIO filesystem
(rare; see `getting-started`).

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

This low-level Foundation wiring is for **live and backup on different AFS
types** (e.g. NIO live + S3 backup, as shown). For NIO-to-NIO backup (both
local), do NOT mix `Storage.ConfigurationBuilder()` with two `NioFileSystem`
instances — Eclipse Store treats the implicit AFS roots as incompatible and
throws `AfsExceptionConsistency`. Use the high-level
`EmbeddedStorageConfiguration.Builder().setStorageDirectory(...)
.setBackupDirectory(...)` instead (from the `storage-embedded-configuration`
artifact — see `configuration` skill).

### Pattern F — Other backends (same shape)

Every backend collapses to: build the SDK client → `XConnector.Caching(client)`
→ `BlobStoreFileSystem.New(connector)` → `fs.ensureDirectoryPath(...)` →
`EmbeddedStorage.start(root, dir)`. For SQL, wrap a JDBC `DataSource` in
`SqlProviderPostgres.New(ds)` (or `SqlProviderMariaDb` / `…Oracle` / `…Sqlite`
/ `…Hana`) and pass it to `SqlConnector.Caching(provider)`.

Per-backend SDK choices that surprise people: Redis uses **Lettuce**
(`io.lettuce.core.RedisClient`), not Jedis — `RedisConnector.Caching(...)`
takes a `String redisUri` or a `RedisClient`. Kafka takes a plain
`java.util.Properties`. Azure takes a `BlobServiceClient` from
`com.azure.storage.blob`.

Full runnable code per backend lives in `references/examples-expanded.md`;
per-backend config-property keys in `references/api-catalogue.md`; deep S3
notes in `references/s3.md`.

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
6. **Kafka AFS semantics.** Append-only with compaction; conceptually different
   from random-access blob stores. Eclipse Store's housekeeping compaction
   interacts non-trivially with Kafka retention.
7. **SQL AFS.** Blob-in-row; useful for "database is the allowed storage"
   scenarios but adds a transaction layer Eclipse Store doesn't otherwise
   need.

## Interactions with other skills

- **`configuration`** — the `storage-filesystem` / `backup-filesystem` complex
  properties are authored here. `configuration` covers generic config; this skill
  covers the AFS-specific sub-properties.
- **`spring-boot`** — Spring Boot's `org.eclipse.store.storage-filesystem.*` and
  `…backup-filesystem.*` keys flow into the same AFS targets documented here.
  Add the matching `afs-*` artifact + the backend SDK; the starter wires the
  rest from `application.properties`.
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

**"Can I change backend without losing data?"** → Use the
`StorageConverter` tool from `storage-embedded-tools-storage-converter`
(class `org.eclipse.store.storage.embedded.tools.storage.converter.StorageConverter`).
Construct it with the source and target `StorageConfiguration` (each pointing
at a different AFS) and call `start()`. The bundled `MainUtilStorageConverter`
CLI is NIO-only; for cross-AFS conversion invoke `StorageConverter`
programmatically. A plain file-level copy of the directory contents also works
as long as paths are preserved (both ends are opaque blobs to AFS).

**"What about S3 versioning / object lock?"** → AFS treats one logical file as a
sequence of S3 objects keyed `<path>.<N>`; each key is written exactly once
(`BlobStoreConnector.writeData` always picks the next sequential number) and
deleted as a whole later (compaction, truncation, shutdown). There is therefore
at most one *write* version per key — versioning does not capture "edits to a
blob". Where versioning still helps is recovering deleted blobs after a
mistaken compaction / wipe; treat it as a delete-recovery safety net, not as
write history. Costs extra.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need the exact connector
  factory signature for a backend not shown above, or the full property keys
  under `storage-filesystem.*` / `backup-filesystem.*` for AWS (S3, DynamoDB),
  Azure, GCP Firestore, OCI Object Storage, Redis, Kafka, or SQL (Postgres /
  MariaDB / Oracle / SQLite / HANA).
- **Load `references/s3.md`** when wiring AWS S3 specifically — credential
  strategies, general vs. directory buckets, `endpointOverride` for
  S3-compatible services (MinIO, Backblaze) or zonal endpoints, request-rate
  and pricing notes.
- **Load `references/examples-expanded.md`** when you want a complete runnable
  Java template for a specific backend — Azure with connection string, Redis
  with Lettuce, Kafka with `Properties`, DynamoDB, SQL via `SqlProviderPostgres`.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a backend bug —
  non-caching latency, wrong region, multi-writer race on the same prefix,
  cross-region cost, Kafka log compaction eating data, Redis TTL, SQL
  deadlocks, S3 rename-not-atomic surprises.

## Upstream sources

- `docs/modules/storage/pages/storage-targets/index.adoc` — overview.
- `docs/modules/storage/pages/storage-targets/file-system.adoc` — NIO.
- `docs/modules/storage/pages/storage-targets/blob-stores/aws-s3.adoc`,
  `.../azure-storage.adoc`, `.../google-cloud-firestore.adoc`,
  `.../oracle-cloud-object-storage.adoc`, `.../redis.adoc`, `.../kafka.adoc`,
  `.../aws-dynamodb.adoc`.
- `afs/` module in the source tree — implementations.
- `examples/filesystems/`, `examples/blobs/` — runnable examples.
