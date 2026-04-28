# Best Practices — Dev / Test / Staging / Prod

Per-feature reasoning behind the table in `SKILL.md`. Each entry explains
*why* the recommendation differs across environments, plus how to enable the
feature when you do want it on.

The columns mean:

- **Dev** — a developer's machine. Storage is disposable.
- **Test** — automated tests targeting *application logic* (unit, fast
  integration). Predictable, repeatable behaviour matters more than
  operational fidelity.
- **Staging** — automated or manual tests targeting *the production
  deployment itself*. Release validation, dress rehearsal. The whole point is
  to exercise prod's operational features.
- **Prod** — production. Operational concerns dominate.

If a single test suite mixes "logic" and "deployment" goals, split it — or
pick the column whose goal dominates and accept that the other goal is being
checked elsewhere.

---

## Lock file

Default: off. Configure via `lock-file-name` / the lock-file properties.

The OS-level file lock is sufficient for the common case of a single
application owning the storage. The proprietary lock file is only needed
when more than one Eclipse Store process may try to access the same files
(blue/green deploys, accidental double-start during a rolling restart, a
sidecar). Has nothing to do with thread-level concurrency in a single JVM.

| | |
|---|---|
| Dev | Off. Quick restarts from an IDE produce stale-lock waits with no benefit when only one process accesses the storage. |
| Test | Off. Same as dev. Enable only in tests that deliberately exercise multi-process access. |
| Staging | Match prod. If prod runs with the lock file on, staging must too — otherwise staging is not exercising the same startup and restart paths. |
| Prod | On if more than one JVM may share the storage. Off is safe if a single application owns the storage exclusively. |

---

## Deletion directory

Default: off. Configure via `deletion-directory`.

When configured, housekeeping moves data files into the deletion directory
instead of erasing them. Recovering an object that was incorrectly garbage-
collected (because a root reference was unintentionally dropped before a
`store()`) is impossible after a normal delete, but trivial as long as the
file still exists in the deletion directory.

| | |
|---|---|
| Dev | Off. Disk usage and operational complexity outweigh the benefit on a developer machine where the storage can be recreated. |
| Test | Off. Recreate fixtures rather than recover them. |
| Staging | **On.** Mirror prod so the cleanup job, disk allocation, and any recovery procedures are exercised before they matter. |
| Prod | **On.** Cheap insurance against operator error and against bugs in storing logic. Pair with a periodic cleanup job (or a generous disk allocation). |

---

## Truncation directory

Default: off. Configure via `truncation-directory`.

Files truncated during housekeeping (when a file's used-ratio drops below
the configured threshold and it is rewritten in compacted form) are copied
to this directory before truncation. Useful for forensics if you suspect
housekeeping is removing live data, but rarely needed in healthy operation.

| | |
|---|---|
| Dev | Off. |
| Test | Off, unless the test under investigation specifically exercises file truncation. |
| Staging | Optional. Same default as prod — leave off unless reproducing a housekeeping-related incident. |
| Prod | Optional. Enable temporarily during incident investigation; leave off by default to control disk usage. |

---

## Continuous backup

Default: off. Configure via `backup-directory` (or the
`backup-filesystem.*` AFS properties for cloud targets).

When enabled, every change written to the primary storage is mirrored to a
backup directory in real time. The backup is byte-identical and can be used
directly as a storage if the primary is lost. Overhead is modest — writes go
to two targets in parallel rather than being copied after the fact.

| | |
|---|---|
| Dev | Off. The primary storage is disposable. |
| Test | Off, unless the test specifically exercises backup/restore behaviour. |
| Staging | **On.** The backup pipeline itself is part of what staging validates — running staging without it leaves a hole in the dress rehearsal. |
| Prod | **On.** The single most effective protection against disk failure or accidental deletion. Place the backup on a separate physical disk, host, or AFS storage target. |

---

## Full backup

Default: not applicable (manual operation). Triggered via
`EmbeddedStorageManager.issueFullBackup(...)`.

A full backup is a one-shot snapshot. It is a **blocking** operation: store
operations are paused for the duration, which can be significant for large
storages.

| | |
|---|---|
| Dev | Ad-hoc. Use to capture interesting fixtures or before destructive experiments. |
| Test | Ad-hoc. Useful for seeding integration-test environments from a known state. |
| Staging | Scheduled, on the same cadence as prod. The blocking pause is itself a load-test signal — if it disrupts staging it will disrupt prod. |
| Prod | Schedule during off-peak hours (e.g. nightly cron) as a periodic safety net on top of continuous backup. Also recommended before major migrations or schema changes. |

---

## Adaptive housekeeping

Default: off (fixed time budget of 10 ms per 1-second interval). Configure
via `housekeeping-adaptive=true`.

