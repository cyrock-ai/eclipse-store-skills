---
name: housekeeping-and-deletion
description: >
  Guide Claude on deleting data from Eclipse Store (via reference removal) and on
  tuning / triggering housekeeping — garbage collection, file compaction, entity cache
  eviction. Use this skill when the user asks to "delete data", "remove an object",
  "garbage collect", "issueGarbageCollection", "issueCacheCheck", "issueFileCheck",
  "compact files", "free disk space", "why is my database so large", "fragmentation",
  "trigger housekeeping manually", "increase housekeeping budget", "housekeeping-
  adaptive", "entity-cache-timeout", "data-file-minimum-use-ratio", or is confused
  about why freshly deleted objects still take disk space or are still visible in a
  raw file scan.
version: 0.1.0
---

# Eclipse Store — Housekeeping & Deletion

Eclipse Store has no explicit `DELETE`. Deletion is a side effect of dropping references
and letting housekeeping's garbage collector detect unreachable objects. This skill
covers both halves: how to delete correctly, and how housekeeping actually frees the
bytes.

## When to use this skill

- User wants to delete an object, a collection element, a whole subgraph.
- User asks why a "deleted" object still shows on disk size.
- User is tuning housekeeping interval, budget, adaptive mode.
- User asks about file compaction, `data-file-minimum-use-ratio`, data-file size
  thresholds.
- User wants to trigger GC / cache check / file check manually.
- User's entity cache is too large or too small.

**Route elsewhere** when:

- User is confused about `store()` cascading, not deletion → `storing-data`.
- User wants to reduce load time, not delete → `lazy-loading`.
- User wants to migrate to a new class shape → `legacy-type-mapping`.

## Mental model

Eclipse Store's storage on disk has three layers of "cleanup":

1. **Object graph GC** (garbage collection of *persisted* objects). An object is
   garbage when no reachable object references it. Housekeeping's GC walks the graph,
   marks reachable objects, and the rest become "gaps".
2. **File compaction.** Files accumulate gaps as objects are replaced or deleted.
   When a file's "payload ratio" drops below `data-file-minimum-use-ratio` (default
   0.75), housekeeping retires it — copying live data to a new file, deleting the old
   one.
3. **Entity cache eviction.** In-memory caching of loaded entity data. If not used for
   `entity-cache-timeout`, data is dropped (JVM GC reclaims).

All three run together in the housekeeping daemon on a scheduled interval with a time
budget. You can also trigger each manually via `StorageConnection.issue*` methods.

**To delete an object**, you don't call a delete method. You:

1. Remove all references to it (remove from collections, null out fields).
2. Store the parent (so the graph change is persisted).

Next housekeeping GC pass marks the object unreachable. The file it lives in gets a
gap. Eventually the file is compacted and the physical bytes are gone.

## Core API — housekeeping control

From `EmbeddedStorageManager` (which implements `StorageConnection`):

| Method | Purpose |
|---|---|
| `void issueFullGarbageCollection()` | Run GC to completion, regardless of time. |
| `boolean issueGarbageCollection(long nanoBudget)` | Time-boxed GC; returns true if complete. |
| `void issueFullCacheCheck()` / `(StorageEntityCacheEvaluator)` | Full cache eviction scan. |
| `boolean issueCacheCheck(long nanoBudget)` / `(long, ...)` | Time-boxed cache scan. |
| `void issueFullFileCheck()` / `(StorageDataFileEvaluator)` | Full file compaction scan. |
| `boolean issueFileCheck(long nanoBudget)` / `(long, ...)` | Time-boxed file scan. |

And the config properties already covered in `configuration`:

| Property | Default | Purpose |
|---|---|---|
| `housekeeping-interval` | `1s` | Between cycles. |
| `housekeeping-time-budget` | `10ms` | Per cycle. |
| `housekeeping-adaptive` | `false` | Auto-raise budget when GC falls behind. |
| `data-file-minimum-use-ratio` | `0.75` | Payload threshold for compaction. |
| `data-file-minimum-size` / `-maximum-size` | `1 MiB` / `8 MiB` | File size bounds. |
| `entity-cache-threshold` | `1_000_000_000` | Cache lifetime weight. |
| `entity-cache-timeout` | `1d` | Max idle time for cached entity data. |

## Core API — deletion

There is no delete API. The rule is always **"remove the reference, store the parent"**.

