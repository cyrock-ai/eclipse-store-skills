# Pitfalls deep-dive — housekeeping-and-deletion

## 1. Storing the deleted object instead of the parent

**Reproducer.**

```java
root.orders().remove(order);
storage.store(order);           // wrong
```

**Symptom.** The order remains referenced by the map because the map was never re-
persisted. On the next run, it is still visible.

**Fix.** `storage.store(root.orders())`.

## 2. Expecting immediate disk shrinkage

**Reproducer.**

```java
root.logs().clear();
storage.store(root.logs());
System.out.println(Files.size(storageDir)); // unchanged
```

**Symptom.** Confusion that "delete doesn't work".

**Root cause.** The bytes still live in storage files until housekeeping compacts
them. Default cycle is 1 s, budget 10 ms — a big deletion can take minutes.

**Fix.** Either wait for housekeeping, or force it:

```java
storage.issueFullGarbageCollection();
storage.issueFullFileCheck();
```

## 3. Calling `issueFullGarbageCollection()` from a request handler

**Reproducer.**

```java
@PostMapping("/admin/cleanup")
public ResponseEntity<?> cleanup() {
    storage.issueFullGarbageCollection();   // blocks the HTTP thread
    return ResponseEntity.ok().build();
}
```

**Symptom.** HTTP request times out; the endpoint hangs.

**Root cause.** `issueFullGarbageCollection` is synchronous and expensive.

**Fix.** Move to an async job, or use the time-boxed version:

```java
storage.issueGarbageCollection(Duration.ofSeconds(10).toNanos());
```

## 4. `data-file-minimum-use-ratio = 1.0`

**Reproducer.**

```ini
data-file-minimum-use-ratio = 1.0
```

**Symptom.** Every update causes file retirement; massive write amplification; disk
IO pegged.

**Fix.** Use a sensible value between 0.5 and 0.9. Default 0.75 is the sweet spot.

## 5. Forgetting `Lazy.clear()` before dropping the reference

**Reproducer.**

```java
root.setArchive(null);           // reference removed, graph-wise
storage.store(root);
// But the Lazy wrapper and its ArrayList are still in the JVM heap
```

**Symptom.** Memory usage doesn't drop until JVM GC; for large archives this can
cause temporary pressure.

**Fix.** `Lazy.clear(root.archiveLazy())` before nulling, to release the hard
reference immediately.

## 6. `deletion-directory` set but never cleaned

**Reproducer.**

```ini
deletion-directory = /var/lib/app/deleted
```

Over months, `/var/lib/app/deleted` grows to hundreds of GB.

**Root cause.** Eclipse Store does not clean this directory. It is a one-way safety
net for ops.

**Fix.** Either rotate/clean the directory via cron, or drop the property once you're
confident in housekeeping.

## 7. `entity-cache-timeout` too short on a warm-cache workload

**Reproducer.**

```ini
entity-cache-timeout = 10s
```

On a dashboard that pulls the same entities every 15 s, every refresh triggers a
re-load from disk.

**Root cause.** Cache eviction is idle-time based.

**Fix.** Raise the timeout to match the access cadence (`5m`, `1h`, …).

## 8. Running housekeeping during a known-idle window but the budget is tiny

**Reproducer.**

```ini
housekeeping-time-budget = 1ms
```

**Symptom.** GC and compaction can't keep up; backlog grows forever.

**Root cause.** 1 ms per 1 s cycle = 0.1% CPU. Not enough for anything but tiny apps.

**Fix.** Raise to `10ms`-`100ms` depending on write rate. Enable adaptive mode for
auto-scaling.

## 9. Deleting from a Lazy-wrapped collection without storing the inner

**Reproducer.**

```java
ArrayList<Turnover> list = Lazy.get(year.turnoversLazy());
list.remove(t);
storage.store(year);   // year reference unchanged
```

**Symptom.** Turnover still visible next run.

**Root cause.** The inner `ArrayList` is what changed.

**Fix.** `storage.store(Lazy.get(year.turnoversLazy()))` — store the collection.

## 10. Thinking `store(parent)` re-persists already-persisted children

**Reproducer.**

```java
// persistent list contains [a, b, c]; you mutate b's internals then:
storage.store(root.list());
```

**Symptom.** b's mutation not saved.

**Root cause.** Default lazy storing skips already-persisted children. The parent
(list) is stored fine, but the mutated `b` is not.

**Fix.** `storage.store(b)` explicitly. Or use eager storing if this is the common
case in your domain.

This is strictly a *storing* issue covered in `storing-data`, but it commonly
surfaces during deletion thought experiments — be aware.

## 11. Manual GC with a too-small budget returns false repeatedly

**Reproducer.**

```java
while (!storage.issueGarbageCollection(Duration.ofMillis(10).toNanos())) {
    // tight loop
}
```

**Symptom.** The loop spins — 10 ms budget is never enough for a large graph.

**Fix.** Use a larger budget, or space out calls with sleeps to let the regular
daemon make progress too.

## 12. Transaction files huge but you didn't expect them

**Reproducer.** Long-running writer; transaction files (`transactions_0.sft`) grow
past 100 MB despite default `transaction-file-maximum-size`.

**Root cause.** Housekeeping compacts transaction logs — but only when it runs. A
disabled / tiny budget stops compaction.

**Fix.** Ensure housekeeping is actually running. Check the budget and interval.
