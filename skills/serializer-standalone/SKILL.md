---
name: serializer-standalone
description: >
  Guide Claude on using Eclipse Serializer without Eclipse Store — high-performance
  binary serialization of arbitrary Java object graphs for RPC payloads, file
  exports, cache values, or RPC messages. This skill should be used when the user
  asks to "use Serializer without storage", "serialize objects to bytes",
  "Serializer.Bytes", "TypedSerializer", "binary serialize an object",
  "SerializerFoundation", "registerEntityTypes", "serialize a complex graph",
  "include type info in serialized output", "send Java objects over the network",
  or needs a serializer that can replace Java serialization / Jackson for
  Java-to-Java transport.
version: 0.2.0
---

# Eclipse Serializer — Standalone Use (Without Storage)

Eclipse Serializer ships as a library you can use independently of Eclipse Store. It
turns arbitrary object graphs into a compact binary and back again. Compared to Java
serialization it is faster and does not need `Serializable`. Compared to JSON it is
smaller and preserves reference identity (including circular references) — which is
exactly what an RPC layer or a disk cache wants.

## Do NOT use this skill

- Using Eclipse Store — the storage skills (`storing-data`, `root-and-object-graph`,
  etc.) wrap this serializer; go directly to them.
- Needing custom handlers → `custom-type-handlers`.
- Persisting a long-lived database → Eclipse Store, not the standalone serializer.

## Mental model

`Serializer<T>` is a pair of `serialize(object) : T` / `deserialize(T) : Object`.
`T` is typically `byte[]`, but Eclipse Serializer also supports `ByteBuffer` and
file-stream variants.

Two flavours:

- **`Serializer`** — compact binary, **no type info in output**. Both peers must have
  the same class registrations. Smallest, fastest.
- **`TypedSerializer`** — self-describing: includes a type dictionary segment in the
  output. Peer does not need pre-registration. Larger, flexible.

Preserves reference identity: serialize two pointers to the same object, get one
object back on the other side, two pointers to it. Circular refs work naturally.

## Core API

Artifact:

```xml
<dependency>
  <groupId>org.eclipse.serializer</groupId>
  <artifactId>serializer</artifactId>
  <version>${eclipse-serializer.version}</version>
</dependency>
```

From `org.eclipse.serializer`:

| Symbol | Purpose |
|---|---|
| `Serializer.Bytes()` / `Serializer.Bytes(SerializerFoundation<?>)` | `byte[]` serializer, no type info in the wire format. |
| `Serializer.Binary()` / `Serializer.Binary(SerializerFoundation<?>)` | Off-heap `Binary` chunks medium (no extra `byte[]` copy). |
| `TypedSerializer.Bytes()` / `(foundation)` | Self-describing `byte[]` variant. |
| `TypedSerializer.Binary()` / `(foundation)` | Self-describing `Binary` variant. |
| `Serializer.New(SerializerFoundation<?>, toMedium, toBinary)` | Generic factory for arbitrary media (e.g. plug a `ByteBuffer` adapter yourself). |
| `SerializerFoundation.New()` | Start a new foundation. |
| `SerializerFoundation.New(String typeDictionaryString)` | Bootstrap with an existing type dictionary. |
| `foundation.registerEntityTypes(Class<?>... classes)` | Pre-register domain classes. |
| `foundation.registerEntityType(Class<?>)` | Single class, returns a boolean (added vs. already present). |
| `foundation.registerCustomTypeHandler(handler)` | Custom type handlers (see the sibling skill). Inherited from the underlying `PersistenceFoundation`. |
| `foundation.setSerializerTypeInfoStrategyCreator(...)` | For `TypedSerializer`: choose how much type info to include per serialize call. |

Instance methods on `Serializer<M>` (which `extends AutoCloseable`):

| Method | Returns | Notes |
|---|---|---|
| `M serialize(Object)` | `M` | Serialize one graph. |
| `<T> T deserialize(M)` | `T` | Deserialize; caller types the return via the assignment. |
| `String exportTypeDictionary()` | the dictionary text | Useful for diagnosing peer-vs-peer disagreement. |
| `void close() throws Exception` | — | Truncates the object registry and closes the persistence manager. Inherited from `AutoCloseable` — try-with-resources callers must declare `throws Exception` (or wrap in `assertDoesNotThrow` / a runtime rethrow). The default impl never actually throws. |

## Idiomatic patterns

### Pattern A — Quick start, default serializer

```java
import org.eclipse.serializer.Serializer;

Serializer<byte[]> ser = Serializer.Bytes();

byte[] bytes = ser.serialize("Hello World");
String back  = ser.deserialize(bytes);
```

For truly simple cases. Both ends must share the library + classes.

### Pattern B — Pre-register domain classes

For anything beyond primitives and strings, register your classes so the type
dictionary is stable:

