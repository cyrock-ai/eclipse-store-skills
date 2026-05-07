# Pitfalls deep-dive — custom-type-handlers

These pitfalls cover the declarative `CustomBinaryHandler` style. For pitfalls
that only apply to manual `AbstractBinaryHandlerCustom` (offset mismatches,
varying-length flag, header constants, etc.) see `binary-offset-api.md`.

## 1. Stateful handler causing race conditions

**Reproducer.**

```java
public class BadHandler extends CustomBinaryHandler<Foo> {
    private long lastOid;
    @Override public Foo create(Binary data, PersistenceLoadHandler h) {
        this.lastOid = ...;   // RACE — handler may run on multiple threads
        return new Foo();
    }
}
```

**Symptom.** Occasional wrong values, intermittent errors under load.

**Root cause.** Multiple threads can invoke the same handler simultaneously.

**Fix.** Keep handlers stateless. The only fields on a handler subclass should
be `final BinaryField<T>` instances. Per-call data lives in method locals or in
the framework-supplied `Binary` / `PersistenceLoadHandler`.

## 2. Reading references in `create`

**Reproducer.**

```java
@Override
public Money create(Binary data, PersistenceLoadHandler handler) {
    BigDecimal amount = (BigDecimal) this.amount.readReference(data, handler);
    return new Money(amount, null);   // amount is null — refs not yet resolved
}
```

**Symptom.** Reference fields are null at the end of `create`.

**Root cause.** The framework resolves referenced objects between `create` and
`initializeState`. During `create` the load handler returns null for any
reference id.

**Fix.** Read primitives in `create`; read references in `initializeState`.
Or pass a setter to `Field(...)` so the framework writes the reference for you
in `updateState` and you don't need `initializeState` at all.

## 3. Registering the handler after `.start()`

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

## 4. Wrong field name in `getClassDeclaredFieldOffset`

**Reproducer.**

```java
XMemory.setObject(inst, getClassDeclaredFieldOffset(Money.class, "amnt"), amount);
//                                                                ^ typo
```

**Symptom.** `NoSuchFieldException` at startup or first load.

**Root cause.** The field name must match the source.

**Fix.** Keep the offset lookups next to the `BinaryField` declarations; round-
trip tests catch this immediately.

## 5. Not handling null references

**Reproducer.**

```java
BigDecimal amount = (BigDecimal) this.amount.readReference(data, handler);
amount.add(BigDecimal.ONE);   // NPE if it was null
```

**Symptom.** NPE at load time after nulls were stored.

**Root cause.** A stored object id of 0 means null; `readReference` returns
null in that case.

**Fix.** Let downstream code decide; don't assume the reference is non-null.

## 6. No `BinaryField` declarations

**Reproducer.**

```java
public class MoneyHandler extends CustomBinaryHandler<Money> {
    public MoneyHandler() { super(Money.class); }
    @Override public Money create(...) { return new Money(null, null); }
    // no BinaryField fields → empty type dictionary
}
```

**Symptom.** Round-trips lose data; legacy type mapping has nothing to match
against.

**Fix.** Declare one `BinaryField<T>` instance field per persisted field, in
layout order.

## 7. Registering two handlers for the same class

**Reproducer.**

```java
cf.registerCustomTypeHandler(new MoneyHandler());
cf.registerCustomTypeHandler(new MoneyHandlerV2());
```

**Symptom.** Undefined behaviour (one wins, which depends on registration order
and internals).

**Fix.** One handler per class. Delete the old; wrap any migration via a legacy
handler if needed.

## 8. Storing a live resource

**Reproducer.**

```java
public class MyObj {
    private transient Connection jdbc;
    private String        value;
}
// Handler includes jdbc field → NPE / invalid state on load
```

**Fix.** Don't serialize live resources. Mark them `transient` (Eclipse Store
respects that) or reacquire them in `create` / `initializeState`.

## 9. Sub-classing a JDK collection and adding a handler

If you subclass `ArrayList` and then register a custom handler for your subclass,
the specialized `ArrayList` handling is bypassed entirely — which is expected.
But don't expect the JDK handler's optimizations to apply.

Prefer composition (see `storing-data` anti-pattern).

## 10. Reordering `BinaryField` declarations

**Reproducer.** A handler had `amount` then `currency`. A refactor swaps the
declaration order to `currency` then `amount`.

**Symptom.** New writes use the swapped layout. Existing data still reads the
fields by position — `amount` now points at the currency bytes and vice versa.
Casts blow up at load time.

**Root cause.** `BinaryField` declaration order *is* the binary layout.

**Fix.** Treat the order of `BinaryField` instance fields as part of the
on-disk format. If you must reorder, write a `BinaryLegacyTypeHandler.AbstractCustom<T>`
for the old layout (see `legacy-type-mapping`).
