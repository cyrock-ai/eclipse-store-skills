# Pitfalls deep-dive — serializer-standalone

## 1. Peers disagree on registered types

**Reproducer.**

```java
// Sender
SerializerFoundation.New().registerEntityTypes(A.class, B.class);
// Receiver
SerializerFoundation.New().registerEntityTypes(A.class);   // missing B
```

**Symptom.** `PersistenceException` or weird nulls when deserializing.

**Fix.** Share the registration. Or use `TypedSerializer` (self-describing).

## 2. Serializing thread pools / connections / live resources

**Reproducer.**

```java
class Service {
    ExecutorService workers = Executors.newFixedThreadPool(4);
}
ser.serialize(new Service());
```

**Symptom.** Fails on reflection boundaries, or "works" and reconstitutes a
`ThreadPoolExecutor` in a broken state.

**Fix.** Don't serialize resources. Use `transient` fields, or split data from
resource-holding classes.

## 3. Sharing a `Serializer` across threads

**Reproducer.**

```java
static final Serializer<byte[]> SER = Serializer.Bytes();
// 8 threads call SER.serialize concurrently
```

**Symptom.** Occasional corruption.

**Fix.** `ThreadLocal<Serializer<byte[]>>`.

## 4. Lambda / anonymous inner class

**Reproducer.**

```java
Runnable r = () -> System.out.println("x");
ser.serialize(r);
```

**Symptom.** Fails or serializes the captured state in unpredictable ways.

**Fix.** Don't. Lambdas are not data.

## 5. Using default `Serializer` for persistent / cross-version storage

**Reproducer.** Write bytes to disk today. Change class shape. Read bytes
tomorrow.

**Symptom.** Deserialization throws "unknown type dictionary".

**Root cause.** Default `Serializer` output has no self-contained schema.

**Fix.** For durable data use Eclipse Store (with `legacy-type-mapping`). For
durable "messages with schema evolution" use `TypedSerializer`.

## 6. Mutating the graph during `serialize`

**Reproducer.** Thread A calls `ser.serialize(list)`. Thread B calls
`list.add(x)` concurrently.

**Symptom.** `ConcurrentModificationException` from inside `serialize`.

**Fix.** Snapshot or lock.

## 7. Circular references "work" but cycles around non-serializable objects don't

If a cycle touches a live resource you tried to exclude via `transient`, the
cycle doesn't close. This isn't specific to cycles — it's the same rule: don't
include resources.

## 8. Expecting `deserialize(bytes)` to be typed

```java
Customer c = ser.deserialize(bytes);   // unchecked cast hazard
```

**Fix.** The return type is inferred from assignment. This is fine if you know
the type; use `TypedSerializer` when you don't, and `instanceof`/pattern match
the result.

## 9. Re-using a consumed `SerializerFoundation`

```java
SerializerFoundation<?> sf = SerializerFoundation.New().registerEntityTypes(A.class);
Serializer<byte[]> s1 = Serializer.Bytes(sf);
Serializer<byte[]> s2 = Serializer.Bytes(sf);   // undefined
```

**Fix.** One serializer per foundation. Build a fresh foundation for each.

## 10. Size surprise with `TypedSerializer.TypeDictionary(false)`

Default `TypedSerializer` sends the full dictionary on **every** serialize call.
For high-volume streams this dominates bandwidth.

**Fix.** Use `IncrementalDiff(true)` or `Diff(true)` for streams.

## 11. Declaring wide interface types slows things down

Fields typed as `List<X>` / `Map<K,V>` force the serializer to record the
concrete class on every instance. For hot paths, use concrete types
(`ArrayList`, `HashMap`) in the class definitions.

## 12. Expecting bytes to be portable across Eclipse Serializer versions

The binary format is stable within a major version but upgrades are not
guaranteed bit-compatible without migration. Don't mix Eclipse Serializer 3.x and
4.x bytes without a re-serialization pass. For long-term storage use Eclipse
Store (which handles this).