```java
SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerEntityTypes(Customer.class, Order.class, Product.class);

Serializer<byte[]> ser = Serializer.Bytes(sf);
```

Why: consistent Type IDs between peers. If one peer serializes without registration
and the other deserializes without registration, the dictionary is implicit and the
peers might disagree.

### Pattern C — `TypedSerializer` for open-world messaging

When you don't know what classes will arrive (pluggable subscribers, agnostic
gateways):

```java
Serializer<byte[]> ser = TypedSerializer.Bytes();

byte[] bytes = ser.serialize(anyObject);
Object back  = ser.deserialize(bytes);   // Typed output includes the class info
```

The output is larger (type dictionary in-band) but the peer needs no
pre-registration.

### Pattern D — Tune type-info inclusion strategy

For a streaming scenario where the same types repeat, reduce overhead:

```java
SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerEntityTypes(Customer.class, Order.class)
    .setSerializerTypeInfoStrategyCreator(
        new SerializerTypeInfoStrategyCreator.Diff(true)   // only send changes; includeOnce=true
    );

Serializer<byte[]> ser = TypedSerializer.Bytes(sf);
```

Strategies:

| Strategy | Output size | Peer needs |
|---|---|---|
| `TypeDictionary(false)` (default) | Largest — full dict every call | Nothing pre-registered |
| `Diff(false)` | Medium — only changes vs. initial dict | Initial dict registered |
| `Diff(true)` | Smallest — changes only when present | Initial dict + stream awareness |
| `IncrementalDiff(true)` | Smallest for streaming after init | Initial dict + ordered stream |

`includeTypeInfoOnce = true` sends type info only when new types appear — good for
long-lived streams with stable schema.

### Pattern E — Round-trip test pattern

```java
@Test
void round_trip() {
    SerializerFoundation<?> sf = SerializerFoundation.New()
        .registerEntityTypes(Customer.class);

    Serializer<byte[]> ser = Serializer.Bytes(sf);

    Customer original = new Customer("alice@acme.com");
    byte[] bytes      = ser.serialize(original);
    Customer back     = ser.deserialize(bytes);

    assertEquals(original.email(), back.email());
}
```

### Pattern F — Circular references just work

```java
Customer c = new Customer();
Order    o = new Order();
c.orders().add(o);
o.setCustomer(c);              // cycle

byte[] bytes = ser.serialize(c);
Customer back = ser.deserialize(bytes);

assertSame(back, back.orders().get(0).customer());   // identity preserved
```

No special annotations, no `@JsonManagedReference` — it just works.

### Pattern G — Use inside a message queue / HTTP body

```java
// Producer
byte[] payload = ser.serialize(new Event(...));
queue.send(payload);

// Consumer
Event e = ser.deserialize(queue.receive());
```

Both sides should share the same `SerializerFoundation` setup (same registrations,
same strategy) to minimize overhead. If you can't guarantee that, use
`TypedSerializer`.

### Pattern H — Reusing a serializer

`Serializer<byte[]>` instances are reusable and safe for single-threaded use. For
concurrent workloads, pool them per thread or use `ThreadLocal<Serializer<byte[]>>`
— they are **not** thread-safe.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Different registrations on each peer

```java
// Producer
SerializerFoundation.New().registerEntityTypes(A.class, B.class);

// Consumer
SerializerFoundation.New().registerEntityTypes(A.class);   // missing B
```

**Symptom.** Deserialization throws or returns wrong objects.

**Fix.** Share the registration list. Or use `TypedSerializer` so the consumer
doesn't need pre-registration.

### Anti-pattern 2 — Serializing JVM-backed resources

```java
ser.serialize(threadPool);       // opens a can of worms
ser.serialize(jdbcConnection);   // same
```

**Symptom.** Errors or silently incorrect reconstitution.

**Fix.** Serialize data, not handles to live resources. Mark live resources
`transient` (honored) or exclude them via the type's shape.

### Anti-pattern 3 — Using default `Serializer` across processes

Two processes with different dependency versions, different classpaths → different
implicit type dictionaries.

**Symptom.** Works in dev, fails in prod with the weirdest errors.

**Fix.** `TypedSerializer` for cross-process work, or strict version alignment.

### Anti-pattern 4 — Mutating the object mid-serialize

```java
new Thread(() -> ser.serialize(graph)).start();
// Another thread mutates `graph`
```

**Symptom.** `ConcurrentModificationException` or garbled binaries.

**Fix.** Snapshot or lock while serializing. Same rule as storing to Eclipse Store.

### Anti-pattern 5 — Sharing a `Serializer` across threads without pooling

```java
Serializer<byte[]> ser = Serializer.Bytes();
// Thread A: ser.serialize(x)
// Thread B: ser.serialize(y)
```

**Symptom.** Rare corruption, hard-to-diagnose intermittent failures.

