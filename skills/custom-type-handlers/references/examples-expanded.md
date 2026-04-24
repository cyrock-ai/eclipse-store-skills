# Examples-expanded — custom-type-handlers

## Example 1 — `MoneyHandler` (two references)

```java
package app.handlers;

import java.math.BigDecimal;
import java.util.Currency;

import org.eclipse.serializer.memory.XMemory;
import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;
import org.eclipse.serializer.persistence.types.PersistenceReferenceLoader;
import org.eclipse.serializer.persistence.types.PersistenceStoreHandler;

import app.Money;

public class MoneyHandler extends CustomBinaryHandler<Money> {

    private static final long
        OFFSET_amount   = 0,
        OFFSET_currency = Binary.referenceBinaryLength(1);

    public MoneyHandler() {
        super(Money.class, CustomFields(
            CustomField(BigDecimal.class, "amount"),
            CustomField(Currency.class,   "currency")
        ));
    }

    @Override
    public void store(Binary data, Money inst, long oid, PersistenceStoreHandler<Binary> h) {
        data.storeReferences(this.typeId(), oid, 0, h,
            inst.amount(), inst.currency());
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

## Example 2 — `PointHandler` (pure primitives)

```java
package app.handlers;

import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;
import org.eclipse.serializer.persistence.types.PersistenceStoreHandler;

import app.Point;

public class PointHandler extends CustomBinaryHandler<Point> {

    private static final long
        OFFSET_x = 0,
        OFFSET_y = Double.BYTES,
        LENGTH   = Double.BYTES * 2;

    public PointHandler() {
        super(Point.class, CustomFields(
            CustomField(double.class, "x"),
            CustomField(double.class, "y")
        ));
    }

    @Override
    public void store(Binary data, Point inst, long oid, PersistenceStoreHandler<Binary> h) {
        data.storeEntityHeader(LENGTH, this.typeId(), oid);
        data.store_double(OFFSET_x, inst.x());
        data.store_double(OFFSET_y, inst.y());
    }

    @Override
    public Point create(Binary data, PersistenceLoadHandler lh) {
        return new Point(data.read_double(OFFSET_x), data.read_double(OFFSET_y));
    }

    @Override public void updateState(Binary d, Point i, PersistenceLoadHandler lh) {}
    @Override public boolean hasPersistedReferences()             { return false; }
    @Override public boolean hasVaryingPersistedLengthInstances() { return false; }
}
```

## Example 3 — Opaque type round-trip (`ZoneId`)

Uses a String reference for the canonical form:

```java
package app.handlers;

import java.time.ZoneId;

import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;
import org.eclipse.serializer.persistence.types.PersistenceReferenceLoader;
import org.eclipse.serializer.persistence.types.PersistenceStoreHandler;

public class ZoneIdHandler extends CustomBinaryHandler<ZoneId> {

    private static final long OFFSET_id = 0;

    public ZoneIdHandler() {
        super(ZoneId.class, CustomFields(CustomField(String.class, "id")));
    }

    @Override
    public void store(Binary data, ZoneId inst, long oid, PersistenceStoreHandler<Binary> h) {
        data.storeReferences(this.typeId(), oid, 0, h, inst.getId());
    }

    @Override
    public ZoneId create(Binary data, PersistenceLoadHandler lh) {
        String id = (String) lh.lookupObject(data.read_long(OFFSET_id));
        return id == null ? null : ZoneId.of(id);
    }

    @Override public void updateState(Binary d, ZoneId i, PersistenceLoadHandler lh) {}
    @Override public boolean hasPersistedReferences()             { return true; }
    @Override public boolean hasVaryingPersistedLengthInstances() { return false; }

    @Override
    public void iterateLoadableReferences(Binary data, PersistenceReferenceLoader it) {
        it.acceptObjectId(data.read_long(OFFSET_id));
    }
}
```

## Example 4 — Registration in storage foundation

```java
package app.bootstrap;

import org.eclipse.store.storage.embedded.configuration.types.EmbeddedStorageConfiguration;
import org.eclipse.store.storage.embedded.types.EmbeddedStorage;
import org.eclipse.store.storage.embedded.types.EmbeddedStorageManager;

import app.AppRoot;
import app.handlers.MoneyHandler;
import app.handlers.PointHandler;
import app.handlers.ZoneIdHandler;

public final class Bootstrap {
    public static EmbeddedStorageManager start(AppRoot root) {
        return EmbeddedStorage.Foundation(
                EmbeddedStorageConfiguration.Builder()
                    .setStorageDirectory("data")
                    .setChannelCount(2)
                    .createConfiguration()
            )
            .onConnectionFoundation(cf -> {
                cf.registerCustomTypeHandler(new MoneyHandler());
                cf.registerCustomTypeHandler(new PointHandler());
                cf.registerCustomTypeHandler(new ZoneIdHandler());
            })
            .start(root);
    }
    private Bootstrap() {}
}
```

## Example 5 — JUnit round-trip test

```java
package app.handlers;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.math.BigDecimal;
import java.util.Currency;

import org.eclipse.serializer.Serializer;
import org.eclipse.serializer.SerializerFoundation;
import org.junit.jupiter.api.Test;

import app.Money;

public class MoneyHandlerRoundTripTest {

    @Test
    void money_roundtrip() {
        SerializerFoundation<?> sf = SerializerFoundation.New()
            .registerCustomTypeHandler(new MoneyHandler());
        Serializer<byte[]> ser = Serializer.Bytes(sf);

        Money original = new Money(new BigDecimal("42.50"), Currency.getInstance("EUR"));
        byte[] bytes   = ser.serialize(original);
        Money  back    = ser.deserialize(bytes);

        assertEquals(original.amount(), back.amount());
        assertEquals(original.currency(), back.currency());
    }
}
```

## Example 6 — Schema evolution of a custom-handled type

When `Money` gains a `String country` field, you have two choices:

**Option A**: keep the custom handler, update it for the new shape, and add a
`BinaryLegacyTypeHandler.AbstractCustom<Money>` that reads the **old** two-field
layout. See `legacy-type-mapping`.

**Option B**: drop the custom handler, let Eclipse Store reflect the new shape,
and write a legacy handler only for the old custom-layout binaries.

Option A is typical for long-lived types. Option B works if your domain can
tolerate the transition.
