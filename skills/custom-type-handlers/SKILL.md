---
name: custom-type-handlers
description: >
  Guide Claude on writing and registering custom binary type handlers for Eclipse
  Store / Eclipse Serializer — `CustomBinaryHandler<T>` for current-shape types,
  `BinaryLegacyTypeHandler.AbstractCustom<T>` for legacy reads, the `Binary` API for
  reading/writing fields at byte offsets. Use this skill when the user asks to
  "write a custom type handler", "serialize third-party type", "control binary
  layout", "CustomBinaryHandler", "BinaryHandler", "registerCustomTypeHandler",
  "XMemory", "PersistenceStoreHandler", "PersistenceLoadHandler", or needs to
  serialize a class Eclipse Store does not natively support (e.g., native handles,
  opaque third-party objects, types with computed fields).
version: 0.1.0
---

# Eclipse Store — Custom Type Handlers

Eclipse Store handles standard JDK types (primitives, strings, collections) and
arbitrary POJOs via reflection. For types it cannot serialize (native resources,
third-party objects with hidden state, performance-critical types, or types with
computed fields), write a custom binary type handler.

## When to use this skill

- Third-party type throws during serialization (reflection can't reach its fields
  cleanly).
- User needs exact control over the on-disk binary layout of a class.
- User needs special create-time logic (e.g., register a native resource at load).
- Computed/derived fields need to be skipped or recomputed.
- Performance-sensitive hot type where reflection is too slow.

**Route elsewhere** when:

- User wants to evolve schema for an existing class → `legacy-type-mapping`.
- User just needs a field stored differently → prefer composition/different POJO
  shape; custom handlers are a last resort.
- User wants to use the Serializer without storage → `serializer-standalone` (same
  handler API, different foundation).

## Mental model

A type handler is a bidirectional translator between a Java instance and a binary
byte stream. Eclipse Store registers one handler per class. Default handlers are
auto-generated via reflection; `CustomBinaryHandler<T>` lets you override the
default for a specific class.

Store side: you receive a `Binary` buffer and an instance, and write bytes.
Load side: you receive a `Binary` buffer, instantiate an empty object (`create`),
and then populate its fields (`updateState`).

Handlers are **stateless** — Eclipse Store may invoke them concurrently.

## Core API

From `org.eclipse.serializer.persistence.binary.types`:

| Symbol | Purpose |
|---|---|
| `CustomBinaryHandler<T>` | Base for "current shape" handlers. |
| `BinaryLegacyTypeHandler.AbstractCustom<T>` | Base for legacy-read handlers (see `legacy-type-mapping`). |
| `Binary` | The byte buffer; has `store_*`, `read_*`, `storeReferences(...)`. |
| `PersistenceStoreHandler<Binary>` | Store-side context; resolves object → id. |
| `PersistenceLoadHandler` | Load-side context; `.lookupObject(id)` resolves ids to instances. |
| `PersistenceReferenceLoader` | Discovery callback — tell the loader which object ids your binary references. |
| `XMemory` | `sun.misc.Unsafe`-style direct field access (for writing final fields during load). |
| `CustomFields(CustomField...)` / `CustomField(Class<?>, String)` | Declare field metadata in the handler constructor. |

Registration is on a foundation (serializer or embedded storage):

```java
// Standalone serializer
SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerCustomTypeHandler(new MoneyHandler());

// Embedded storage
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> cf.registerCustomTypeHandler(new MoneyHandler()))
    .start(root);
```

**Must register before the foundation builds the manager/serializer.**

## Subclass contract (`CustomBinaryHandler<T>`)

| Method | Required | Purpose |
|---|---|---|
| Constructor calling `super(Class<T>, CustomFields(...))` | Yes | Declare type and field metadata. |
| `store(Binary data, T instance, long objectId, PersistenceStoreHandler<Binary>)` | Yes | Write binary. |
| `T create(Binary data, PersistenceLoadHandler)` | Yes | Construct an empty instance. |
| `void updateState(Binary data, T instance, PersistenceLoadHandler)` | Yes | Populate fields from binary. |
| `boolean hasPersistedReferences()` | Often | True if the binary contains object references. |
| `boolean hasVaryingPersistedLengthInstances()` | Often | False for fixed-layout types. |
| `void iterateLoadableReferences(Binary, PersistenceReferenceLoader)` | If `hasPersistedReferences()` | Report referenced object ids. |