**Fix.** One `Serializer` per thread, or pool them.

## Pitfalls & gotchas

1. **Default `Serializer` is implicit-schema.** If sender and receiver disagree on
   classes, deserialization fails subtly. Register explicitly.
2. **`Serializer<M>` extends `AutoCloseable`** — wrap one-shot serializers in
   try-with-resources. `close()` truncates the internal object registry and
   releases the persistence manager.
3. **Records work.** Java 16+ `record` types are first-class. No ceremony.
4. **`Optional` works.** Serializes the presence/absence + contained value.
5. **Lambdas don't work.** Do not serialize `Runnable` / `Function` etc. They
   aren't data.
6. **Thread-safety: per-thread.** Pool instances; don't share concurrently.
7. **Third-party opaque types may need custom handlers.** If a type has
   `sun.misc`-dependent state or native handles, write a `CustomBinaryHandler<T>`
   (sibling skill).
8. **Binary format evolves.** Don't persist the bytes long-term **with default
   Serializer** if you plan to change classes — it has no schema header. For
   durable storage use Eclipse Store (which carries a type dictionary); for
   wire-format self-description use `TypedSerializer`.

## Interactions with other skills

- **`custom-type-handlers`** — same handler API as storage; register on
  `SerializerFoundation` instead of `EmbeddedStorageFoundation`.
- **`getting-started`** / Eclipse Store — storage uses this serializer
  internally. Skills apply inside storage too but storage wraps the lifecycle.
- **Not** interacting: legacy type mapping, housekeeping, GigaMap — those are
  storage-specific.

## Recipes

**"What's the fastest way to replace Java serialization?"** → `Serializer.Bytes()`
with your classes pre-registered. Faster; smaller; no `Serializable` marker
needed.

**"How do I send objects over HTTP?"** →

```java
byte[] body = ser.serialize(obj);
response.outputStream().write(body);
```

Set `Content-Type: application/octet-stream`.

**"Do I need to annotate anything?"** → No.

**"How do I handle nulls?"** → Allowed at any reference; `ser.serialize(null)`
and `ser.deserialize(bytes) == null` both work.

**"How big is the output?"** → For typical POJOs, similar to Kryo. Much smaller
than JSON, smaller than Java serialization.

**"Can I stream a huge graph?"** → The API is "serialize one object". For very
large graphs that don't fit in a single call, split into multiple serialize calls
with cross-references, or use the `Binary`-medium factory (`Serializer.Binary()`)
to consume the off-heap chunks without the extra `byte[]` copy. There is no
file-stream factory in the standalone serializer — for durable, schema-evolving
storage use Eclipse Store.

**"Can I use it as a cache value serializer?"** → Yes — that's JCache-over-
Eclipse-Serializer territory. See `cache-jcache` for the higher-level wrapper.

**"What happens when a class has changed between write and read?"** → With
default `Serializer`, probably a mismatch error. With `TypedSerializer`, the
type dictionary allows limited adaptation. For durable data with schema
evolution, use Eclipse Store (which has `legacy-type-mapping`).

**"How do I integrate with Spring MVC / Jakarta EE?"** → Write a message converter
/ provider: serialize in `writeTo`, deserialize in `readFrom`. Eclipse Serializer
has no built-in adapters.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a factory/method not in the
  in-line Core API — e.g. `Serializer.New(...)` for a custom medium, `Binary`
  medium specifics, the full `SerializerFoundation` method surface, or the
  six `SerializerTypeInfoStrategyCreator` variants (`TypeDictionary` /
  `Diff` / `IncrementalDiff`, each in `(false)` / `(true)` form).
- **Load `references/examples-expanded.md`** when you want a complete runnable
  template — default round-trip, registered types, circular references,
  `TypedSerializer` for an MQ, `Diff` strategy, per-thread pool via `ThreadLocal`,
  a mini RPC server/client, JCache value-serializer skeleton, JUnit round-trip.
- **Load `references/typed-vs-untyped.md`** when deciding between
  `Serializer.Bytes()` and `TypedSerializer.Bytes()` — wire-size, peer
  pre-registration cost, schema-evolution tolerance.
- **Load `references/performance-tuning.md`** when throughput or size matters —
  pre-registration, strategy choice, per-thread reuse, foundation options.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a serializer bug —
  cross-process schema disagreement, JVM-resource serialization, mid-serialize
  mutation, threading corruption.

## Upstream sources

- `docs/modules/serializer/pages/getting-started.adoc` — primary guide.
- `docs/modules/serializer/pages/typed-serializer.adoc` — self-describing variant.
- `docs/modules/serializer/pages/configuration.adoc` — foundation options.
- `docs/modules/serializer/pages/type-handling.adoc` — type dictionary mechanics.
- `docs/modules/serializer/pages/performance.adoc` — tuning.