Adaptive housekeeping increases the time budget when housekeeping cannot
keep up with incoming writes. Without it, write-heavy workloads can leave
files uncollected and cause disk usage to grow well past what the data
warrants.

| | |
|---|---|
| Dev | Off. The fixed default keeps housekeeping unobtrusive on a developer machine. |
| Test | Off. Predictable, repeatable behaviour is more valuable in tests than throughput. |
| Staging | Match prod. If prod runs adaptive, staging must too — otherwise staging's disk usage and pause behaviour diverge from production under load. |
| Prod | On for write-heavy workloads. The fixed default is sufficient for read-heavy or low-write applications; switch to adaptive when you observe disk usage growing faster than the underlying data. |

---

## Channel count

Default: 1. Configure via `channel-count` (must be a power of two).

Channels are the IO threads (and corresponding storage subdirectories) that
Eclipse Store uses in parallel. **The channel count is fixed for the
lifetime of a storage** — changing it later requires migration. Pick the
right number up front.

| | |
|---|---|
| Dev | 1. Simplest setup, easiest to inspect on disk. |
| Test | 1, unless the test specifically exercises multi-channel parallelism. |
| Staging | Use the same channel count you intend for prod. Channel count cannot be changed without migration; staging is where you confirm the choice on representative hardware and workload. |
| Prod | Tune to your workload and hardware. More channels mean higher write parallelism but more files and more memory; a single channel is often fine for read-heavy or moderate-write applications. |

---

## Read-only mode

Default: off. Enabled via `StorageWriteControllerReadOnlyMode` on the
foundation (see `SKILL.md` Pattern E).

A read-only storage manager rejects all writes and disables housekeeping,
which lets it coexist with another writing manager — the only supported way
to have two managers on the same storage. Useful for read replicas, ad-hoc
inspection of a backup, or analytics workloads that should not mutate data.

| | |
|---|---|
| Dev | Not applicable. |
| Test | Optional. Useful for tests that load a fixture and assert against it without ever mutating. |
| Staging | On for replica or snapshot-inspection deployments — the same scenarios as prod, exercised against staging data so the read-only manager's lifecycle is validated. |
| Prod | On for read-replica or snapshot-inspection deployments. **Keep the read-only manager short-lived**: it does not see writes from the primary manager and will eventually be invalidated by housekeeping there. |

---

## JMX monitoring

Default: JMX beans are always exposed by Eclipse Store; remote JMX is
configured at the JVM level and is off by default.

Eclipse Store publishes JMX beans for storage growth, entity cache, lazy
references, object registry, and per-channel metrics. The beans themselves
are free to expose; the operational risk is in how the JVM exposes the JMX
port.

| | |
|---|---|
| Dev | Auth and SSL off (typical local-only JMX setup) is fine. |
| Test | Auth and SSL off is fine in isolated test infrastructure. |
| Staging | **Auth and SSL on**, configured exactly like prod. Staging is reachable from more than just a developer's laptop, and the JMX hardening recipe needs to be exercised end-to-end before it's relied on in prod. |
| Prod | **Authentication and SSL must be on.** Restrict the JMX port to a monitoring network or block it at the firewall. **An unauthenticated JMX port is remote code execution.** |

---

## REST interface

Default: off (`org.eclipse.store.rest.enabled=false` in the Spring Boot
integration).

The REST interface exposes the object graph for inspection — invaluable
during development and debugging. It is read-only at the protocol level,
but the data it returns is your application's data, so the same access
controls that govern the application as a whole must govern the REST
endpoint.

| | |
|---|---|
| Dev | On. Useful for inspecting the live object graph from a browser or the client GUI. |
| Test | Optional. Convenient for diagnosing test failures. |
| Staging | Off by default, or behind the same auth and network isolation as prod. The point of staging is to confirm those controls work — leaving the REST interface wide open in staging defeats it. |
| Prod | Off by default. If you need it for operations, place it behind authentication (Spring Security or equivalent) and restrict it to an internal network. **The bundled Client GUI is a development tool and should not be exposed publicly.** |

---

## Cross-references

- `SKILL.md` (this skill) — Pattern E for read-only mode, channel-count
  sizing guidance, the property-name list.
- `housekeeping-and-deletion` — adaptive housekeeping mechanics and tuning.
- `storage-targets-afs` — backup directories on cloud targets (S3, Azure
  Blob, Redis, Kafka).
- `concurrency-and-locking` — the lock *file* (process-level) is unrelated
  to thread-level concurrency, but they are easy to confuse.
- `spring-boot` — the Spring Boot starter exposes most of these settings via
  `org.eclipse.store.*` properties; the REST interface in particular is
  enabled there.
