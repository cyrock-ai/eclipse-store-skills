# Pitfalls deep-dive — custom-type-handlers

## 1. Stateful handler causing race conditions

**Reproducer.**

```java
public class BadHandler extends CustomBinaryHandler<Foo> {
    private long lastOid;
    @Override public void store(Binary data, Foo inst, long oid, ...) {
        lastOid = oid;   // RACE
        ...
    }
}
```

**Symptom.** Occasional wrong values, intermittent errors under load.

**Root cause.** Multiple threads can invoke the same handler simultaneously.

**Fix.** Keep handlers stateless. Any per-call data stays in method locals or the
`Binary` / `PersistenceStoreHandler`.

## 2. Offset mismatch between store and read

**Reproducer.**

```java
// store
data.store_long(0, ...);
data.store_int(8, ...);

// read
int i = data.read_int(4);   // wrong offset
```

**Symptom.** Garbled values at load time.

**Root cause.** Offsets don't match.

**Fix.** Define offsets as `static final` constants shared by both paths:

```java
private static final long OFF_long = 0, OFF_int = OFF_long + Long.BYTES;
```

## 3. Forgetting `iterateLoadableReferences`

**Reproducer.**

```java
@Override public boolean hasPersistedReferences() { return true; }
// no iterateLoadableReferences
```

**Symptom.** `updateState` sees nulls for referenced objects.

**Root cause.** The loader doesn't fetch referenced objects if you don't report
them.

**Fix.** Always implement `iterateLoadableReferences` when `hasPersistedReferences`
is true:

```java
@Override
public void iterateLoadableReferences(Binary data, PersistenceReferenceLoader it) {
    it.acceptObjectId(data.read_long(OFFSET_ref1));
    it.acceptObjectId(data.read_long(OFFSET_ref2));
}
```

## 4. Declaring `hasVaryingPersistedLengthInstances = false` but writing variable
sizes

**Reproducer.** A handler for a class with `byte[] data` declares fixed-length.
Storage reads past the end or underruns.

**Symptom.** Corrupted reads, random IndexOutOfBounds.

**Fix.** Return `true` for varying-length types, and include the length in your
binary layout:

```java
long len = inst.data().length;
long total = Long.BYTES + len;
data.storeEntityHeader(total, typeId(), oid);
data.store_long(0, len);
data.store_bytes(Long.BYTES, inst.data());
```

## 5. Registering the handler after `.start()`

**Reproducer.**

```java
var s = EmbeddedStorage.start(root, dir);
// no path to register here
```

**Root cause.** The connection foundation is consumed at `.start()`.

**Fix.** Use the foundation pattern:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> cf.registerCustomTypeHandler(h))
    .start(root);
```

## 6. Using `XMemory` on the wrong field

**Reproducer.**

```java
XMemory.setObject(inst, XMemory.objectFieldOffset(Money.class, "amnt"), amount);
//                                                             ^ typo
```

**Symptom.** `NoSuchFieldException` at startup.

**Root cause.** Field name must match the source.

**Fix.** Keep the handler's offset lookups next to the field declarations; test
round-trips.

## 7. Not handling null references

**Reproducer.**

```java
BigDecimal amount = (BigDecimal) lh.lookupObject(data.read_long(OFFSET_amount));
amount.add(BigDecimal.ONE);   // NPE if it was null
```

**Symptom.** NPE at load time after nulls were stored.

**Root cause.** `lookupObject(0)` returns null — that's how Eclipse Store encodes
null references.

**Fix.** Let downstream code decide; don't assume the reference is non-null.

## 8. Declaring no `CustomField`s

**Reproducer.**

```java
super(Money.class, CustomFields());
```

**Symptom.** Schema evolution can't reason about the type. Legacy type mapping
won't work.

**Fix.** Always declare fields. Even if you do custom byte-packing inside
`store`, declare the fields so Eclipse Store's dictionary knows the shape.

## 9. Registering two handlers for the same class

**Reproducer.**

```java
cf.registerCustomTypeHandler(new MoneyHandler());
cf.registerCustomTypeHandler(new MoneyHandlerV2());
```

**Symptom.** Undefined behaviour (one wins, which depends on registration order
and internals).

**Fix.** One handler per class. Delete the old; wrap any migration via a legacy
handler if needed.

## 10. Storing a live resource

**Reproducer.**

```java
public class MyObj {
    private transient Connection jdbc;
    private String        value;
}
// Handler includes jdbc field → NPE / invalid state on load
```

**Fix.** Don't serialize live resources. Mark them `transient` (Eclipse Store
respects that) or reacquire them in `create`/`updateState`.

## 11. Sub-classing a JDK collection and adding a handler

If you subclass `ArrayList` and then register a custom handler for your subclass,
the specialized `ArrayList` handling is bypassed entirely — which is expected.
But don't expect the JDK handler's optimizations to apply.

Prefer composition (see `storing-data` anti-pattern 6).

## 12. Copying the header constant wrong

```java
// WRONG
long total = Binary.objectIdByteLength() * 2;   // only the refs, not the header
data.storeEntityHeader(total, typeId(), oid);
```

The `storeEntityHeader` *length* parameter is the **payload** length (bytes after
the header), not including the 24-byte header itself. `storeEntityHeader` adds the
header.

**Fix.** Length = sum of all field sizes. For two references:
`Binary.referenceBinaryLength(2)` = 16.

## 13. Assuming `create` and `updateState` run on the same thread

They might, might not. Don't carry state between them via instance fields. Carry
it via the `Binary` buffer or fetch it fresh in each call.
