# Pitfalls deep-dive — storage-targets-afs

## 1. Non-caching connector in production

**Reproducer.**

```java
S3Connector.New(s3)   // no caching
```

**Symptom.** Multi-second `start()` on modest datasets. Every housekeeping cycle
pegs the S3 latency budget.

**Fix.** `S3Connector.Caching(s3)`. The cache is read-through; writes go straight
to the backend, reads are cached in memory.

## 2. Hardcoded credentials

**Reproducer.**

```java
AwsBasicCredentials.create("AKIA...", "SECRET")
```

**Symptom.** Commits ship secrets. Pagers light up.

**Fix.** `credentials.type=default` and rely on IAM role or env vars.

## 3. Wrong region

**Reproducer.**

```java
S3Client.builder().region(Region.US_EAST_1).build();
// bucket is in eu-north-1
```

**Symptom.** 400 errors; Eclipse Store's `start()` fails.

**Fix.** Match region exactly. If unsure, use `default` credentials chain which
also picks a region from env.

## 4. Expecting multi-writer on the same bucket prefix

**Reproducer.** Two JVMs start with the same S3 path.

**Symptom.** Second may "succeed" (lock file is on S3, eventually-consistent
semantics let it through), and then concurrent writes corrupt data.

**Fix.** One manager per bucket/prefix. Directory buckets give you strong
consistency on the lock file; general-purpose buckets are vulnerable.

## 5. Latency to cross-region storage

**Reproducer.** Compute in `us-east-1`, bucket in `eu-west-1`. `start()` takes
30 s.

**Root cause.** Each round trip is ~100 ms; there are dozens during bootstrap.

**Fix.** Co-locate storage and compute. For cross-region, use the bucket for
backups only.

## 6. Unlimited housekeeping on metered storage

**Reproducer.**

```properties
housekeeping-time-budget = 500ms
data-file-minimum-use-ratio = 0.9    # aggressive compaction
```

On S3, every compaction writes a new blob and deletes one.

**Symptom.** Surprising cost on the monthly bill.

**Fix.** Tune down. `housekeeping-time-budget = 50ms` and
`data-file-minimum-use-ratio = 0.6` is a gentler default for metered backends.

## 7. Forgetting the backend SDK dependency

**Reproducer.**

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>afs-aws-s3</artifactId>
</dependency>
<!-- missing software.amazon.awssdk:s3 -->
```

**Symptom.** `NoClassDefFoundError: software/amazon/awssdk/services/s3/S3Client`.

**Fix.** Add the SDK dependency explicitly. Eclipse Store doesn't pin a specific
SDK version so you don't inherit conflicts.

## 8. Azure connection-string vs. account key

Some docs/examples show `connection-string` or `account-name`/`account-key`. Both
work, but mixing them is confusing.

**Fix.** Pick one. Prefer connection-string for app-level configuration;
account-key for tighter separation.

## 9. Kafka compaction removing Eclipse Store data

**Reproducer.** Kafka-backed storage on a topic with aggressive log retention.

**Symptom.** Data silently disappears from Eclipse Store.

**Root cause.** Kafka compacts logs per its own policy; AFS-Kafka cannot always
prevent that.

**Fix.** Disable topic compaction / set retention to infinite for the
Eclipse-Store topic. Kafka AFS is for specific use cases; verify carefully.

## 10. Redis TTL on keys

**Reproducer.** Redis instance has a default key TTL.

**Symptom.** Storage files "expire" and Eclipse Store bails on next read.

**Fix.** Ensure no default TTL on the Redis database. Or use a prefix/namespace
isolated from other Redis consumers.

## 11. SQL AFS dead-locks under load

**Reproducer.** Two channels write concurrently; JDBC driver/database has weak
isolation.

**Symptom.** Random `SQLException` or stalls.

**Fix.** Use channel count = 1 for SQL AFS (or tune the RDBMS for heavy BLOB
writes). SQL is a sub-optimal backend; consider blob stores first.

## 12. Assuming AFS operates like POSIX

**Reproducer.** User expects `rename`/`move` to be atomic on S3.

**Symptom.** Intermittent failures.

**Root cause.** S3 does not have atomic rename. AFS abstracts over "upload new,
delete old" — Eclipse Store relies on this working correctly, which the connector
handles, but user-written code that reaches into AFS directly should not assume
POSIX semantics.

**Fix.** Treat AFS as a key-value blob store with directory-like naming. Use
Eclipse Store's own API; don't bypass AFS for custom logic unless you know what
you're doing.
