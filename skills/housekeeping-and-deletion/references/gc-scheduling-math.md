# Housekeeping scheduling math

## The two knobs

| Property | Meaning |
|---|---|
| `housekeeping-interval` | How often a cycle starts. Default 1 s. |
| `housekeeping-time-budget` | How much wall time one cycle is allowed. Default 10 ms. |

CPU budget ratio = `budget / interval`. Default: `10 ms / 1 s = 1%`.

## Worked examples

### Small app (default)

- Interval 1 s, budget 10 ms → 1% CPU spent on housekeeping (when work exists).
- GC of 1 M small objects ≈ 1-2 s of sustained work.
- With 1% CPU ratio, that's 100-200 s of wall time before GC catches up.

Fine for idle or low-churn systems.

### Heavy writer

- 10,000 writes/s creates ~10 MB/s of file churn.
- Default 1% budget can't compact that fast — gaps accumulate; disk grows.
- Raise budget to 100 ms: 10% CPU ratio. GC now keeps pace with writes.
- Alternatively enable adaptive housekeeping:

```ini
housekeeping-adaptive = true
housekeeping-maximum-time-budget = 500ms
housekeeping-increase-amount = 50ms
housekeeping-increase-threshold = 5s
```

### Batch ingest, quiet rest of the time

- Ingest runs for 30 s/hour producing 1 GB of writes.
- Rest of the hour is idle; daemon has time to compact.
- Keep the budget small (10-20 ms); housekeeping catches up between ingests.

### Never-compact mode

- Interval 1 s, budget 1 ns (effectively none).
- "One item of work is always done" — housekeeping trickles, never keeps up.
- **Do not do this.** If you want to defer cleanup, use a maintenance window and
  trigger manually with a big budget:

```java
storage.issueGarbageCollection(Duration.ofMinutes(5).toNanos());
storage.issueFileCheck(Duration.ofMinutes(5).toNanos());
```

## Adaptive controller behaviour

With `housekeeping-adaptive = true`:

1. Each cycle, the controller checks if GC is falling behind (still has uncollected
   work).
2. If behind for `housekeeping-increase-threshold` (default 5 s), budget increases by
   `housekeeping-increase-amount` (default 50 ms).
3. Increases continue until `housekeeping-maximum-time-budget` (default 500 ms).
4. When caught up, budget decays back over time (details depend on the controller
   implementation — inspect the source for exact behaviour).

Adaptive is usually the right choice over hand-tuning.

## Observability

Eclipse Store does not emit built-in metrics for housekeeping. If you need
observability:

- Wrap manual `issueGarbageCollection(budget)` calls with timing logs.
- Poll disk usage periodically (filesystem `du` or `Files.size` walk).
- Check data-file counts per channel: a rising count ≈ housekeeping behind.

## Rule of thumb

| Write rate | Recommended budget |
|---|---|
| < 100 ops/s | `10ms` (default) |
| 100-1000 ops/s | `50ms`, enable adaptive |
| > 1000 ops/s | `100ms`+, adaptive, `maximum-time-budget = 500ms` |
| Ingest bursts | Keep small budget; trigger manual GC between ingests |
