# Examples-expanded — serializer-standalone

## Example 1 — Default serializer, same JVM

```java
import org.eclipse.serializer.Serializer;

Serializer<byte[]> ser = Serializer.Bytes();
byte[] bytes = ser.serialize("Hello");
String back  = ser.deserialize(bytes);
```

## Example 2 — Registered domain types

```java
import org.eclipse.serializer.Serializer;
import org.eclipse.serializer.SerializerFoundation;

SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerEntityTypes(Customer.class, Order.class, Product.class);

Serializer<byte[]> ser = Serializer.Bytes(sf);

Customer c = new Customer(...);
byte[] bytes = ser.serialize(c);
Customer back = ser.deserialize(bytes);
```

## Example 3 — Circular references

```java
Customer customer = new Customer("alice@acme.com");
Order    order    = new Order("ord-1");
customer.orders().add(order);
order.setCustomer(customer);             // cycle

Serializer<byte[]> ser = Serializer.Bytes(
    SerializerFoundation.New().registerEntityTypes(Customer.class, Order.class)
);

byte[] bytes = ser.serialize(customer);
Customer back = ser.deserialize(bytes);

assert back == back.orders().get(0).customer();   // identity preserved
```

## Example 4 — TypedSerializer for a message queue

```java
import org.eclipse.serializer.TypedSerializer;

Serializer<byte[]> ser = TypedSerializer.Bytes();

// Producer
byte[] payload = ser.serialize(new UserCreatedEvent(...));
kafka.send("events", payload);

// Consumer (different deployment, different registration)
byte[] received = kafka.poll("events");
Object event   = ser.deserialize(received);
if (event instanceof UserCreatedEvent u) { /* ... */ }
```

The consumer didn't pre-register `UserCreatedEvent`; TypedSerializer's embedded
type dictionary is enough.

## Example 5 — TypedSerializer with Diff strategy

```java
import org.eclipse.serializer.TypedSerializer;
import org.eclipse.serializer.SerializerFoundation;
import org.eclipse.serializer.SerializerTypeInfoStrategyCreator;

SerializerFoundation<?> sf = SerializerFoundation.New()
    .registerEntityTypes(Customer.class, Order.class, Product.class)
    .setSerializerTypeInfoStrategyCreator(
        new SerializerTypeInfoStrategyCreator.Diff(true)
    );

Serializer<byte[]> ser = TypedSerializer.Bytes(sf);

// First message: includes Diff between initial types and runtime types
byte[] a = ser.serialize(new Customer(...));

// Subsequent messages with same types: tiny overhead
byte[] b = ser.serialize(new Customer(...));
byte[] c = ser.serialize(new Order(...));
```

## Example 6 — Per-thread serializer pool

```java
public final class Serializers {
    private static final ThreadLocal<Serializer<byte[]>> LOCAL =
        ThreadLocal.withInitial(() -> {
            SerializerFoundation<?> sf = SerializerFoundation.New()
                .registerEntityTypes(Customer.class, Order.class);
            return Serializer.Bytes(sf);
        });

    public static Serializer<byte[]> get() { return LOCAL.get(); }
    private Serializers() {}
}
```

Usage:

```java
byte[] out = Serializers.get().serialize(obj);
```

Call sites stay single-threaded; the cost of building a foundation is paid once per
thread.

## Example 7 — Mini RPC protocol sketch

Server:

```java
try (ServerSocket server = new ServerSocket(9000)) {
    Serializer<byte[]> ser = TypedSerializer.Bytes();
    while (true) {
        Socket s = server.accept();
        new Thread(() -> {
            try (s) {
                DataInputStream  in  = new DataInputStream(s.getInputStream());
                DataOutputStream out = new DataOutputStream(s.getOutputStream());

                int len = in.readInt();
                byte[] requestBytes = in.readNBytes(len);
                Object request = ser.deserialize(requestBytes);

                Object response = dispatch(request);

                byte[] responseBytes = ser.serialize(response);
                out.writeInt(responseBytes.length);
                out.write(responseBytes);
            } catch (IOException e) { /* ... */ }
        }).start();
    }
}
```

Client:

```java
try (Socket s = new Socket("host", 9000)) {
    Serializer<byte[]> ser = TypedSerializer.Bytes();
    byte[] reqBytes = ser.serialize(new GetCustomer("alice@acme.com"));

    DataOutputStream out = new DataOutputStream(s.getOutputStream());
    out.writeInt(reqBytes.length);
    out.write(reqBytes);

    DataInputStream in = new DataInputStream(s.getInputStream());
    int len = in.readInt();
    Object response = ser.deserialize(in.readNBytes(len));
}
```

TypedSerializer means server and client do not need to pre-agree on class set
(practical when message types evolve at different rates).

## Example 8 — As a JCache value serializer

For cache values — needs a `Serializable` wrapper or Eclipse Store's own JCache
integration (see `cache-jcache`). Minimal standalone usage for a third-party cache:

```java
class EclipseSerializer implements ExternalSerializer {
    private static final Serializer<byte[]> SER = Serializer.Bytes(
        SerializerFoundation.New().registerEntityTypes(MyValue.class)
    );
    public byte[] toBytes(Object v)   { return SER.serialize(v); }
    public <T> T  fromBytes(byte[] b) { return SER.deserialize(b); }
}
```

## Example 9 — Round-trip test

```java
import static org.junit.jupiter.api.Assertions.*;

class RoundTripTest {
    @Test
    void customer_with_orders_roundtrips() {
        SerializerFoundation<?> sf = SerializerFoundation.New()
            .registerEntityTypes(Customer.class, Order.class);
        Serializer<byte[]> ser = Serializer.Bytes(sf);

        Customer c = new Customer("alice@acme.com");
        c.orders().add(new Order("ord-1"));

        byte[] bytes = ser.serialize(c);
        Customer back = ser.deserialize(bytes);

        assertEquals(c.email(), back.email());
        assertEquals(1, back.orders().size());
        assertEquals("ord-1", back.orders().get(0).id());
    }
}
```
