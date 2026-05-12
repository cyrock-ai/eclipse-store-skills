# Examples-expanded — housekeeping-and-deletion

## Example 1 — Deleting one entity

```java
public void deleteOrder(String orderId) {
    lock.writeLock().lock();
    try {
        Order o = root.orders().stream()
            .filter(x -> x.id().equals(orderId))
            .findFirst().orElse(null);
        if (o == null) return;

        root.orders().remove(o);
        storage.store(root.orders());
    } finally {
        lock.writeLock().unlock();
    }
}
```

On next housekeeping pass, the old Order's bytes become gap data; file compaction
reclaims them later.

## Example 2 — Deleting all matching entries

```java
public int deleteInactiveCustomers() {
    lock.writeLock().lock();
    try {
        int before = root.customers().size();
        root.customers().entrySet().removeIf(e -> e.getValue().isInactive());
        storage.store(root.customers());
        return before - root.customers().size();
    } finally {
        lock.writeLock().unlock();
    }
}
```

## Example 3 — Deleting a lazy subgraph

```java
public class DataRoot {
    private Lazy<ArrayList<AuditEntry>> archive = Lazy.Reference(new ArrayList<>());
    public Lazy<ArrayList<AuditEntry>> archiveLazy() { return this.archive; }
    public void setArchive(Lazy<ArrayList<AuditEntry>> lz) { this.archive = lz; }
}

// Delete the archive:
Lazy.clear(root.archiveLazy());   // free memory
root.setArchive(null);             // remove the reference from the graph
storage.store(root);               // persist the change
```

## Example 4 — Bulk delete with manual GC afterwards

An administrative cleanup that wants disk space back promptly.

```java
public void purgeOlderThan(Instant cutoff) {
    lock.writeLock().lock();
    try {
        root.audit().removeIf(e -> e.timestamp().isBefore(cutoff));
        storage.store(root.audit());
    } finally {
        lock.writeLock().unlock();
    }

    // Outside the lock — readers can proceed during GC if they use read locks
    storage.issueFullGarbageCollection();
    storage.issueFullFileCheck();
    // Disk size now reflects the deletion
}
```

## Example 5 — Time-boxed maintenance window

Ops wants to spend at most 60 s on housekeeping per night.

```java
long budget = Duration.ofSeconds(20).toNanos();

boolean gcDone     = storage.issueGarbageCollection(budget);
boolean fileDone   = storage.issueFileCheck(budget);
boolean cacheEmpty = storage.issueCacheCheck(budget);          // see note below

System.out.println("gc=" + gcDone + " file=" + fileDone + " cacheEmpty=" + cacheEmpty);
```

`gcDone` / `fileDone` are completion flags: `false` means more time is needed; call
again next window. `cacheEmpty` is **not** a completion flag — it returns whether
the entity cache size is or became 0. A hot service typically reports `false`.

## Example 6 — Custom file evaluator at startup

A custom `StorageDataFileEvaluator` is configured on the foundation **before**
`.start()` and applies to every housekeeping cycle for the lifetime of the
manager. Per-call evaluators are not supported.

```java
StorageDataFileEvaluator archivalEvaluator =
    StorageDataFileEvaluator.New(
        1 * 1024 * 1024,        // min 1 MiB (int)
        1024 * 1024 * 1024,     // max 1 GiB (int) — allow big files
        0.5,                    // compact only at <50% payload (relaxed)
        false                   // don't compact the head file
    );

EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
        Storage.ConfigurationBuilder()
            .setDataFileEvaluator(archivalEvaluator)
            .createConfiguration()
    )
    .start(root);
```

## Example 7 — Tune housekeeping via config

From `storage.ini`:

```ini
housekeeping-interval = 1s
housekeeping-time-budget = 50ms
housekeeping-adaptive = true
housekeeping-maximum-time-budget = 500ms
housekeeping-increase-threshold = 5s
housekeeping-increase-amount = 50ms

entity-cache-timeout = 2h
entity-cache-threshold = 1000000000

data-file-minimum-size = 1 MiB
data-file-maximum-size = 16 MiB
data-file-minimum-use-ratio = 0.7
```

These give:

- A cycle every 1 s, normally 50 ms of work, up to 500 ms if falling behind.
- Entity cache drops per-entity data after 2 h idle.
- Data files kept between 1-16 MiB; compact when live-payload is < 70%.

## Example 8 — Scheduled full GC via JVM timer

If adaptive housekeeping still isn't catching up in a write-heavy workload:

```java
ScheduledExecutorService es = Executors.newSingleThreadScheduledExecutor();
es.scheduleAtFixedRate(() -> {
    try {
        storage.issueGarbageCollection(Duration.ofSeconds(30).toNanos());
        storage.issueFileCheck(Duration.ofSeconds(10).toNanos());
    } catch (Throwable t) {
        // log
    }
}, 30, 30, TimeUnit.MINUTES);
```

Prefer raising the daemon's budget over adding custom schedulers — custom ones become
opaque operational surface.
