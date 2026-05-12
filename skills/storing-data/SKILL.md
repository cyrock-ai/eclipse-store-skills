---
name: storing-data
description: >
  Guide Claude on persisting object graphs with Eclipse Store — the "modified
  object must be stored" rule, the difference between lazy and eager storing,
  how `store()` / `storeAll()` / `storeRoot()` differ, when to use a
  `BatchStorer`, and how to keep mutation and `store()` atomic under application
  locks.

  **Apply this skill whenever a service / repository / facade / controller
  method that mutates persistent state is being designed, reviewed, or
  extended** — not only when a missing `store()` already caused a "change
  isn't on disk" bug. Eclipse Store has no dirty tracking, so every mutating
  method is implicitly responsible for an explicit `store(...)` call (and a
  lock around it — see `concurrency-and-locking`). Deciding *what* to pass to
  `store()` is also a design decision: shallow vs. deep walk, eager vs. lazy
  storer, single call vs. `BatchStorer`. If you are sketching any code path
  that writes to the persistent graph, load this skill before deciding the
  shape of that method.

  Also use this skill when the user asks to "store data", "persist changes",
  "store all", "storeRoot", "why isn't my change saved", "BatchStorer",
  "createStorer", "eager storer", "lazy storer", "bulk insert", "store a
  list", "transaction", "commit", "hidden field not stored", or is confused
  about why a mutation didn't persist after `store()`.
version: 0.2.0
---

# Eclipse Store — Storing Data

This skill is the single most common source of bugs for newcomers. The library does not
have "dirty tracking", and it does not crawl the graph after every mutation looking for
changes. **You tell it what changed.** Everything in this skill stems from that one fact.

## Do NOT use this skill

- Storage isn't set up yet → `getting-started`.
- Designing the root object → `root-and-object-graph`.
- Deferring **loading** (not storing) → `lazy-loading`.
- Wiring storing into Spring → `spring-boot` (the rules here still apply inside
  services).

## Mental model

A single, load-bearing sentence: **"The modified object must be stored."**

Two rules unpack it:

1. **The object you pass to `store(...)` is *always* re-written.** This is true for
   both lazy and eager storers, regardless of whether that object is already
   registered in storage. The lazy/eager distinction only governs how *referenced
   child* objects are walked.
2. **Default lazy storing skips already-registered child references.** If
   `x.child` is already in the persistent registry, the lazy walk records the
   reference but does not descend into the child's fields. A field that was
   mutated in place on an already-known child therefore does **not** persist.

The implication: if you add an element to a collection, the *collection* has changed
(the explicit argument always re-writes — and the new element, never seen before, is
written). Store the collection. If you update a field on an existing entity, the
*entity* has changed; store the entity directly — storing its parent is not enough,
because the lazy walk skips already-registered children.

For collections specifically this is what makes lazy storing scale: a list of one
million customers with one new element costs roughly one customer's worth of payload,
not one million. The list shell is re-written (explicit argument), the new element is
written (newly encountered), and the existing 999,999 are skipped.

This rule combined with the thread-safety model (see below) is the entirety of
day-to-day storing.

### Atomicity & threads

Each `store()` call is atomic for **durability** — it succeeds fully on disk or not
at all. This is *durability* atomicity, not *isolation* in RAM. Eclipse Store does
not synchronize the in-memory graph for you; the graph the store traverses is
unprotected from concurrent mutation.

You must mutate and call `store()` under the same lock. Without that, another thread
can observe a half-mutated graph or the write can race. See `concurrency-and-locking`
for the canonical treatment, the strategy ladder, and the GigaMap-specific story.

## Core API

All methods live on `EmbeddedStorageManager` / `StorageConnection`:

