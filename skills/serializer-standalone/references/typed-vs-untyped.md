# Typed vs. untyped Serializer — decision guide

## Default `Serializer` (no type info)

- Output: compact.
- Peer must know the types in advance (via the same `SerializerFoundation`
  registrations).
- Fastest; smallest on the wire.

Use when:

- Both peers are in the same deployment, same version, same classes.
- You own both ends.
- Throughput / size matters.

## `TypedSerializer` (self-describing)

- Output: includes a type dictionary segment.
- Peer can deserialize without pre-registration.
- Larger output; slightly slower.

Use when:

- Open-world messaging (pluggable subscribers).
- Versions drift between peers.
- You cannot guarantee shared registrations.

## Strategy trade-offs (TypedSerializer)

| Strategy | First call | Subsequent calls (same types) | Peer needs |
|---|---|---|---|
| `TypeDictionary(false)` | Full dict | Full dict | Nothing |
| `TypeDictionary(true)` | Full dict | No dict | Initial dict |
| `Diff(false)` | Diff vs. initial | Diff vs. initial | Initial dict |
| `Diff(true)` | Diff (on new types) | Only when new types | Initial dict |
| `IncrementalDiff(false)` | New types only | New types only | Initial dict + ordered stream |
| `IncrementalDiff(true)` | New types only (when present) | (rare) | Initial dict + ordered stream |

## Examples

### Single-shot RPC, peers aligned

`Serializer.Bytes(sf)` with both peers pre-registering the same classes.

### Pluggable gateway

`TypedSerializer.Bytes()` with `TypeDictionary(false)` — maximum flexibility.

### High-throughput event bus

- Pre-register base types on all peers.
- Use `TypedSerializer.Bytes(sf)` with `Diff(true)` — type info only when a new
  type appears; consumers fall back to initial registration otherwise.

### Stable stream with occasional new types

- `IncrementalDiff(true)` — smallest incremental cost.

## Size-vs-flexibility gut feel

- `Serializer` (no types) ≈ 100% baseline
- `TypedSerializer` `IncrementalDiff(true)` ≈ 101-110% baseline (after warmup)
- `TypedSerializer` `Diff(false)` ≈ 120-150% baseline
- `TypedSerializer` `TypeDictionary(false)` ≈ 200-400% baseline depending on
  schema size

Profile with realistic payloads; these are rough orders.

## Mixed peers (deserializer chooses)

If one peer uses `Serializer` and another `TypedSerializer`, they are
**incompatible** — the bit layouts differ. Decide on one per channel.
