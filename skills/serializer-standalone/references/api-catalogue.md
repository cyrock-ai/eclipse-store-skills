# API catalogue — serializer-standalone

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `Serializer<T>`

File: `persistence/binary/src/main/java/org/eclipse/serializer/Serializer.java` (approx).

### Static factories

| Method | Output | Type info |
|---|---|---|
| `Serializer.Bytes()` | `byte[]` | No |
| `Serializer.Bytes(SerializerFoundation<?>)` | `byte[]` | No |
| `Serializer.ByteBuffer()` | `ByteBuffer` | No |
| `Serializer.ByteBuffer(SerializerFoundation<?>)` | `ByteBuffer` | No |
| `TypedSerializer.Bytes()` / `(foundation)` | `byte[]` | Yes |
| `TypedSerializer.ByteBuffer()` / `(foundation)` | `ByteBuffer` | Yes |

### Instance methods

| Method | Notes |
|---|---|
| `T serialize(Object)` | Returns the binary form. |
| `<X> X deserialize(T)` | Returns the deserialized graph. |
| `void close()` | Releases resources if implementation holds any. Often a no-op. |

### Thread safety

Not thread-safe. One instance per thread, or pool.

## `SerializerFoundation<?>`

### Creation

```java
SerializerFoundation.New();
```

### Methods

| Method | Purpose |
|---|---|
| `registerEntityTypes(Class<?>... classes)` | Register domain classes so their Type IDs are stable. |
| `registerCustomTypeHandler(CustomBinaryHandler<?>)` | Plug in a custom handler (see `custom-type-handlers`). |
| `setSerializerTypeInfoStrategyCreator(...)` | For `TypedSerializer`: choose type-info inclusion strategy. |
| `onConnectionFoundation(...)` | Lower-level hook for rarely-needed customization. |

Consumed by `Serializer.Bytes(foundation)` etc. Not reusable after creating a
serializer.

## Type-info inclusion strategies

`SerializerTypeInfoStrategyCreator` has three variants. Each accepts an
`includeTypeInfoOnce` flag.

| Strategy | Behaviour | Peer needs pre-registration |
|---|---|---|
| `TypeDictionary(boolean)` | Full dictionary every call (or once if flag). | No |
| `Diff(boolean)` | Dict = changes vs. initial. | Yes (initial types) |
| `IncrementalDiff(boolean)` | Dict = changes added during current call. | Yes (initial types) |

`includeTypeInfoOnce = true` means: send dict only when the current call adds a new
type to the serializer's known set. Useful for long streams with stable schema.

## Supported out-of-the-box types

- Primitives and wrappers.
- `String`, `BigInteger`, `BigDecimal`.
- `java.time.*`.
- `Optional`.
- Arrays (including multi-dim).
- Collections: `ArrayList`, `HashMap`, `HashSet`, `LinkedList`, `LinkedHashMap`,
  `LinkedHashSet`, `TreeMap`, `TreeSet`, and more.
- Enums.
- Records.
- Arbitrary POJOs via reflection.

## Custom handlers

Same API as storage. See `custom-type-handlers` SKILL.md. Register on the
foundation:

```java
SerializerFoundation.New().registerCustomTypeHandler(new MoneyHandler());
```

## Stream / file variants

For larger graphs or persistence-grade use cases, Eclipse Serializer ships with
file/stream-oriented variants not detailed here. Consult the storage skills if
persistence is the goal; for RPC transport, `Serializer.Bytes(...)` covers nearly
every case.

## Typical round-trip cost

In-memory, same JVM: microseconds for small POJOs, milliseconds for large graphs.
Much faster than Java serialization; comparable to Kryo. Profile your workload.