| Method | Stores | Notes |
|---|---|---|
| `long store(Object x)` | `x` + lazily referenced new subgraph | **The workhorse.** Convenience method, always lazy, auto-commits. |
| `long[] storeAll(Object... xs)` | each `x` + referenced new subgraph | The array itself is not stored. Always lazy, auto-commits. |
| `void storeAll(Iterable<?> xs)` | each element + referenced new subgraph | The iterable itself is not stored. **Returns `void`** — no objectIds. Always lazy, auto-commits. |
| `long storeRoot()` | the root object | Special case; rarely needed after startup (see note below). Always lazy. |
| `Storer createStorer()` | programmable | The default lazy storer. **Not `AutoCloseable`** — call `.commit()` explicitly; do *not* use try-with-resources. |
| `Storer createLazyStorer()` | explicit lazy | Same as default. **Not `AutoCloseable`.** |
| `Storer createEagerStorer()` | everything reachable, even already-persisted | Use for known-dirty subgraphs. **Not `AutoCloseable`.** |
| `BatchStorer` | size/time-bounded batched commits | Via `storageManager.batchStorerBuilder()`. **For ingest loops.** *Is* `AutoCloseable` (the exception). |

`Storer` contract: `storer.store(x)` enqueues; `storer.commit()` flushes. You can stage
multiple stores and commit once — this is the Eclipse Store notion of a multi-object
transaction. **Without `commit()`, the buffered data is discarded — the store had no
effect on disk.**

**Convenience methods are always lazy.** `store`, `storeAll`, and `storeRoot` on the
manager internally create a default (lazy) storer and commit it for you. There is no
flag to make them eager. For eager semantics, create the storer explicitly via
`createEagerStorer()`.

**`Storer` instances are single-threaded.** Each thread that wants to store
concurrently must obtain its own `Storer` — they must not be shared across threads.
See `concurrency-and-locking` for the full thread-safety matrix.

## Idiomatic patterns

### Pattern A — Canonical "store the modified collection"

Adding a new entity to a top-level collection:

```java
Customer c = new Customer("alice@acme.com");
root.customers().put(c.email(), c);
storage.store(root.customers());   // the map is what changed
```

Updating a field on an existing entity:

```java
customer.setEmail("new@acme.com");
storage.store(customer);           // the customer is what changed
```

Replacing a nested record with an immutable type:

```java
customer.setAddress(new Address(...));   // Address is immutable
storage.store(customer);                 // not the Address
```

### Pattern B — Multiple objects atomically: a manual `Storer`

When you need several mutations to persist as one transaction:

```java
Storer storer = storage.createStorer();    // default (lazy)
try {
    storer.store(root.customers());
    storer.store(root.orders());
    storer.store(auditLog);                // all-or-nothing
    storer.commit();
} catch (RuntimeException e) {
    // no commit → nothing on disk
    throw e;
}
```

If any `store()` throws before `commit()`, nothing is written. Once `commit()` succeeds,
all of it is persisted atomically.

### Pattern C — Batch storer for ingest loops

A million-row import should not do a million disk transactions:

```java
try (BatchStorer batch = storage.batchStorerBuilder()
        .maxSize(10_000L)
        .flushCycle(Duration.ofSeconds(1))
        .build()) {

    for (Event e : events) {
        root.events().add(e);
        batch.store(root.events());   // re-serializes root.events each call, but buffered
    }
    batch.commit();                   // flush any remaining
}
```

Notes from the upstream docs:

- `maxSize` and/or `flushCycle` must be set — else `build()` throws.
- Each `batch.store(x)` re-serializes `x` (captures the current mutable state).
- Child objects use lazy semantics — only new ones get re-stored.
- `BatchStorer` is `AutoCloseable`; always use try-with-resources.
- `checkInterval` (default 1 s) governs how often the daemon thread checks for flush.

### Pattern D — Eager storer for deep dirty subgraphs

Use when you know a whole subgraph is dirty and you don't want to enumerate every
mutated child:

```java
Storer eager = storage.createEagerStorer();
eager.store(root.catalog());   // walks every reachable child, even if already persisted
eager.commit();
```

