# Pitfalls deep-dive — storing-data

## 1. "I called `store()` but my change isn't there"

**Reproducer.**

```java
Customer c = new Customer("alice@acme.com");
root.customers().put(c.email(), c);
storage.store(c);   // wrong object
```

**Symptom.** Next run: the map doesn't contain the customer.

**Root cause.** `store(c)` persisted the customer's state but did not update the map's
entries. The map is the parent; it is the one that "changed" from Eclipse Store's
point of view.

**Fix.** Store the parent: `storage.store(root.customers())`. (Cascade will pick up the
new customer.) Or `storeAll(c, root.customers())` if you want explicit clarity.

## 2. Deep mutation, parent unchanged, default lazy storing skips it

**Reproducer.**

```java
customer.address().setStreet("Main 2");
storage.store(customer);
```

**Symptom.** On next load `customer.address().street()` is still "Main 1".

**Root cause.** `customer` has not been reassigned — the reference to its
`Address` is the same. Default lazy storing sees an already-persisted child (the
Address) and skips it, even though its fields changed.

**Fix.** Store the modified object: `storage.store(customer.address())`. Or set a
`PersistenceEagerStoringFieldEvaluator` for the `address` field so storing the customer
cascades into it. Or use an eager storer:
`storage.createEagerStorer().store(customer).commit()`.

## 3. Immutable types confuse people

**Reproducer.**

```java
customer.setEmail("new@acme.com");   // String is immutable
storage.store(customer.email());     // storing the String is meaningless
```

**Symptom.** Email change doesn't appear in storage.

**Root cause.** The String "new@acme.com" is a fresh object. Storing it creates a new
reference in the type dictionary but nothing in your graph points to it yet. The
customer still holds its old email from storage's perspective because `customer` was
not stored.

**Fix.** `storage.store(customer)` — the *container* of the immutable is what changed.

## 4. Storing in a loop

**Reproducer.**

```java
for (Order o : incoming) {
    root.orders().add(o);
    storage.store(root.orders());   // disk write per iteration
}
```

**Symptom.** Import is 1000× slower than expected.

**Root cause.** Each `store()` is a full transaction including the collection contents.
Repeating this per item is `O(n²)` writes.

**Fix.** Move the store outside the loop:

```java
root.orders().addAll(incoming);
storage.store(root.orders());
```

Or, if memory doesn't allow buffering, use a `BatchStorer` with thresholds.

## 5. `storeAll(Object[])` confusion

**Reproducer.**

```java
Object[] arr = { a, b, c };
storage.storeAll(arr);
// later expects to retrieve `arr` from storage
```

**Symptom.** The array itself can't be retrieved.

**Root cause.** `storeAll(Object...)` stores each element, **not** the array container.

**Fix.** If you need the array stored as data, wrap it:

```java
var container = new Object[] { a, b, c };
storage.store(container);   // singular store — persists the array as a single object
```

Or restructure: use a typed collection field on a domain object.

## 6. Mutation + store without a lock

**Reproducer.**

```java
// Thread A
root.orders().add(o);
storage.store(root.orders());

// Thread B (concurrent)
root.orders().remove(other);
storage.store(root.orders());
```

**Symptom.** Random `ConcurrentModificationException` during serialization; disk state
occasionally doesn't match memory.

**Root cause.** The two threads mutate `root.orders()` concurrently. The serializer
iterates the collection during `store()` and sees a mutation.

**Fix.** A single writer lock around mutate + store. Readers can use a shared read
lock. See Pattern E in SKILL.md.

## 7. `Storer` without `commit()`

**Reproducer.**

```java
Storer s = storage.createStorer();
s.store(root.customers());
// ... forgot commit()
```

**Symptom.** Nothing on disk.

**Root cause.** `Storer.store()` enqueues; the buffered bytes are held in memory.
Without `commit()`, the buffered data is discarded — the store had no effect on
disk.

**Fix.** Always commit. Or don't use a manual `Storer` — use
`storage.store(...)`, which creates a default storer and commits it for you.

**Important — do not use try-with-resources.** `Storer` is **not**
`AutoCloseable`. The only `AutoCloseable` storer is `BatchStorer`, which flushes
on close.

```java
// WRONG — Storer is not AutoCloseable; this does not compile in modern JDKs
// and would discard the data even if it did.
try (Storer s = storage.createStorer()) {
    s.store(root.customers());
}
```

## 8. BatchStorer `build()` throws

**Reproducer.**

```java
var b = storage.batchStorerBuilder().build();
```

**Symptom.** `IllegalStateException`.