Store-side helpers on `Binary`:

- `storeReferences(typeId, objectId, headerOffset, handler, ref1, ref2, ...)` — common case.
- `store_byte/short/int/long/float/double/boolean(offset, value)` — primitives.
- `storeLong_*` variants — raw writes.

Load-side helpers:

- `read_byte/short/int/long/float/double/boolean(offset)`.
- `read_long(offset)` then `handler.lookupObject(id)` — resolve a reference.

Binary offset helpers:

- `Binary.objectIdByteLength()` → 8 (a long).
- `Binary.referenceBinaryLength(n)` → total bytes for n object references.

## Idiomatic patterns

### Pattern A — Handler for a type with two references

A `Money` class with `BigDecimal amount` and `Currency currency`. Both are
objects, so references only:

```java
public class MoneyHandler extends CustomBinaryHandler<Money> {

    private static final long
        OFFSET_amount   = 0,
        OFFSET_currency = Binary.referenceBinaryLength(1);

    public MoneyHandler() {
        super(
            Money.class,
            CustomFields(
                CustomField(BigDecimal.class, "amount"),
                CustomField(Currency.class,   "currency")
            )
        );
    }

    @Override
    public void store(Binary data, Money inst, long oid,
                      PersistenceStoreHandler<Binary> h) {
        data.storeReferences(
            this.typeId(),
            oid,
            0,
            h,
            inst.amount(),
            inst.currency()
        );
    }

    @Override
    public Money create(Binary data, PersistenceLoadHandler lh) {
        return new Money(null, null);
    }

    @Override
    public void updateState(Binary data, Money inst, PersistenceLoadHandler lh) {
        BigDecimal amount   = (BigDecimal) lh.lookupObject(data.read_long(OFFSET_amount));
        Currency   currency = (Currency)   lh.lookupObject(data.read_long(OFFSET_currency));

        XMemory.setObject(inst, XMemory.objectFieldOffset(Money.class, "amount"),   amount);
        XMemory.setObject(inst, XMemory.objectFieldOffset(Money.class, "currency"), currency);
    }

    @Override public boolean hasPersistedReferences()             { return true; }
    @Override public boolean hasVaryingPersistedLengthInstances() { return false; }

    @Override
    public void iterateLoadableReferences(Binary data, PersistenceReferenceLoader it) {
        it.acceptObjectId(data.read_long(OFFSET_amount));
        it.acceptObjectId(data.read_long(OFFSET_currency));
    }
}
```

Rules:

- **Store via `storeReferences`** when every field is a reference (common case).
- Use `XMemory.setObject` / `XMemory.setLong` to populate final or private fields.
- `create` returns a shell; `updateState` populates.

### Pattern B — Handler with primitives

`Point(double x, double y)` has only primitives:

```java
public class PointHandler extends CustomBinaryHandler<Point> {

    private static final long
        OFF_x = 0,
        OFF_y = Long.BYTES;   // double is 8 bytes

    public PointHandler() {
        super(
            Point.class,
            CustomFields(
                CustomField(double.class, "x"),
                CustomField(double.class, "y")
            )
        );
    }

    @Override
    public void store(Binary data, Point inst, long oid,
                      PersistenceStoreHandler<Binary> h) {
        long total = Long.BYTES * 2;
        data.storeEntityHeader(total, this.typeId(), oid);
        data.store_double(OFF_x, inst.x());
        data.store_double(OFF_y, inst.y());
    }

    @Override
    public Point create(Binary data, PersistenceLoadHandler lh) {
        return new Point(
            data.read_double(OFF_x),
            data.read_double(OFF_y)
        );
    }

    @Override public void updateState(Binary d, Point i, PersistenceLoadHandler lh) { }
    @Override public boolean hasPersistedReferences()             { return false; }
    @Override public boolean hasVaryingPersistedLengthInstances() { return false; }
}
```

Primitive-only handlers can do all the work in `create()` and leave
`updateState` empty.

### Pattern C — Opaque third-party type via wrapping

Sometimes the cleanest handler is to serialize a canonical representation and
re-parse on load:

```java
public class ZoneIdHandler extends CustomBinaryHandler<ZoneId> {
    // Binary = ref to a String (the zone id)
    private static final long OFFSET_id = 0;

    public ZoneIdHandler() {
        super(
            ZoneId.class,
            CustomFields(CustomField(String.class, "id"))
        );
    }

    @Override
    public void store(Binary data, ZoneId inst, long oid,
                      PersistenceStoreHandler<Binary> h) {
        data.storeReferences(this.typeId(), oid, 0, h, inst.getId());
    }

    @Override
    public ZoneId create(Binary data, PersistenceLoadHandler lh) {
        String id = (String) lh.lookupObject(data.read_long(OFFSET_id));
        return id == null ? null : ZoneId.of(id);
    }

    @Override public void updateState(Binary d, ZoneId i, PersistenceLoadHandler lh) { }
    @Override public boolean hasPersistedReferences()             { return true; }
    @Override public boolean hasVaryingPersistedLengthInstances() { return false; }
    @Override public void iterateLoadableReferences(Binary d, PersistenceReferenceLoader it) {
        it.acceptObjectId(d.read_long(OFFSET_id));
    }
}
```

Pros: trivial to write, portable.
Cons: slightly larger binary (the zone-id string) than a hand-packed byte form.

### Pattern D — Register on a storage foundation

```java
EmbeddedStorageManager storage = EmbeddedStorage.Foundation(
        EmbeddedStorageConfiguration.Builder()
            .setStorageDirectory("data")
            .createConfiguration()
    )
    .onConnectionFoundation(cf -> {
        cf.registerCustomTypeHandler(new MoneyHandler());
        cf.registerCustomTypeHandler(new ZoneIdHandler());
        cf.registerCustomTypeHandler(new PointHandler());
    })
    .start(root);
```

All handlers must be registered **before** `start(root)`.

### Pattern E — Register on a standalone serializer

```java
SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerCustomTypeHandler(new MoneyHandler());
Serializer<byte[]> serializer = Serializer.Bytes(sf);

byte[] bytes = serializer.serialize(new Money(new BigDecimal("42.00"),
                                              Currency.getInstance("EUR")));
Money restored = serializer.deserialize(bytes);
```

See the `serializer-standalone` skill for more on this path.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Stateful handlers

```java
// WRONG
public class BadHandler extends CustomBinaryHandler<Foo> {
    private Foo lastStored;   // mutable state; concurrent invocations race
}
```

Handlers may be invoked concurrently. Keep them stateless; any per-call data must
live in the `Binary` / `PersistenceStoreHandler` / `PersistenceLoadHandler`.

### Anti-pattern 2 — Not declaring field metadata

```java
// WRONG
super(Money.class, CustomFields());   // empty — schema evolution can't reason about this
```

Even if you manually pack bytes, declare fields so `legacy-type-mapping` sees what
exists. Handlers without metadata are brittle on schema changes.

### Anti-pattern 3 — Forgetting `iterateLoadableReferences`

If `hasPersistedReferences() == true`, you **must** implement
`iterateLoadableReferences`. Otherwise the loader won't fetch referenced objects,
and you'll get nulls during `updateState`.

### Anti-pattern 4 — Inventing your own offsets without `Binary.referenceBinaryLength`

```java
// Fragile
private static final long OFFSET_currency = 4;
```

If reference size ever changes (or you target a platform where it does),
`Binary.referenceBinaryLength(n)` and `Binary.objectIdByteLength()` keep you
portable.

### Anti-pattern 5 — Registering a handler twice

```java
// WRONG — second register overrides; first wins if they conflict (exact behaviour varies)
cf.registerCustomTypeHandler(new MoneyHandler());
cf.registerCustomTypeHandler(new AnotherMoneyHandler());
```

One handler per class. Pick one.

### Anti-pattern 6 — Registering after `.start()`

```java
// WRONG
var s = EmbeddedStorage.start(root, dir);
cf.registerCustomTypeHandler(...);  // too late
```

No public path exists for this; don't attempt it via reflection.

### Anti-pattern 7 — Subclassing a type that already has a specialized handler