Use sparingly — eager storing is slower because it re-serializes everything reachable.
Typical legitimate use: a migration that rewrites a subtree, or a config object whose
sub-objects you don't want to hand-enumerate.

### Pattern E — Mutate + store under the same lock

```java
public void renameCustomer(String id, String newEmail) {
    lock.writeLock().lock();
    try {
        Customer c = root.customers().get(id);
        if (c == null) return;
        c.setEmail(newEmail);
        storage.store(c);       // same lock scope as the mutation
    } finally {
        lock.writeLock().unlock();
    }
}
```

This is non-negotiable in multi-threaded code. The lock must span **both** the
mutation and the `store()` call. See `concurrency-and-locking` for the full strategy
ladder (`XThreads.executeSynchronized`, `LockedExecutor`, `LockScope`, striped
helpers, Spring `@Read` / `@Write` / `@Mutex`) and which to pick when.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Storing the child but not the parent (or vice versa)

```java
// WRONG
Customer c = new Customer("alice@acme.com");
root.customers().put(c.email(), c);
storage.store(c);      // c is persisted, but the map doesn't know about it yet
```

On the next run, the customer exists in storage but the map doesn't reference it —
it's orphaned and will be GC'd.

**Fix**: `storage.store(root.customers())` (which cascades into `c`), or both: `store(c)`
**and** `store(root.customers())`.

### Anti-pattern 2 — Storing inside a loop when one store would suffice

```java
// WRONG — one disk transaction per iteration
for (Event e : events) {
    root.events().add(e);
    storage.store(root.events());
}
```

**Fix**: a single `storage.store(root.events())` after the loop, or a `BatchStorer`
(Pattern C) if the loop can't finish before memory fills.

### Anti-pattern 3 — Assuming mutation cascades automatically

```java
// WRONG
customer.address().setStreet("New Street");
storage.store(customer);     // persists customer (the explicit argument is always
                             // re-written), but the lazy walk hits the already-
                             // registered Address and stops there — its mutated
                             // street is NOT re-persisted.
```

The lazy walk applied to `store(customer)`:

```
Customer  <-- explicit argument: ALWAYS re-written
   |
Address   <-- child reference, already in registry: STOP
              (the field mutation is invisible to the walk)
```

**Fix**: store the modified object directly: `storage.store(customer.address())`.
Or, for fields where this happens routinely, register a
`PersistenceEagerStoringFieldEvaluator` for that field so the walk descends through
it (see Advanced below). Or, for a one-shot bulk write where correctness matters
more than I/O cost, use an eager storer.

### Anti-pattern 4 — Storing the array from `storeAll(Object...)`

```java
// WRONG mental model
Object[] batch = { a, b, c };
storage.storeAll(batch);
// ...now thinking the array is persisted
```

The array argument itself is not stored — only its elements. If you wanted to persist
an array as data, you need to store the container that references it.

### Anti-pattern 5 — Mutating without a lock in a multithreaded app

```java
// WRONG
new Thread(() -> { root.orders().add(o); storage.store(root.orders()); }).start();
new Thread(() -> { root.orders().remove(o2); storage.store(root.orders()); }).start();
```

Two threads mutate and store the same collection concurrently. At best you get
inconsistent on-disk state. At worst, `ConcurrentModificationException` during
serialization.

**Fix**: a `ReentrantReadWriteLock` (Pattern E) or finer-grained application lock.

### Anti-pattern 6 — Subclassing JDK collections

```java
// WRONG
class CustomerList extends ArrayList<Customer> { /* add fields */ }
root.setCustomers(new CustomerList());
```

Eclipse Store ships specialized type handlers for `ArrayList`, `HashMap`, etc. A
subclass bypasses them and falls through to generic handling, causing performance or
correctness issues. Use composition: a field that holds an `ArrayList`.

### Anti-pattern 7 — `storeRoot()` after day-one

