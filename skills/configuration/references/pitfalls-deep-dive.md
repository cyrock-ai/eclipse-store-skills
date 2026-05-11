# Pitfalls deep-dive — configuration

## 1. `createEmbeddedStorageManager()` returns an *unstarted* manager

**Reproducer.**

```java
var m = EmbeddedStorageConfiguration.Builder()
    .setStorageDirectory("data")
    .createEmbeddedStorageFoundation()
    .createEmbeddedStorageManager();   // NOT yet started
AppRoot root = (AppRoot) m.root();     // throws — manager not running
```

**Root cause.** `createEmbeddedStorageManager()` only creates the manager. It
does not start it.

**Fix.** Call `.start()` on the result, or use `EmbeddedStorage.start(...)` /
`foundation.start(...)` which return a started manager.

## 2. Channel count not a power of 2

**Reproducer.**

```ini
channel-count = 3
```

**Symptom.** Startup throws.

**Fix.** Use 1, 2, 4, 8, …. The foundation rejects other values.

## 3. Trying to change channel count on a live database

**Reproducer.** Bumping `channel-count` from 1 to 4 in the INI after running in
production for a month.

**Symptom.** Startup may succeed (data still reads fine), but housekeeping gets
confused: channel 0 contains all historical data, channels 1-3 are empty. Subsequent
writes distribute; housekeeping compacts each channel independently, producing
misleading disk usage.

**Fix.** Plan channel count up front. If you must migrate: take the storage offline,
export, build a new directory with the new count, re-import. See
`references/channel-count-tuning.md`.

## 4. `load("/...")` with leading slash → `ConfigurationExceptionNoConfigurationFound`

**Reproducer.**

```java
EmbeddedStorageConfiguration.load("/META-INF/eclipsestore/storage.ini")
```

The file is present at `src/main/resources/META-INF/eclipsestore/storage.ini`,
but the call still throws:

```
ConfigurationExceptionNoConfigurationFound: No configuration found at:
    /META-INF/eclipsestore/storage.ini
```

**Root cause.** `EmbeddedStorageConfiguration.load(String)` delegates to
`ConfigurationLoader.New(path)`, which calls `ClassLoader.getResource(path)`.
**`ClassLoader.getResource` rejects `/`-prefixed paths** (unlike
`Class.getResource`, which strips the leading slash). When classpath
resolution fails, the loader falls back to URL and filesystem — neither
matches either — and throws.

**Fix.** Drop the leading slash:

```java
EmbeddedStorageConfiguration.load("META-INF/eclipsestore/storage.ini")
```

For filesystem loading from an absolute path, pass a `File`:

```java
EmbeddedStorageConfiguration.load(
    ConfigurationLoader.New(new File("/etc/myapp/storage.ini")),
    ConfigurationParserIni.New()
);
```

## 5. `~` in non-directory property

**Reproducer.**

```ini
lock-file-name = ~/my-lock.sfl
```

**Symptom.** Lock file is named literally `~/my-lock.sfl` in the storage directory —
not what the user wanted.

**Root cause.** `~` expansion applies only to directory properties.

**Fix.** Don't put a `~` in file-name properties. If you want a custom lock location,
use a custom `StorageFileNameProvider` on the foundation.

## 6. `deletion-directory` fills the disk

**Reproducer.** Ops sets `deletion-directory = /var/lib/myapp/deleted` and forgets
about it.

**Symptom.** Disk fills up over months as housekeeping moves files here instead of
deleting.

**Root cause.** Eclipse Store never cleans the deletion directory — it's a one-way
safety net.

**Fix.** Cron job or logrotate on that directory, or remove the property once you're
confident housekeeping behaves.

## 7. YAML loader missing dependency

**Reproducer.**

```java
EmbeddedStorageConfiguration.load(loader, ConfigurationParserYaml.New())
```

…without `configuration-yaml` on the classpath.

**Symptom.** `NoClassDefFoundError` on startup.

**Fix.** Add the dependency:

```xml
<dependency>
    <groupId>org.eclipse.serializer</groupId>
    <artifactId>configuration-yaml</artifactId>
    <version>${eclipse-serializer.version}</version>
</dependency>
```

Same for `configuration-hocon` (for JSON/HOCON).

## 8. Read-only manager used too long

**Reproducer.** Open a read-only manager, keep it around for days. Meanwhile the
writer runs housekeeping and compacts files.

**Symptom.** Read-only manager throws on some read because the file layout changed.

**Root cause.** Read-only managers snapshot the file layout at `.start()`. They don't
receive structural updates.

**Fix.** Short-lived RO managers: open, read, close, discard. Or take a file-system
snapshot first and point the RO manager at the snapshot.

## 9. Housekeeping budget too aggressive on a small app

**Reproducer.**

```ini
housekeeping-time-budget = 500ms
```

**Symptom.** CPU usage bumps every second even when the app has almost nothing to
clean up.

**Root cause.** The budget is an upper bound per cycle — if there's work to do,
housekeeping uses up to this much. Small apps with idle churn don't need it this high.

**Fix.** Default (10 ms) is fine for most apps. Raise only if housekeeping is visibly
falling behind (growing `_live.sfl`, bloating deletion-directory-if-off).

## 10. Forgot to shut down the manager between tests

**Reproducer.**

```java
@Test
void test() {
    var m = EmbeddedStorageConfiguration.Builder()
        .setStorageDirectory(tempDir.toString())
        .createEmbeddedStorageFoundation()
        .createEmbeddedStorageManager();
    m.start();
    // forgot to shutdown
}
```

**Symptom.** Next test fails because the previous test's manager still holds a lock.

**Fix.** Use try-with-resources or `@AfterEach` shutdown:

```java
try (var m = EmbeddedStorageConfiguration.Builder()
        .setStorageDirectory(tempDir.toString())
        .createEmbeddedStorageFoundation()
        .createEmbeddedStorageManager()) {
    m.start();
    // ...
}
```

## 11. Backup directory on slow / network filesystem

**Reproducer.**

```ini
backup-directory = /mnt/nfs/slow
```

**Symptom.** Write latency spikes correlated with backup traffic.

**Root cause.** Backup is synchronous in the sense that it must keep up with the
write stream. Slow backup storage back-pressures the primary.

**Fix.** Use local SSD for live, asynchronous cron snapshot to remote. Or use an AFS
backup filesystem with caching (see `storage-targets-afs`).

## 12. Confusing `storage-embedded-configuration` with Spring Boot config

**Reproducer.** User tries to put Eclipse Store settings in
`application.properties` under `storage-directory = data` without the Spring starter.

**Symptom.** Silently ignored — Spring doesn't know to hand it to Eclipse Store.

**Fix.** Either:
- Use Spring Boot: add `integrations-spring-boot3`, use `org.eclipse.store.*`
  properties (see `spring-boot` skill).
- Use a separate Eclipse Store config file and load with
  `EmbeddedStorageConfiguration.load(...)`.

Never mix both without understanding which is authoritative.
