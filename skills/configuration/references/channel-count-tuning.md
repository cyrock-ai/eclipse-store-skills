# Channel-count tuning

## What a channel is

A channel is an IO thread with an exclusive storage subdirectory. Every channel does
its own reads and writes to its own files. There is no cross-channel locking: the
channel count is the parallelism ceiling for storage IO.

## Default and recommended values

- **Default: 1.** Single channel, single thread, single subdirectory. Fine for apps
  that store < a few GB and have modest write rates.
- **2-4: typical for busy services.** Measurable improvement when multiple hot
  aggregates are being written concurrently.
- **8: large datasets, heavy concurrent writes, fast SSDs.** Diminishing returns.
- **> 8: almost never helps.** Coordination overhead dominates.

## Must be a power of 2

`StorageChannelCountProvider` rejects non-power-of-2 values at foundation build time.

## Why changing channel count requires migration

Each channel owns its directory and its objects — the object-id-to-file mapping is
channel-indexed. If you change `channel-count` from 1 to 4:

- The existing `channel_0/` directory still holds 100% of data.
- Channels 1, 2, 3 are empty on disk; the manager does not re-balance.
- Housekeeping behaviour becomes unpredictable.

### Migration procedure

1. Stop the live manager (or take a file-system copy of the data directory while it's
   stopped).
2. Spin up a read-only manager on the old copy.
3. Walk the graph and export to an intermediate format (serialize to JSON/CSV, or use
   `import-export` if your data model fits).
4. Create a fresh directory with the new channel count.
5. Re-import into the new directory.

This is rarely worth it for channel count alone. Pick the right number up front.

## Signs you should raise channel count

- IO wait in thread dumps during `store()` calls.
- Storage files getting close to `data-file-maximum-size` frequently; housekeeping
  stalls.
- Multiple application threads all waiting on `storage.store(...)`.
- Monitor shows a single `storage-channel-0` thread at 100% CPU while other cores idle.

## Signs you should **not** raise channel count

- Slow loads — that's lazy loading or graph design, not IO parallelism. Use `Lazy<>`.
- Slow startup — the root is big. See `lazy-loading`.
- Slow queries — Eclipse Store doesn't have queries; you're iterating a collection.
  Consider `GigaMap`.
- High memory use — unrelated; tune heap / Lazy.

## Interactions

- **File size thresholds** (`data-file-minimum-size`, `data-file-maximum-size`) are
  per channel. 4 channels × 8 MiB max = up to 32 MiB of "head files" in flight.
- **Housekeeping** runs per channel. More channels = more parallel housekeeping.
  Good for throughput; be careful with total CPU if time-budget is high.
- **Backup** is serial across channels. More channels don't make backup faster.

## Benchmarking

If the user is deciding, have them:

1. Instrument with a timer around `store(...)`.
2. Run the workload with channelCount=1, record P50/P95/P99.
3. Rebuild the directory with channelCount=2 and re-run.
4. Repeat for 4 and 8.
5. Pick the lowest count that hits their SLA — lower is simpler.