```java
// USUALLY WRONG
root.customers().put(...);
storage.storeRoot();         // stores the root reference, which didn't change
```

`storeRoot()` stores the root instance itself. Cascade reaches children, but since the
root reference didn't change, all you're really doing is rewriting the root file — the
map modifications still need to be discovered. In default (lazy) mode, if the map is
already persisted, `storeRoot()` does not re-persist the map's current contents.

**Fix**: `storage.store(root.customers())`. Use `storeRoot()` only when you replaced the
root reference (see `root-and-object-graph`, Pattern C).

## Pitfalls & gotchas (ranked by frequency)

1. **"I stored it but it didn't save."** 99% of the time this is the modified-parent
   rule (anti-pattern 1). You stored the leaf; nothing points to it yet. Store the
   parent.
2. **Default lazy storing skips persisted children.** Deep mutations inside already-
   persisted subgraphs need explicit stores per modified object, or eager storing, or a
   field-level eager evaluator.
3. **Immutable fields (`String`, `Instant`, `BigDecimal`).** You cannot "modify" an
   immutable. Setting a new one mutates the container — store the container.
4. **Collections mutated via non-standard methods.** Replacing the collection reference
   (`root.setOrders(new ArrayList<>())`) is a reference change on root — store `root`
   (or better, `root.orders` after you reassign — but prefer `final` fields).
5. **`store()` throwing mid-batch.** Default storer operations auto-commit; if a manual
   `Storer`'s `.store()` throws, no partial data is on disk (good). But exceptions
   during commit are where writes can partially land and be reverted on startup.
6. **Hidden/encapsulated fields with no public getter.** You can't call
   `store(obj.hidden)`. Two fixes: global eager storing (costly), or a
   `PersistenceEagerStoringFieldEvaluator` targeting that specific field.
7. **BatchStorer build without thresholds.** `IllegalStateException` from `.build()`.
   Set at least `maxSize` or `flushCycle`.
8. **Forgetting `commit()` on a manual `Storer`.** Without `commit()`, the buffered
   data is discarded — the store had no effect on disk. Convenience methods
   (`storage.store(...)`) commit for you; explicit storers do not. `Storer` is
   **not** `AutoCloseable`; do not put it in try-with-resources.
9. **Convenience methods assumed to be eager.** `store`, `storeAll`, and
   `storeRoot` on the manager are *always* lazy. There is no flag. If you need
   eager semantics, call `createEagerStorer().store(x).commit()` explicitly.
10. **Sharing a `Storer` across threads.** A `Storer` is single-threaded state.
    Each thread that wants to commit concurrently must obtain its own from
    the manager. See `concurrency-and-locking` for the matrix.

## Advanced — custom eager field evaluator

Global eager mode is expensive; you often want eager only for specific fields
(inner records with no getters, cache fields, etc.). Use a
`PersistenceEagerStoringFieldEvaluator` set on the connection foundation:

```java
EmbeddedStorage.Foundation(config)
    .onConnectionFoundation(cf -> cf.setReferenceFieldEagerEvaluator(
        (entityType, field) -> field.getName().equals("hidden")
    ))
    .start(root);
```

Only fields the evaluator returns `true` for are eager-stored.

## Interactions with other skills

- **`root-and-object-graph`** — "store the parent" often means "store a collection on
  the root".
- **`lazy-loading`** — `Lazy<T>` wraps deferred *loading*, not storing. Two unrelated
  concepts that share a name; `lazy-loading` covers when objects are *read* from
  disk, this skill covers how `store()` *writes* them.
- **`concurrency-and-locking`** — the lock that brackets mutation + `store()`. The
  rule that the lock spans both is the conceptual basis for every `store()` call in
  multi-threaded code. Includes the strategy ladder, the thread-safety matrix
  (`Storer` is single-threaded), and the GigaMap-specific concurrency rules.
