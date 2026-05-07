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

You declare `BinaryField<T>` instance fields with the inherited `Field(...)` /
`Field_int(...)` etc. helpers, and the framework auto-generates the binary
layout, the `store` walk, the loadable-reference reporting, and the field-write
back during `updateState`. You override `create` to construct a shell instance
and, for final-field types, `initializeState` to populate references after the
graph is resolved.

Handlers are **stateless** — Eclipse Store may invoke them concurrently.

## Core API

From `org.eclipse.serializer.persistence.binary.types`:

| Symbol | Purpose |
|---|---|
| `CustomBinaryHandler<T>` | Base for "current shape" handlers. Declarative — declare `BinaryField<T>` instance fields and the framework auto-generates `store` / `updateState` / `iterateLoadableReferences`. |
| `AbstractBinaryHandlerCustom<T>` | Lower-level parent. Use only when you need full manual control of the binary layout — `CustomBinaryHandler` covers the typical case. |
| `BinaryLegacyTypeHandler.AbstractCustom<T>` | Base for legacy-read handlers (see `legacy-type-mapping`). |
| `BinaryField<T>` | A declarative field descriptor. Created via the inherited `Field(...)` / `Field_int(...)` / `Field_double(...)` etc. helpers. Read values via `.read_int(data)`, `.read_long(data)`, `.readReference(data, handler)`, etc. |
| `Binary` | The byte buffer; the framework reads / writes it for you. |
| `PersistenceLoadHandler` | Load-side context passed to your `create` / `initializeState`; `.lookupObject(id)` resolves ids. |
| `XMemory` | `sun.misc.Unsafe`-style direct field access for populating final/private fields. |
| `XReflect.copyFields(from, to)` | Helper to copy all fields from a constructed copy into a shell instance, when the target class can only be initialized via constructor. |

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

The framework collects `BinaryField<T>` instance fields by reflection, in their
declaration order, and uses them to auto-generate the binary layout.

| What you declare | Required | Purpose |
|---|---|---|
| Constructor calling `super(MyType.class)` | Yes | Single-arg form. The framework discovers fields via reflection. |
| `final BinaryField<T> ... = Field(...)` instance fields | Yes | One per persisted field, in layout order. |
| `T create(Binary, PersistenceLoadHandler)` | Yes | Construct a shell instance — empty or populated from constructor-friendly primitives. |
| `void initializeState(Binary, T, PersistenceLoadHandler)` | If references on a final-field type | Set reference fields manually (via `XMemory.setObject` or by reconstructing the instance and `XReflect.copyFields`). |

Auto-generated by the framework — do **not** override unless you know why:
`store`, `updateState`, `iterateLoadableReferences`, `hasPersistedReferences`,
`hasVaryingPersistedLengthInstances`. They are derived from the declared
`BinaryField` instances.

`BinaryField<T>` factories (inherited static helpers — call without prefix):

- `Field(Class<R>, Getter<T, R>)` — reference field of type `R`. Optional 3-arg
  form with `Setter<T, R>` for mutable fields; the framework then sets via the
  setter during `updateState` and you don't need `initializeState`.
- `Field_byte`, `Field_boolean`, `Field_short`, `Field_char`, `Field_int`,
  `Field_long`, `Field_float`, `Field_double` — primitive fields. Same 1-arg
  (getter only) and 2-arg (getter + setter) forms.

Reading inside `create` / `initializeState`:

- `binaryField.read_int(data)`, `read_long(data)`, `read_double(data)`, etc.
- `binaryField.readReference(data, handler)` — returns the resolved object (or
  null for a stored 0 id).

## Idiomatic patterns

### Pattern A — Handler for a type with two references

A `Money` class with final `BigDecimal amount` and `Currency currency`. Both are
references; the class has no setters, so populate fields in `initializeState`:

```java
public class MoneyHandler extends CustomBinaryHandler<Money> {

    final BinaryField<Money>
        amount   = Field(BigDecimal.class, Money::amount),
        currency = Field(Currency.class,   Money::currency);

    public MoneyHandler() {
        super(Money.class);
    }

    @Override
    public Money create(Binary data, PersistenceLoadHandler handler) {
        return new Money(null, null);   // shell — references set in initializeState
    }

    @Override
    public void initializeState(Binary data, Money inst, PersistenceLoadHandler handler) {
        XMemory.setObject(inst,
            getClassDeclaredFieldOffset(Money.class, "amount"),
            this.amount.readReference(data, handler));
        XMemory.setObject(inst,
            getClassDeclaredFieldOffset(Money.class, "currency"),
            this.currency.readReference(data, handler));
    }
}
```

Rules:

- `BinaryField` instance fields are collected by reflection, in declaration order.
- `create` returns a shell; the framework calls `initializeState` afterwards
  with all referenced objects already loaded.
- For mutable types pass a setter as `Field(BigDecimal.class, Money::amount,
  Money::setAmount)` and skip `initializeState` entirely.

### Pattern B — Handler with primitives

`Point(double x, double y)` is fully constructor-initializable:

```java
public class PointHandler extends CustomBinaryHandler<Point> {

    final BinaryField<Point>
        x = Field_double(Point::x),
        y = Field_double(Point::y);

    public PointHandler() {
        super(Point.class);
    }

    @Override
    public Point create(Binary data, PersistenceLoadHandler handler) {
        return new Point(this.x.read_double(data), this.y.read_double(data));
    }
}
```

For pure-primitive types whose constructor accepts the values, do all the work
in `create()` — `initializeState` isn't needed.

### Pattern C — Opaque third-party type via wrapping

Serialize a canonical representation (here a `String` zone id) and reconstruct
on load:

```java
public class ZoneIdHandler extends CustomBinaryHandler<ZoneId> {

    final BinaryField<ZoneId>
        id = Field(String.class, ZoneId::getId);

    public ZoneIdHandler() {
        super(ZoneId.class);
    }

    @Override
    public ZoneId create(Binary data, PersistenceLoadHandler handler) {
        String id = (String) this.id.readReference(data, handler);
        return id == null ? null : ZoneId.of(id);
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

### Anti-pattern 2 — No `BinaryField` declarations

```java
// WRONG
public class MoneyHandler extends CustomBinaryHandler<Money> {
    public MoneyHandler() { super(Money.class); }
    @Override public Money create(...) { return new Money(null, null); }
    // no BinaryField instance fields → nothing is read or written
}
```

The framework relies on the declared `BinaryField` instance fields. Without
them, the type dictionary is empty and round-trips lose data.

### Anti-pattern 3 — Overriding `store` / `updateState` / `iterateLoadableReferences`

```java
// WRONG (in declarative style)
@Override public void store(Binary data, Money inst, long oid,
                            PersistenceStoreHandler<Binary> h) { ... }
```

Those methods are auto-generated from the declared `BinaryField` instances. Override
only when you specifically want manual control — and then drop down to
`AbstractBinaryHandlerCustom<T>` instead of `CustomBinaryHandler<T>`.

### Anti-pattern 4 — Registering a handler twice

```java
// WRONG — second register overrides; first wins if they conflict (exact behaviour varies)
cf.registerCustomTypeHandler(new MoneyHandler());
cf.registerCustomTypeHandler(new AnotherMoneyHandler());
```

One handler per class. Pick one.

### Anti-pattern 5 — Registering after `.start()`

```java
// WRONG
var s = EmbeddedStorage.start(root, dir);
cf.registerCustomTypeHandler(...);  // too late
```

No public path exists for this; don't attempt it via reflection.

### Anti-pattern 6 — Subclassing a type that already has a specialized handler

If you subclass `ArrayList`, the specialized `ArrayList` handler does not apply.
You'll fall through to generic handling, which may not match your needs. Prefer
composition (as in `storing-data` best practices).

## Pitfalls & gotchas

1. **`BinaryField` declaration order is the binary layout.** Reordering the
   instance fields silently changes the format and breaks restarts.
2. **`XMemory.setObject` bypasses constructors.** Good for populating final
   fields; bad if the constructor had side effects (logging, registration). Run
   those side effects yourself in `create` or `initializeState`.
3. **`create` can read primitives but not references.** Reference targets are
   resolved between `create` and `initializeState`; calling `readReference` in
   `create` returns null. Read references in `initializeState` (or pass setters
   to `Field(...)` and let the framework handle it).
4. **Custom handlers and legacy type mapping interact.** If the old binary
   layout differs, you need a `BinaryLegacyTypeHandler.AbstractCustom<T>` (see
   `legacy-type-mapping`). Your current `CustomBinaryHandler` handles *new*
   writes; the legacy handler handles *old* reads.
5. **Don't serialize a DI container, thread pool, JDBC connection, or any live
   resource.** Handlers should deal with value data. Live resources must be
   re-acquired at load time (often by the class itself through `create`).
6. **Test with a real round-trip.** Serialize → deserialize → compare. If the
   class doesn't have `equals`, compare field by field.

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
single primitive field — one `BinaryField<T>` declaration plus `create` reading
that field via `binaryField.read_long(data)`. See Pattern B.

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

**"Are there built-in handlers to read for inspiration?"** → Yes —
`BinaryHandlerInetSocketAddress` in `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/java/net/`
is a production `CustomBinaryHandler` with the declarative `BinaryField` style.
For lower-level (manual `AbstractBinaryHandlerCustom`) handlers, see
`persistence/binary/.../internal/` (e.g. `BinaryHandlerString`,
`BinaryHandlerArrayList`).

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — `CustomBinaryHandler` factories, `BinaryField`
  read methods, `PersistenceLoadHandler`, registration entry points.
- `references/binary-offset-api.md` — manual offset / `Binary` API for
  `AbstractBinaryHandlerCustom`-style handlers.
- `references/examples-expanded.md` — full declarative handlers plus a JUnit
  round-trip test template.
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer and fix.

## Upstream sources

- `docs/modules/serializer/pages/custom-type-handlers.adoc` — main reference.
- `examples/custom-type-handler/` — runnable example.
- `examples/custom-legacy-type-handler/` — legacy variant.
- `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/CustomBinaryHandler.java`
  — the base class.
- `persistence/binary/src/main/java/org/eclipse/serializer/persistence/binary/types/Binary.java`
  — the binary buffer API.
