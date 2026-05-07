# Performance tuning — serializer-standalone

## Wins on the table

Eclipse Serializer is fast out of the box. These tweaks matter for high-volume
workloads but are almost never necessary for typical apps.

## Pre-register entity types

Unregistered types cause the serializer to add them to the dictionary on first
encounter. Pre-registration avoids that overhead and stabilizes Type IDs.

```java
SerializerFoundation.New().registerEntityTypes(A.class, B.class, C.class);
```

## Pool serializers per thread

`Serializer` is not thread-safe but is cheap to construct. One per thread via
`ThreadLocal` avoids per-call construction.

```java
private static final ThreadLocal<Serializer<byte[]>> SER = ThreadLocal.withInitial(
    () -> Serializer.Bytes(FOUNDATION)
);
```

## Prefer `Serializer` over `TypedSerializer` when possible

The type-dictionary overhead in `TypedSerializer` is real — use it only when peers
cannot agree on registrations. For same-deployment, same-version peers, use
`Serializer`.

## If using `TypedSerializer`, pick the right strategy

For long-lived streams (event bus):

- `IncrementalDiff(true)` — near-zero overhead after warmup.

For request/response with mixed schemas:

- `Diff(true)` — balances.

For truly open-world:

- `TypeDictionary(false)` — largest output, most flexible.

## Avoid wide interfaces at the top of your graphs

Serializer reflects fields. A class declared as `Object field` forces extra type
info every time. Prefer concrete types (`ArrayList<Customer>` over `List<Customer>`)
for hot serialization targets.

## Use concrete collection types, not interfaces

Eclipse Serializer has specialized handlers for JDK collection types. Declaring
`List<X>` means the serializer records the concrete class each time. Using
`ArrayList<X>` is faster (specialized handler, no concrete-class byte).

## Keep records small

Records are handled as entities. A record with 20 fields serializes slower than
a class with a compact binary layout. For truly hot paths, write a custom type
handler.

## Memory: skip the `byte[]` copy with the `Binary` medium

`Serializer.Binary()` (and `TypedSerializer.Binary()`) returns a `Binary` instead
of a `byte[]`. `Binary.buffers()` exposes the underlying `ByteBuffer[]` chunks
directly, avoiding the extra heap allocation that `Bytes()` performs to flatten
into a single `byte[]`.

```java
Serializer<Binary> ser = Serializer.Binary();
Binary out = ser.serialize(obj);
for (ByteBuffer chunk : out.buffers()) {
    channel.write(chunk);
}
```

For arbitrary destination types, plug a custom adapter via
`Serializer.New(toMedium, toBinary)` — the standalone serializer ships no
`ByteBuffer`-typed factory of its own.

## Benchmark realistically

- Don't micro-benchmark with 100 `serialize(singleInt)` — JIT, GC, allocation
  costs dominate.
- Use JMH with your real payloads.
- Compare against the alternative you'd actually use (Kryo, Java serialization,
  protobuf).

## When to escalate to custom handlers

If profiling shows your hottest class is the bottleneck:

1. Check if it's reflective (default handler) vs. specialized.
2. If reflective and you can afford the maintenance, write a
   `CustomBinaryHandler<T>` — often cuts per-instance time by 50-80%.

See `custom-type-handlers` for the API.

## Common non-wins

- "Zero-copy" for arbitrary graphs: serialization must produce a compact byte
  form. The best you can do is `ByteBuffer`-based reuse; true zero-copy requires
  a wire-format designed for it (flatbuffers, cap'n proto) — Eclipse Serializer
  is not one of those.
- "Async" serialization: the library is synchronous. Don't try to offload per-
  call; move the call itself to a background thread if needed.