**Root cause.** Neither `maxSize` nor `flushCycle` is configured. The builder rejects
a batch storer with no flush criteria.

**Fix.** Set at least one: `.maxSize(10_000)` and/or `.flushCycle(Duration.ofSeconds(1))`.

## 9. Storing a subclass of `ArrayList` / `HashMap`

**Reproducer.**

```java
class CustomerList extends ArrayList<Customer> { private String label; }
root.setCustomers(new CustomerList());
storage.store(root);
```

**Symptom.** Slow serialization, subtle differences on load, sometimes
`PersistenceException` about type analysis.

**Root cause.** Eclipse Store's specialized `ArrayList` handler is registered for
`java.util.ArrayList` exactly, not subclasses. Your subclass falls back to generic
reflective handling which cannot cleanly serialize both the list elements and the
extra field.

**Fix.** Composition:

```java
class CustomerList {
    private final List<Customer> customers = new ArrayList<>();
    private String label;
    // accessors
}
```

## 10. `storeRoot()` when the root reference didn't change

**Reproducer.**

```java
root.customers().put(c.email(), c);
storage.storeRoot();
```

**Symptom.** Customer not visible on next run.

**Root cause.** `storeRoot()` stores the root object. The root reference is unchanged;
the children it points to were already persisted. Default lazy storing doesn't re-
persist them.

**Fix.** `storage.store(root.customers())`.

## 11. A previously stored object mutated, then `store(parent)` still doesn't save it

**Reproducer.**

```java
// customer was loaded from storage — already persisted
customer.addresses().add(new Address(...));
storage.store(customer);
```

**Symptom.** The new address isn't visible next run.

**Root cause.** Same as pitfall 2 — `customer`'s reference to `addresses` didn't
change; default lazy skips the already-persisted collection.

**Fix.** `storage.store(customer.addresses())`.

## 12. Hidden field with no getter

**Reproducer.** Third-party class `ForeignObject` has `private HiddenObject hidden;`
with no accessor. You mutate `hidden` via reflection but can't call
`storage.store(foreign.hidden)`.

**Root cause.** No way to express the target of the store.

**Fix.** Install a field-level eager evaluator (see Example 4 in
`examples-expanded.md`). Then storing `foreignObject` cascades into `hidden`.

## 13. Atomicity illusion across multiple `store()` calls

**Reproducer.**

```java
storage.store(root.customers());   // commits
// crash
storage.store(root.orders());      // never runs
```

**Symptom.** After restart, customers are updated but orders are not.

**Root cause.** Each `store()` call is a separate transaction. If you want both or
neither, use a manual `Storer` + single `commit()`.

**Fix.**

```java
Storer s = storage.createStorer();
s.store(root.customers());
s.store(root.orders());
s.commit();
```

## 14. Convenience methods assumed to be eager

**Reproducer.**

```java
// Hoping this re-walks the entire reachable graph
storage.store(root);
```

**Symptom.** Mutations to deeply-nested already-registered objects are still
missing on the next load, even though the user "stored the root".

**Root cause.** `store`, `storeAll`, and `storeRoot` on the manager are
**always lazy**. There is no flag to make them eager. They internally create
a default (lazy) storer and commit it for you.

**Fix.** Create the storer explicitly:

```java
Storer eager = storage.createEagerStorer();
eager.store(root);
eager.commit();
```

Or, more surgically, store only the modified objects directly. Or register a
`PersistenceEagerStoringFieldEvaluator` to mark just the problematic fields
as eager-traversed.

## 15. Sharing a `Storer` across threads

**Reproducer.**

```java
Storer storer = storage.createStorer();    // built once, shared across threads

ExecutorService pool = Executors.newFixedThreadPool(4);
for (int i = 0; i < 1_000; i++) {
    final int n = i;
    pool.submit(() -> storer.store(new Order(n)));
}
storer.commit();
```

**Symptom.** Random `IllegalStateException`, intermittent corruption of the
persistent context, missing objects on disk, occasional NPEs from inside the
storer's internal buffers.

**Root cause.** `Storer` is single-threaded internal state — register buffers,
type handlers, the registry view. Concurrent `store()` calls race on those
internals.

**Fix.** Each thread that wants to commit gets its own `Storer`.

```java
ExecutorService pool = Executors.newFixedThreadPool(4);
for (int i = 0; i < 1_000; i++) {
    final int n = i;
    pool.submit(() -> {
        Storer s = storage.createStorer();    // per-thread
        s.store(new Order(n));
        s.commit();
    });
}
```

The same applies to `createLazyStorer`, `createEagerStorer`, and `BatchStorer`.
See `concurrency-and-locking` for the full thread-safety matrix.