- **`housekeeping-and-deletion`** — data orphaned by bad stores becomes GC candidates.
- **`spring-boot`** — Spring's `@Transactional` does **nothing** for Eclipse Store.
  You still call `store()` yourself. The Spring AOP layer
  (`@Read`/`@Write`/`@Mutex`) is the declarative form of the mutate-and-store-under-
  same-lock rule.
- **`legacy-type-mapping`** — when you add a field to an entity, storing that entity
  persists the new field; the schema evolution piece covers reading the old binary data.

## Recipes

**"I added one item to a list. Which `store()` call?"** → `storage.store(theList)`.

**"I want to persist changes to 50 customers atomically."** → Manual `Storer`:
`createStorer()`, `store()` each, then one `commit()`.

**"I'm importing 10 million events."** → `BatchStorer` with `maxSize(10_000)` and
`flushCycle(Duration.ofSeconds(1))`, in a try-with-resources.

**"I changed a field on an object deep inside the graph."** → Store that object. The
fact that its parent is already persisted is irrelevant.

**"Should I always use `storeAll()` when storing multiple things?"** → Yes, if the
"things" are known up front. It's a single atomic write instead of several. But it is
*not* a substitute for picking the right object to store — `storeAll` does not help if
you still pick the wrong granularity.

**"How do I make the whole graph eager?"** → Convenience methods (`store`,
`storeAll`, `storeRoot`) cannot be made eager — they always use the lazy strategy.
Create the storer explicitly: `storage.createEagerStorer().store(x).commit()`. There
is no eager equivalent to `storeAll(...)` on the manager.

**"How do I disambiguate lazy storing from lazy loading?"** → Lazy *storing* (this
skill) controls how `store()` walks the object graph when writing. Lazy *loading*
(see `lazy-loading`) defers reading objects from storage into RAM until accessed.
Two unrelated concepts that share a word.

**"What if `store()` fails?"** → Nothing on disk is committed. On the next
`.start()`, any partial tail is truncated. Your in-memory graph may still be mutated,
though — that's your application's concern.

**"Does `store()` block concurrent reads?"** → At the disk level the store is atomic
and fast. The library itself does not block your reads — but your application-level
locks (writeLock vs. readLock) govern that.

## Deeper lookups (on-demand)

- **Load `references/api-catalogue.md`** when you need a `Storer` method not in
  the in-line Core API (e.g. `skip(Object)`, `skipMapped`, `clear()`,
  `reinitialize`, capacity hints, commit listeners), the full
  `BatchStorer.Builder` surface (`maxSize` / `flushCycle` / `checkInterval`
  defaults and constraints), or the `setReferenceFieldEagerEvaluator` hook.
- **Load `references/examples-expanded.md`** when you want a runnable template
  — full `CustomerService` with three mutation patterns, multi-object `Storer`
  transaction, `BatchStorer` ingest with `@TempDir`, eager-field-evaluator
  wiring on the foundation, `Storer.registerRegistrationListener` for audit,
  lazy-vs-eager walk visualised side by side.
- **Load `references/pitfalls-deep-dive.md`** when diagnosing a missing-store
  bug — child stored without parent, in-place mutation skipped by lazy walk,
  immutable confusion, loop-of-stores `O(n²)`, `storeAll(Object[])` array
  mistake, `Storer` without `commit()`, sharing `Storer` across threads,
  hidden field with no getter, atomicity illusion across multiple `store()`s.

## Upstream sources

- `docs/modules/storage/pages/storing-data/index.adoc` — the headline rule.
- `docs/modules/storage/pages/storing-data/lazy-eager-full.adoc` — storing strategies.
- `docs/modules/storage/pages/storing-data/batch-storer.adoc` — BatchStorer details.
- `docs/modules/storage/pages/storing-data/best-practice.adoc` — composition-over-
  inheritance, hidden fields, registration listeners.
- `docs/modules/storage/pages/storing-data/transactions.adoc` — atomicity semantics.
- `examples/storing/`, `examples/eager-storing/` — runnable upstream examples.
