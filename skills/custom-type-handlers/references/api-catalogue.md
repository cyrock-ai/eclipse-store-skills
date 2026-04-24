# API catalogue — custom-type-handlers

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## `CustomBinaryHandler<T>`

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/CustomBinaryHandler.java`.

### Constructor helpers (static inner / imports)

```java
import static org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler.CustomField;
import static org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler.CustomFields;

super(MyClass.class, CustomFields(
    CustomField(int.class,    "i"),
    CustomField(String.class, "s")
));
```

### Methods (override)

| Method | Required | Notes |
|---|---|---|
| `void store(Binary data, T inst, long oid, PersistenceStoreHandler<Binary>)` | Yes | Write bytes. Use `data.storeReferences(...)` for pure-reference layouts, or `data.storeEntityHeader(totalBytes, typeId(), oid)` + `data.store_*` for primitives. |
| `T create(Binary data, PersistenceLoadHandler)` | Yes | Instantiate (empty or with primitives). |
| `void updateState(Binary data, T inst, PersistenceLoadHandler)` | Yes | Populate reference fields (usually via `XMemory`). |
| `boolean hasPersistedReferences()` | Yes | True if binary carries refs. |
| `boolean hasVaryingPersistedLengthInstances()` | Yes | False for fixed-size. |
| `void iterateLoadableReferences(Binary, PersistenceReferenceLoader)` | If refs | Report each referenced oid. |

### Accessors inherited

| Method | Purpose |
|---|---|
| `long typeId()` | The Type ID assigned by Eclipse Store. Pass to `storeEntityHeader` / `storeReferences`. |
| `Class<T> type()` | The class this handler handles. |

## `Binary`

File: `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/Binary.java`.

### Primitive reads / writes

| Method | Bytes |
|---|---|
| `store_byte(offset, byte)` / `read_byte(offset)` | 1 |
| `store_short(offset, short)` / `read_short(offset)` | 2 |
| `store_int(offset, int)` / `read_int(offset)` | 4 |
| `store_long(offset, long)` / `read_long(offset)` | 8 |
| `store_float(offset, float)` / `read_float(offset)` | 4 |
| `store_double(offset, double)` / `read_double(offset)` | 8 |
| `store_boolean(offset, boolean)` / `read_boolean(offset)` | 1 |
| `store_char(offset, char)` / `read_char(offset)` | 2 |

### Entity header / references

| Method | Purpose |
|---|---|
| `storeEntityHeader(long length, long typeId, long objectId)` | Write the 24-byte header required at the start of every entity record. Call this before any `store_*`. |
| `storeReferences(long typeId, long objectId, long headerOffset, PersistenceStoreHandler<Binary>, Object... refs)` | Convenience: writes header + N references. |
| `storeReferencesAsList(...)` | Variant for iterables. |

### Layout helpers

| Method | Returns |
|---|---|
| `static long objectIdByteLength()` | 8 (long). |
| `static long referenceBinaryLength(long referenceCount)` | Total bytes for N references. |
| `static long entityHeaderLength()` | 24. |

### Byte array

| Method | Purpose |
|---|---|
| `store_bytes(offset, byte[])` / `read_bytes_...` | Raw byte blocks; handlers typically avoid these, preferring primitive calls. |

## `PersistenceStoreHandler<Binary>`

During `store(...)`, this is how you reserve ids for referenced objects.
`storeReferences` handles it for you; for manual control:

```java
long ref = h.apply(instance.something());   // stores if new, returns oid
data.store_long(offset, ref);
```

## `PersistenceLoadHandler`

Inside `create` / `updateState`:

- `Object lookupObject(long oid)` — resolve an object id. Returns null for oid 0.

## `PersistenceReferenceLoader`

Passed to `iterateLoadableReferences`. Call:

```java
it.acceptObjectId(data.read_long(OFFSET_foo));
```

For every reference in the binary. The loader will then ensure those objects are
loaded before `updateState` runs.

## `XMemory`

File: `base/src/main/java/org/eclipse/serializer/memory/XMemory.java`.

Unsafe-backed direct field access:

| Method | Purpose |
|---|---|
| `objectFieldOffset(Class<?>, String fieldName)` | Byte offset of a field within an instance. |
| `setObject(Object target, long fieldOffset, Object value)` | Set a reference field. |
| `setLong(Object target, long fieldOffset, long value)` | Set a long field. |
| `setInt`, `setBoolean`, etc. | Similar for all primitives. |
| `getObject`, `getLong`, … | Read the other direction. |

Use when you need to populate final/private fields during load. Bypasses
constructors.

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

## Field declaration summary

```java
super(
    MyClass.class,
    CustomFields(
        CustomField(Type1.class, "fieldName1"),
        CustomField(Type2.class, "fieldName2")
    )
);
```

- Order matters: declaration order must match binary offset order.
- The names are the Java field names — used by legacy type mapping for matching.
- Fields of primitive type use `int.class`, `long.class`, etc.
