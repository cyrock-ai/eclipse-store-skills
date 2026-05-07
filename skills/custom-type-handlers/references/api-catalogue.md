# API catalogue — custom-type-handlers

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `CustomBinaryHandler<T>`

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/CustomBinaryHandler.java`.

The framework collects `BinaryField<T>` instance fields by reflection (in
declaration order) and uses them to auto-generate the binary layout.

### Constructors

| Constructor | Notes |
|---|---|
| `super(Class<T>)` | Single-arg form. Recommended. The framework picks up `BinaryField` instance fields. |
| `super(Class<T>, PersistenceTypeInstantiator<Binary, T>)` | Optional instantiator that replaces overriding `create`. |

### Methods you commonly override

| Method | When | Purpose |
|---|---|---|
| `T create(Binary, PersistenceLoadHandler)` | Always (or supply an instantiator) | Construct a shell instance — empty, or with primitives read from `BinaryField.read_*`. |
| `void initializeState(Binary, T, PersistenceLoadHandler)` | Final-field types with references | Read references with `BinaryField.readReference` and set them on the instance (typically via `XMemory.setObject` or `XReflect.copyFields`). |

### Methods auto-generated — do **not** override

`store`, `updateState`, `iterateLoadableReferences`,
`hasPersistedReferences`, `hasVaryingPersistedLengthInstances`. They are derived
from the declared `BinaryField` instances. Override only by dropping down to
`AbstractBinaryHandlerCustom<T>`.

### `BinaryField<T>` factories (inherited static helpers)

Call these without a class prefix from inside the handler subclass.

| Factory | Use for | Read with |
|---|---|---|
| `Field(Class<R>, Getter<T, R>)` | Reference field, read-only | `binaryField.readReference(data, handler)` |
| `Field(Class<R>, Getter<T, R>, Setter<T, R>)` | Reference field, mutable — framework auto-sets | (auto in `updateState`) |
| `Field_byte(Getter_byte<T> [, Setter_byte<T>])` | `byte` | `read_byte(data)` |
| `Field_boolean(Getter_boolean<T> [, Setter_boolean<T>])` | `boolean` | `read_boolean(data)` |
| `Field_short(Getter_short<T> [, Setter_short<T>])` | `short` | `read_short(data)` |
| `Field_char(Getter_char<T> [, Setter_char<T>])` | `char` | `read_char(data)` |
| `Field_int(Getter_int<T> [, Setter_int<T>])` | `int` | `read_int(data)` |
| `Field_long(Getter_long<T> [, Setter_long<T>])` | `long` | `read_long(data)` |
| `Field_float(Getter_float<T> [, Setter_float<T>])` | `float` | `read_float(data)` |
| `Field_double(Getter_double<T> [, Setter_double<T>])` | `double` | `read_double(data)` |

The `Getter` / `Setter` interfaces live in `org.eclipse.serializer.reflect`.
Method references (`Money::amount`, `Point::x`) and lambdas both work.

### `BinaryField<T>` read methods

`File: persistence/binary/.../BinaryField.java`. Use inside `create` /
`initializeState`:

| Method | Returns |
|---|---|
| `read_byte(Binary)` / `read_boolean(Binary)` | primitive |
| `read_short(Binary)` / `read_char(Binary)` | primitive |
| `read_int(Binary)` / `read_long(Binary)` | primitive |
| `read_float(Binary)` / `read_double(Binary)` | primitive |
| `readReference(Binary, PersistenceLoadHandler)` | `Object` (resolved instance, or null for stored 0 id) |

### Inherited accessors

| Method | Purpose |
|---|---|
| `long typeId()` | The Type ID assigned by Eclipse Store. |
| `Class<T> type()` | The class this handler handles. |
| `static long getClassDeclaredFieldOffset(Class<?>, String)` | Offset for `XMemory.setObject`. Inherited from `AbstractBinaryHandlerCustom`. |

## `AbstractBinaryHandlerCustom<T>` (lower-level alternative)

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/AbstractBinaryHandlerCustom.java`.

Use directly only when the declarative `CustomBinaryHandler` does not fit (e.g.
a custom binary list layout). You then implement `store`, `create`,
`updateState`, `iterateLoadableReferences`, `hasPersistedReferences`, and
`hasVaryingPersistedLengthInstances` yourself, and declare members via
`super(MyType.class, CustomFields(CustomField(Type.class, "name"), ...))`. See
the upstream `OrderBinaryHandler` example.

## `Binary`

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/Binary.java`.

In the declarative `CustomBinaryHandler` style you rarely need `Binary` directly
— use `BinaryField.read_*` / `readReference`. The full `Binary` API (manual
`store_*` writes, `storeEntityHeader`, `storeReferences`) is documented in
`binary-offset-api.md` and is needed only for `AbstractBinaryHandlerCustom`-style
handlers.

## `PersistenceLoadHandler`

Inside `create` / `initializeState`:

- `Object lookupObject(long oid)` — resolve an object id directly. Returns null
  for oid 0. Usually you use `BinaryField.readReference(data, this)` instead,
  which calls `lookupObject` internally.

## `XMemory`

File: `base/src/main/java/org/eclipse/serializer/memory/XMemory.java`.

Unsafe-backed direct field access for populating final / private fields:

| Method | Purpose |
|---|---|
| `objectFieldOffset(Field)` | Byte offset of a field within an instance. |
| `setObject(Object target, long fieldOffset, Object value)` | Set a reference field. |
| `set_long(Object target, long fieldOffset, long value)` | Set a long field. |
| `set_int`, `set_boolean`, `set_byte`, `set_short`, `set_char`, `set_float`, `set_double` | Same shape for the other primitives. |
| `get_long(Object, long)`, `get_int(Object, long)`, … | Read the other direction. |

Inside a handler, prefer the inherited helper
`getClassDeclaredFieldOffset(Class<?>, String)` over `objectFieldOffset(Field)`.

## `XReflect`

File: `base/src/main/java/org/eclipse/serializer/reflect/XReflect.java`.

| Method | Purpose |
|---|---|
| `copyFields(from, to)` | Copy all fields from one instance to another. Useful in `initializeState` when the target type can only be initialized via constructor. |

## `SerializerFoundation` / `EmbeddedStorageFoundation`

Registration entry points:

```java
// Standalone
SerializerFoundation.New().registerCustomTypeHandler(h);

// Storage
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> cf.registerCustomTypeHandler(h));
```

Both throw if called after the foundation has been consumed.

## `BinaryLegacyTypeHandler.AbstractCustom<T>`

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/BinaryLegacyTypeHandler.java`.

Used to read **old** binaries when the layout has changed; pair with a current-
shape `CustomBinaryHandler`. Detailed in the `legacy-type-mapping` skill.
