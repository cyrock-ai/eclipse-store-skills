# Binary offset API — custom-type-handlers

This page covers the manual `Binary` API used by `AbstractBinaryHandlerCustom<T>`
subclasses. The declarative `CustomBinaryHandler<T>` style described in
`SKILL.md` does not need any of this — the framework computes offsets for you.
Read on only if you are subclassing `AbstractBinaryHandlerCustom` for a layout
the declarative style cannot express.

## Layout

Every stored entity begins with a 24-byte header:

| Bytes | Field |
|---|---|
| 0-7 | length (entity bytes including header) |
| 8-15 | type id |
| 16-23 | object id |

Your handler writes the payload starting at offset 0 **relative to its content** —
the header is managed internally by `storeEntityHeader` / `storeReferences`.

## Offset helpers

```java
Binary.objectIdByteLength();         // 8 — one reference
Binary.referenceBinaryLength(3);     // 24 — three references
Binary.entityHeaderLength();         // 24 — the header
```

For fixed layouts, compute offsets statically:

```java
private static final long
    OFFSET_ref1  = 0,
    OFFSET_ref2  = OFFSET_ref1 + Binary.objectIdByteLength(),
    OFFSET_ref3  = OFFSET_ref2 + Binary.objectIdByteLength(),
    OFFSET_prim1 = OFFSET_ref3 + Binary.objectIdByteLength(),
    OFFSET_prim2 = OFFSET_prim1 + Long.BYTES;
```

## Primitive sizes

Mirror Java sizes:

| Type | Bytes |
|---|---|
| `byte`, `boolean` | 1 |
| `short`, `char` | 2 |
| `int`, `float` | 4 |
| `long`, `double` | 8 |

## Writing a mixed layout

```java
@Override
public void store(Binary data, MyType inst, long oid, PersistenceStoreHandler<Binary> h) {
    long total = Binary.referenceBinaryLength(1) + Long.BYTES + Integer.BYTES;
    data.storeEntityHeader(total, this.typeId(), oid);

    // 1 reference at offset 0
    data.store_long(0, h.apply(inst.someRef()));

    // long at offset 8
    data.store_long(Binary.objectIdByteLength(), inst.someLong());

    // int at offset 16
    data.store_int(Binary.objectIdByteLength() + Long.BYTES, inst.someInt());
}
```

## Reading it back

```java
@Override
public MyType create(Binary data, PersistenceLoadHandler lh) {
    long refId = data.read_long(0);
    long lng   = data.read_long(Binary.objectIdByteLength());
    int  i     = data.read_int(Binary.objectIdByteLength() + Long.BYTES);
    return new MyType(null /* fill ref in updateState */, lng, i);
}

@Override
public void updateState(Binary data, MyType inst, PersistenceLoadHandler lh) {
    Object ref = lh.lookupObject(data.read_long(0));
    XMemory.setObject(inst, getClassDeclaredFieldOffset(MyType.class, "someRef"), ref);
}
```

## Endianness / portability

Eclipse Store writes in a platform-consistent binary format — you do not manage
endianness yourself. The `Binary` API hides it. Do not use `ByteBuffer.order(...)`
on these buffers directly.

## Variable-length binaries

Return `hasVaryingPersistedLengthInstances() = true` and compute the actual byte
total at store time:

```java
long byteArrayLen = inst.payload().length;
long total = Binary.referenceBinaryLength(1) + Long.BYTES + byteArrayLen;
data.storeEntityHeader(total, typeId(), oid);
data.store_long(0, h.apply(inst.header()));
data.store_long(Binary.objectIdByteLength(), byteArrayLen);
data.store_bytes(inst.payload(), Binary.objectIdByteLength() + Long.BYTES);
```

On read, you read the length first, then the payload:

```java
long len = data.read_long(Binary.objectIdByteLength());
byte[] payload = data.read_bytes(Binary.objectIdByteLength() + Long.BYTES, (int) len);
```

(Exact method names for byte-array reads vary; inspect `Binary.java` and JDK
built-in handlers for a complete example.)

## References vs. inlined primitives

- **References** are object ids (8 bytes), resolved by the load handler at load
  time.
- **Inlined primitives** are the values themselves.

Resist the temptation to inline a string as char[] — use a String reference; that
lets the StringHandler's internal interning work.

## Common layout template

For a type with K references and L primitives:

```java
// Constants
private static final long
    OFFSET_ref_0   = 0,
    OFFSET_ref_K   = Binary.referenceBinaryLength(K),    // first primitive here
    OFFSET_prim_0  = OFFSET_ref_K,
    // etc.
    TOTAL_LENGTH   = OFFSET_prim_L_last + SIZE_prim_L_last;
```

Store:

```java
data.storeEntityHeader(TOTAL_LENGTH, this.typeId(), oid);
// write refs
for (int i = 0; i < K; i++) {
    data.store_long(Binary.referenceBinaryLength(i), h.apply(refs[i]));
}
// write primitives
data.store_int(OFFSET_prim_0, prim0);
// …
```

## Debugging tips

- If reads return garbage, the most likely cause is offset mismatch between
  store/read paths. Print offsets and total length on both sides.
- If object references come back null, you probably forgot
  `iterateLoadableReferences`.
- If the binary grows unexpectedly, check that `hasVaryingPersistedLengthInstances`
  matches reality.