## Idiomatic patterns — deletion

### Pattern A — Remove from a collection

```java
// List
root.orders().remove(order);                  // or remove(index), removeIf(...)
storage.store(root.orders());

// Map
root.customers().remove(customerId);
storage.store(root.customers());

// Set
root.tags().remove(tag);
storage.store(root.tags());
```

### Pattern B — Null a single-reference field

```java
root.setCurrentSession(null);
storage.store(root);      // here storeRoot is fine, but store(root) is equivalent
```

### Pattern C — Clear an entire collection

```java
root.orders().clear();
storage.store(root.orders());
```

### Pattern D — Bulk deletion

```java
List<Customer> inactive = root.customers().values().stream()
    .filter(Customer::isInactive)
    .toList();

root.customers().entrySet().removeIf(e -> e.getValue().isInactive());
storage.store(root.customers());
```

### Pattern E — Delete behind a `Lazy` reference

```java
// Clear loaded data and remove the reference
Lazy.clear(root.getArchive());    // null-safe; drops the loaded subgraph
root.setArchive(null);            // remove the reference from the graph
storage.store(root);
```

For a map of `Lazy<V>`:

```java
Lazy<Customer> removed = root.customers().remove(customerId);
Lazy.clear(removed);              // optional but frees memory immediately
storage.store(root.customers());
```

### Pattern F — Delete + thread safety

Apply the same lock pattern from `storing-data`:

```java
lock.writeLock().lock();
try {
    root.orders().remove(order);
    storage.store(root.orders());
} finally {
    lock.writeLock().unlock();
}
```

## Idiomatic patterns — manual housekeeping

### Pattern G — Force GC after a bulk deletion

```java
// After a big cleanup where you want disk space freed promptly:
root.orders().clear();
storage.store(root.orders());

storage.issueFullGarbageCollection();
storage.issueFullFileCheck();      // compact now
```

### Pattern H — Time-boxed manual run on a maintenance window

```java
long budget = Duration.ofSeconds(30).toNanos();
storage.issueGarbageCollection(budget);
storage.issueFileCheck(budget);
storage.issueCacheCheck(budget);
```

`issue*` with a budget returns `true` if the work finished within the budget,
`false` if it was cut off. Call again if not complete.

### Pattern I — Enable adaptive housekeeping

If you've seen GC fall behind under burst load:

```ini
housekeeping-adaptive = true
housekeeping-maximum-time-budget = 500ms
housekeeping-increase-threshold = 5s
housekeeping-increase-amount = 50ms
```

Adaptive housekeeping raises the budget when work is persistently piling up, up to
the `maximum-time-budget` ceiling.

**Production recommendation.** On for write-heavy workloads; the fixed default
is sufficient for read-heavy or low-write applications. The fixed default
silently lets disk usage grow past what the data warrants when the writer
outpaces housekeeping. See `configuration` →
`references/dev-test-staging-prod.md` for the per-environment matrix
(staging should match prod so the pause behaviour is exercised
representatively before release).

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — "Storing the deleted object"

```java
// WRONG
root.orders().remove(order);
storage.store(order);         // stores the orphaned object; does nothing for deletion
```

You must store the **parent** (the map/list/root that no longer references `order`).
`store(order)` would only re-persist it with no parent, which is a waste at best and
confusing at worst.

### Anti-pattern 2 — Expecting immediate file shrinkage

```java
root.orders().clear();
storage.store(root.orders());
long size = Files.walk(dataDir).mapToLong(p -> p.toFile().length()).sum();
// size is still the same — data is now "gap" but not yet compacted
```

File size doesn't drop until housekeeping compacts the files. For urgency use Pattern
G (manual GC + file check).

### Anti-pattern 3 — Running `issueFullGarbageCollection` in a hot path

```java
// WRONG
public void deleteOrder(Order o) {
    root.orders().remove(o);
    storage.store(root.orders());
    storage.issueFullGarbageCollection();     // blocks the caller
}
```

Manual full GC blocks. Let the daemon do it on schedule; trigger manually only during
maintenance windows or after a rare bulk operation.

### Anti-pattern 4 — `data-file-minimum-use-ratio = 1.0`

```ini
data-file-minimum-use-ratio = 1.0
```

"Don't tolerate any gaps" → every update triggers a file retirement. Extreme write
amplification.

