# Examples-expanded — custom-type-handlers

## Example 1 — `MoneyHandler` (two references, final fields)

```java
package app.handlers;

import java.math.BigDecimal;
import java.util.Currency;

import org.eclipse.serializer.memory.XMemory;
import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.BinaryField;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;

import app.Money;

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

## Example 2 — `PointHandler` (pure primitives)

```java
package app.handlers;

import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.BinaryField;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;

import app.Point;

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

## Example 3 — Opaque type round-trip (`ZoneId`)

Uses a String reference for the canonical form:

```java
package app.handlers;

import java.time.ZoneId;

import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.BinaryField;
import org.eclipse.serializer.persistence.binary.types.CustomBinaryHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;

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
        return EmbeddedStorageConfiguration.Builder()
            .setStorageDirectory("data")
            .setChannelCount(2)
            .createEmbeddedStorageFoundation()
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
