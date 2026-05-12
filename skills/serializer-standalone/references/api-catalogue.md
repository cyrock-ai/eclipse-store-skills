# API catalogue — serializer-standalone

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `Serializer<M>`

File: `serializer/serializer/src/main/java/org/eclipse/serializer/Serializer.java`.
The interface declares `extends AutoCloseable`.

### Static factories

| Method | Medium | Type info in wire |
|---|---|---|
| `Serializer.Bytes()` | `byte[]` | No |
| `Serializer.Bytes(SerializerFoundation<?>)` | `byte[]` | No |
| `Serializer.Binary()` | `Binary` (off-heap chunks) | No |
| `Serializer.Binary(SerializerFoundation<?>)` | `Binary` | No |
| `TypedSerializer.Bytes()` / `(foundation)` | `byte[]` | Yes |
| `TypedSerializer.Binary()` / `(foundation)` | `Binary` | Yes |
| `Serializer.New(toMedium, toBinary)` | custom `M` | No |
| `Serializer.New(foundation, toMedium, toBinary)` | custom `M` | No |
| `TypedSerializer.New(...)` | custom `M` | Yes |

There is no `ByteBuffer`-typed factory shipped; use `Binary()` (which exposes
`ByteBuffer[]` via `Binary.buffers()`) or supply a custom `Function<Binary, M>`
adapter through `Serializer.New(toMedium, toBinary)`.

### Instance methods

| Method | Notes |
|---|---|
| `M serialize(Object)` | Returns the encoded graph. Synchronized internally on `Default`. |
| `<T> T deserialize(M)` | Caller types the return via the assignment. |
| `String exportTypeDictionary()` | Diagnostic: the type dictionary the serializer currently knows. |
| `void close() throws Exception` | Inherited from `AutoCloseable` (the `Serializer` interface does NOT narrow the throws clause). Truncates the object registry and closes the persistence manager. The default impl never throws, but callers using try-with-resources must declare `throws Exception` (or wrap). |

### Thread safety

Not thread-safe across threads as a unit, even though `serialize`/`deserialize`/`close`
are synchronized — sharing one instance serialises everything onto the JVM monitor.
For concurrent workloads pool per thread.

## `SerializerFoundation<F>`

File: `serializer/serializer/src/main/java/org/eclipse/serializer/SerializerFoundation.java`.
Extends `BinaryPersistenceFoundation<F>`, so the full custom-handler / persistence
configuration surface is available.

### Creation

```java
SerializerFoundation.New();
SerializerFoundation.New(String typeDictionaryString);   // bootstrap with an existing dictionary
```

### Methods

| Method | Purpose |
|---|---|
| `registerEntityType(Class<?>)` | Register one class. Returns `true` if newly added. |
| `registerEntityTypes(Class<?>... classes)` | Bulk register; returns the foundation for chaining. |
| `registerEntityTypes(Iterable<Class<?>>)` | Iterable variant. |
| `registerCustomTypeHandler(PersistenceTypeHandler<...>)` | Plug a custom handler (see `custom-type-handlers`). Inherited. |
| `registerCustomTypeHandlers(...)` | Varargs / `Iterable` / `HashTable` bulk variants. Inherited. |
| `setSerializerTypeInfoStrategyCreator(...)` | For `TypedSerializer`: choose type-info inclusion strategy. |
| `setInitialTypeDictionary(String)` | Seed the dictionary from an exported text form. |
| `getSerializerTypeInfoStrategyCreator()` | Read the currently configured strategy creator. |

Note: there is **no** `onConnectionFoundation(...)` on `SerializerFoundation` — that
hook lives on `EmbeddedStorageFoundation`. Configure the serializer foundation
directly.

Consumed by `Serializer.Bytes(foundation)` etc. Not reusable after creating a
serializer (it gets configured into the persistence manager).

## Type-info inclusion strategies

File: `serializer/serializer/src/main/java/org/eclipse/serializer/SerializerTypeInfoStrategyCreator.java`.

`SerializerTypeInfoStrategyCreator` has three nested static implementations. Each
takes a single `boolean includeTypeInfoOnce` constructor arg.

| Strategy | What is included | Peer needs pre-registration |
|---|---|---|
| `TypeDictionary(false)` *(default)* | All types known to the serializer (including those registered at setup), every call. | No |
| `TypeDictionary(true)` | Same set, but only when the call introduces a new type. | Setup-time agreement only |
| `Diff(false)` | Types added since setup, every call. | Yes (initial types) |
| `Diff(true)` | Types added since setup, only when a new one appears. | Yes (initial types) |
| `IncrementalDiff(false)` | Types added in *this* call, every call. | Yes + ordered stream |
| `IncrementalDiff(true)` | Types added in *this* call, only when one is added. | Yes + ordered stream |

The default on `SerializerFoundation` is `TypeDictionary(false)` (see
`SerializerFoundation.Default.ensureSerializerTypeInfoStrategyCreator()`).

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