**Fix**: keep 0.5-0.9 range. Default 0.75 is a good balance.

### Anti-pattern 5 — `data-file-minimum-use-ratio = 0.0`

Equivalent to "never compact". Disk grows without bound.

### Anti-pattern 6 — Forgetting that GC respects strong references from JVM statics

If your app's domain code holds a static reference to the entity you just "deleted",
it stays alive — GC only sees the *persistent* graph. This is rarely a problem unless
code is designed around JVM-static references to persisted objects.

## Pitfalls & gotchas

1. **Deletion is eventual.** Space is freed asynchronously. Budget for this — a
   "delete-heavy" workload is write-heavy on disk because of compaction.
2. **Default cache timeout is 1 day.** For short-lived tools this is irrelevant; for
   long-running services it means cached entity data keeps heap usage high. Tune
   `entity-cache-timeout` down if the domain is access-sparse.
3. **`issueFullGarbageCollection()` blocks the caller.** Runs on the caller's thread
   (via a `StorageConnection`). Do not call from an HTTP request handler.
4. **Transaction files grow too.** `transaction-file-maximum-size` caps them; past
   that, housekeeping compacts the transaction log. Default 100 MB. Max allowed 1 GB.
5. **Deletion directory fills the disk.** If you set `deletion-directory`, housekeeping
   moves retired files there instead of deleting — you must clean it manually.
6. **`data-file-cleanup-head-file = true` can slow writes.** The head file is the one
   currently being appended to. Compacting it mid-append is extra work. Keep false
   unless you have a specific reason.
7. **`Lazy.clear()` before removing the reference** is optional — you can do it in any
   order. But calling `.clear()` on a null reference throws; prefer `Lazy.clear(lz)`
   (static) for null-safety.

## Interactions with other skills

- **`storing-data`** — delete = remove reference + store parent. Same "modified
  object must be stored" rule.
- **`configuration`** — all the tuning knobs (interval, budget, ratio, cache timeout)
  are config properties authored there; the *semantics* live here.
- **`lazy-loading`** — `Lazy.clear()` frees heap; it is not deletion.
  Deleting a lazy-wrapped subgraph means clearing the reference in the graph.
- **`legacy-type-mapping`** — when you remove a field, old binary data becomes
  migration-relevant; that skill handles reading old shapes.

## Recipes

**"How do I delete an object?"** → Remove the reference from its parent, store the
parent. Done.

**"I deleted 1 M objects — my files are still huge."** → They will be compacted on
the next housekeeping cycle. For urgency: `issueFullGarbageCollection()` +
`issueFullFileCheck()` on a maintenance window.

**"How do I know when housekeeping catches up?"** → The daemon runs on every
interval; within a few cycles of the deletion, disk size should drop. Or instrument
`issueGarbageCollection(budget)` returning true.

**"My entity cache is eating memory."** → Tune `entity-cache-timeout` down (e.g.
`1h`), or call `issueFullCacheCheck()` manually in an idle period.

**"The docs mention a payload ratio of 0.75 — should I tune it?"** → Only if you
have a specific problem. Raising it saves disk; lowering it saves IO. Default is
sensible.

**"Are retired files actually deleted or moved?"** → By default deleted. If you set
`deletion-directory`, they are moved there instead (for forensic/recovery purposes).

**"Can I disable housekeeping?"** → Setting a very long interval and tiny budget
effectively disables it. Don't — it defers work, doesn't eliminate it, and the first
cycle after you re-enable can be a giant stall.

**"What counts as `entity-cache-threshold`?"** → It's an abstract weighting of
cached entity data size × idle time. A higher number means evict more aggressively
when memory pressure appears. Default is "essentially infinite" for most apps.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — full `issue*` method signatures, evaluator types.
- `references/examples-expanded.md` — five deletion examples and three manual-
  housekeeping patterns.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer and fix.
- `references/gc-scheduling-math.md` — how interval + budget interact, worked example
  calculating CPU usage.
- `references/manual-vs-automatic.md` — when to rely on the daemon vs. when to
  trigger manually.

## Upstream sources

- `docs/modules/storage/pages/deleting-data.adoc` — canonical deletion guide.
- `docs/modules/storage/pages/housekeeping.adoc` — housekeeping overview.
- `docs/modules/storage/pages/configuration/housekeeping.adoc` — the knobs.
- `examples/deleting/` — upstream runnable examples.
