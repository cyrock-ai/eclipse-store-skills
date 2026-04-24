# Pitfalls deep-dive — gigamap

## 1. `storageManager.store(gigaMap)` races with CRUD

**Reproducer.**

```java
new Thread(() -> map.add(newPerson)).start();
storageManager.store(map);   // can throw
```

**Symptom.** `BinaryPersistenceException: Inconsistent element count`.

**Root cause.** `storageManager.store` doesn't acquire GigaMap's internal lock.
A concurrent mutation changes element count mid-serialize.

**Fix.** Use `map.store()` instead. It takes the lock.

## 2. Mutating entities without `update`/`apply`

**Reproducer.**

```java
Person p = map.query(lastName.is("Smith")).findFirst().orElseThrow();
p.setLastName("Brown");
map.store();
```

**Symptom.** Queries for "Brown" return nothing; queries for "Smith" still
return `p`.

**Root cause.** Indices didn't learn about the change.

**Fix.** `map.update(p, x -> x.setLastName("Brown"))`.

## 3. Forgetting to close iterators

**Reproducer.**

```java
Iterator<Person> it = map.query(...).iterator();
while (it.hasNext()) process(it.next());
// no close; next store() blocks
```

**Symptom.** Deadlock or very long waits on subsequent `store()` / writes.

**Fix.** Always try-with-resources.

## 4. Null insertion

**Reproducer.**

```java
map.add(null);
```

**Symptom.** NPE or `IllegalArgumentException`.

**Root cause.** GigaMap disallows nulls by design.

**Fix.** Don't pass null. Use an `Optional` at the call site if you need
"maybe".

## 5. Identity vs. value equality

**Reproducer.**

```java
GigaMap<Order> map = GigaMap.New();   // identity

Order a = new Order("ord-1", "alice");
Order b = new Order("ord-1", "alice");
map.add(a);
map.add(b);   // succeeds — identity sees them as different

map.remove(b);   // works because b was added
map.remove(a);   // works because a is present
```

**Symptom.** Two "same" orders coexist.

**Root cause.** Default identity equality. `a != b` even though `.equals()` may
say true.

**Fix.** If your domain wants value equality:

```java
GigaMap<Order> map = GigaMap.New(XHashing.hashEqualityValue());
```

And make sure `Order` implements `equals`/`hashCode`.

## 6. No identity index on a large map

**Reproducer.** Map with 10 M entries, no identity index. Call
`map.remove(person)`.

**Symptom.** Slow — Eclipse Store builds a compound index on the fly.

**Fix.** Always declare `.withBitmapIdentityIndex(...)` for the stable id.

## 7. Unique constraint violation silently swallowed

**Reproducer.**

```java
try { map.add(dup); } catch (UniqueConstraintViolationException e) { /* ignore */ }
map.store();
```

**Symptom.** Business logic proceeds as if the add succeeded; data integrity
problem.

**Fix.** Handle the exception at the domain level — either update the existing
entity or fail the operation.

## 8. Wrapping GigaMap in `Lazy<>`

**Reproducer.**

```java
private Lazy<GigaMap<Person>> people = Lazy.Reference(GigaMap.<Person>Builder()...build());
```

**Symptom.** Works but is pointless — GigaMap is internally lazy. You've added a
layer that blocks external access patterns (`Lazy.get()` hides the internal
iteration semantics).

**Fix.** Use GigaMap as a direct field. It handles lazy segments itself.

## 9. Modifying indexer after build

You can't. The index structure is fixed at `build()`. Adding an index later
requires scanning the entire dataset.

**Fix.** Plan indices up front. If you must add later, do a migration: build a
new GigaMap with the desired indices, copy entries over via `addAll`, swap the
root reference.

## 10. Segmented iteration vs. eager `.toList()`

**Reproducer.** `map.query(...).toList()` on a 100 M map with broad condition.

**Symptom.** OOM.

**Fix.** Use `.stream()` / `.iterator()` and process in chunks; or use
`.count()` if you only need size; or narrow the query with more conditions.

## 11. Queries across multiple `GigaMap` instances

**Reproducer.**

```java
q1 = mapA.query(...)
q2 = mapB.query(...)
q1.and(q2)   // undefined
```

**Symptom.** Invalid.

**Fix.** Sub-query combination is within one GigaMap. Cross-map intersection
means joining at the application level.

## 12. Lucene / vector dependencies not on classpath

**Reproducer.**

```java
builder.withLuceneIndex(...)
```

…without `gigamap-lucene`.

**Symptom.** `NoClassDefFoundError` at build time.

**Fix.** Add the optional artifact.