If you subclass `ArrayList`, the specialized `ArrayList` handler does not apply.
You'll fall through to generic handling, which may not match your needs. Prefer
composition (as in `storing-data` best practices).

## Pitfalls & gotchas

1. **Binary offsets must be consistent between `store` and `read`.** Mismatch = silent
   corruption. Test round-trips.
2. **`XMemory.setObject` bypasses constructors.** Good for populating final fields;
   bad if the constructor had side effects (logging, registration). Do those side
   effects yourself in `create`.
3. **`hasVaryingPersistedLengthInstances()` matters.** For fixed-size layouts return
   false; for variable (e.g., a byte array field whose length varies), return true.
   Getting this wrong causes "garbled" reads.
4. **`store_long` vs `storeLong_*`**: several variants. The `store_X` ones are
   offset-based; the raw `storeLong_*` are for appending without explicit offset.
   Most handlers use the offset-based forms.
5. **Custom handlers for primitive-only types can skip `updateState`.** Do the
   population in `create`.
6. **Custom handlers and legacy type mapping interact.** If the old binary layout
   differs, you need a `BinaryLegacyTypeHandler.AbstractCustom<T>` (see
   `legacy-type-mapping`). Your current `CustomBinaryHandler` handles *new* writes;
   the legacy handler handles *old* reads.
7. **Don't serialize a DI container, thread pool, JDBC connection, or any live
   resource.** Handlers should deal with value data. Live resources must be
   re-acquired at load time (often by the class itself through `create`).
8. **Test with a real round-trip.** Serialize → deserialize → compare. If the class
   doesn't have `equals`, compare field by field.

## Interactions with other skills

- **`serializer-standalone`** — same handler API, registered via `SerializerFoundation`
  instead of `EmbeddedStorageFoundation`.
- **`legacy-type-mapping`** — when you change a custom-handled type, write a
  `BinaryLegacyTypeHandler.AbstractCustom<T>` (or let the default legacy mechanism
  deal with it if the new layout is backward-compatible).
- **`getting-started`** — handler registration must happen on a foundation before
  `start()`.
- **`storing-data`** — eager field evaluator is a higher-level tool for "please
  cascade into this field" without writing a handler.

## Recipes

**"What's the smallest useful custom handler?"** → A handler for a class with a
single primitive field, using `storeEntityHeader` + `store_long` + `read_long` in
`create` (Pattern B simplified).

**"Do I need a handler for a record?"** → Usually no — Eclipse Store handles records
fine. Write one only if you want a different binary layout.

**"How do I handle nulls inside a handler?"** → For references, a stored object id
of `0` means null. `handler.lookupObject(0)` returns null. Your code must tolerate
that.

**"Can I call Java serialization inside a handler?"** → Yes, technically, but
you're defeating the point of Eclipse Store. Do it only as a migration step.

**"Can I version my handler?"** → Not directly. Version the class shape; Eclipse
Store uses Type IDs to distinguish stored versions. If the class changes, write a
legacy handler for the old shape.

**"How do I know if my handler is actually being used?"** → Log in the constructor
(registration), log in `store`/`create` at DEBUG. Or check the type dictionary: the
class will have your declared fields.

**"Are there built-in handlers to read for inspiration?"** → Yes — look in
`persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/internal/`
for handlers like `BinaryHandlerString`, `BinaryHandlerArrayList`, etc. They use a
lower-level API than `CustomBinaryHandler` but illustrate the patterns.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — every method on `CustomBinaryHandler`, `Binary`,
  `PersistenceStoreHandler`, `PersistenceLoadHandler`.
- `references/binary-offset-api.md` — offsets, lengths, endianness, layout
  utilities.
- `references/examples-expanded.md` — four full handlers plus a JUnit round-trip
  test template.
- `references/legacy-handler-migration.md` — going from `CustomBinaryHandler` to
  `BinaryLegacyTypeHandler.AbstractCustom` when the layout changes.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer and fix.

## Upstream sources

- `docs/modules/serializer/pages/custom-type-handlers.adoc` — main reference.
- `examples/custom-type-handler/` — runnable example.
- `examples/custom-legacy-type-handler/` — legacy variant.
- `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/CustomBinaryHandler.java`
  — the base class.
- `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/Binary.java`
  — the binary buffer API.
