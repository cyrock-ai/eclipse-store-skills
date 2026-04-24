---
name: legacy-type-mapping
description: >
  Guide Claude on evolving persisted class structure in Eclipse Store — renaming,
  adding, removing, reordering, and retyping fields; renaming and moving classes;
  deleting classes; supplying explicit mappings via a CSV refactoring file; writing
  custom legacy type handlers for non-trivial transformations. Use this skill when
  the user asks to "evolve schema", "rename a field", "rename a class", "add a field",
  "remove a field", "change field type", "move a class to a different package",
  "schema migration", "legacy type mapping", "refactoring CSV", "TypeMappingDictionary",
  "BinaryLegacyTypeHandler", "PersistenceLegacyTypeMappingResultor",
  "PersistenceMemberSimilator", or reports a "no suitable type handler" / "legacy type
  mapping required" message at startup.
version: 0.1.0
---

# Eclipse Store — Legacy Type Mapping (Schema Evolution)

Classes drift. Fields get renamed, moved, retyped; classes get packages-changed,
renamed, deleted. Eclipse Store handles this without rewriting stored files — it
transforms old binary data on the fly during load. Most of the time it does it
automatically with heuristic matching. When the heuristic guesses wrong, you supply
an explicit mapping file or a custom legacy type handler.

## When to use this skill

- User changed a class and reports a startup failure about "legacy type mapping".
- User asks how to rename a field / class / package without losing data.
- User is writing a `refactorings.csv`.
- User wants to split one field into multiple (custom legacy handler).
- User wants to delete a class and asks how.
- User wants to customize the similarity heuristic.

**Route elsewhere** when:

- User wants generic custom type handlers (not for legacy) → `custom-type-handlers`.
- User wants to physically migrate data to new channel count / directory layout → that
  is `configuration` (channel tuning) or offline export-import, not this skill.
- User just added a field and "it works" — no skill needed, it's automatic.

## Mental model

Stored data carries a **type dictionary** — a record of every class structure ever
persisted (fields, types, order). Each Java class on disk has a **Type ID** (e.g.
`1000055:com.myapp.Customer`).

At startup, Eclipse Store compares the dictionary with the current class structure:

1. For each stored type, find the current class with the same name.
2. Compare fields. If they match exactly, nothing to do.
3. If they differ, build a **field mapping** — from old → current — using:
   - Explicit entries from the refactoring CSV.
   - The heuristic (Levenshtein similarity on field names, compatible types).
4. Compile **value translators** for matched fields.
5. Loading a legacy-typed binary record runs through the translators; result is a
   current-type instance.

**Stored data is never rewritten.** The translation happens on load. When a rewritten
instance is re-stored, it lands in current format — over time all records drift
toward the current version.

## Supported changes

| Change | Handling |
|---|---|
| Field renamed | Auto (heuristic) or explicit |
| Field added | Auto — initialized to default (null, 0, false) |
| Field removed | Auto — stored value discarded |
| Field reordered | Auto |
| Field retyped (primitive ↔ primitive) | Auto conversion, Java cast semantics |
| Field retyped (primitive ↔ wrapper) | Auto (null → 0 when unboxing) |
| Class renamed / moved to new package | Explicit mapping required |
| Class deleted | Explicit mapping (`;` discard) — and all instances must be unreachable |
| Field split / computed derived | Custom legacy type handler |

## Core API

### Auto (heuristic) — no code

Just run. If the heuristic gets it right, you're done.

### Explicit mapping via CSV

```java
EmbeddedStorageFoundation<?> foundation = EmbeddedStorage.Foundation(dataDir);
foundation.setRefactoringMappingProvider(
    Persistence.RefactoringMapping(Paths.get("refactorings.csv"))
);
EmbeddedStorageManager storage =
    foundation.createEmbeddedStorageManager(root);
storage.start();
```

CSV format (semicolons or tabs):

```csv
old                                         current
com.myapp.Customer#customerid               com.myapp.Customer#pin
com.myapp.Customer#comment
;com.myapp.Customer#commerceId
com.myapp.OldOrder                          com.myapp.Order
```

| Syntax | Meaning |
|---|---|
| `old;current` | Map old to current. |
| `old;` | Discard old (no current mapping). |
| `;current` | Declare current as new (prevents heuristic mis-mapping). |
| `com.x.Class` | Class-level mapping (rename / move / delete). |
| `com.x.Class#field` | Field-level mapping. |
| `com.x.Class#com.x.Declaring#field` | Field with explicit declaring class (inheritance). |
| `1012345:com.x.Class` | Version-specific mapping using Type ID. |

### Custom legacy type handler

For transformations the heuristic can't express (field splits, computed derived
values, nested-object restructuring):

```java
EmbeddedStorageManager storage = EmbeddedStorage.Foundation(dataDir)
    .onConnectionFoundation(f ->
        f.getCustomTypeHandlerRegistry()
            .registerLegacyTypeHandler(new LegacyTypeHandlerNicePlace())
    )
    .start(root);
```

See `references/examples-expanded.md` for a full handler example.

### Customize the heuristic

Replace Levenshtein with an annotation-based scheme or domain rules:

```java
foundation.onConnectionFoundation(f ->
    f.setLegacyMemberMatchingProvider(
        myPersistenceMemberSimilatorImpl
    )
);
```

## Idiomatic patterns

### Pattern A — Boring rename, let heuristic do it

Rename `name` → `lastname` in `Contact`. Start the app. Check logs (SLF4J, logger
name `org.eclipse.serializer...LoggingLegacyTypeMappingResultor`):

```
java.lang.String Contact#name -0.750 ----> java.lang.String Contact#lastname
```

Similarity score 0.75 is high enough; auto-matched. No action needed.

### Pattern B — Heuristic guesses wrong: use explicit CSV

The heuristic mis-maps `customerid` → discard and `comment` → `commerceId`. Fix with
two CSV entries:

```csv
old;current
com.myapp.Customer#customerid;com.myapp.Customer#pin
com.myapp.Customer#comment;
```

The `pin` field is now explicitly mapped; `comment` is explicitly discarded. The
heuristic handles the rest (`firstname`→`firstName`, `surname`→`lastName`,
`commerceId` as new, `address` as new).

### Pattern C — Class rename / package change

Moved `com.myapp.v1.Customer` → `com.myapp.Customer`:

```csv
old;current
com.myapp.v1.Customer;com.myapp.Customer
```

Fields follow automatically if heuristic matches them. Add per-field entries only for
fields the heuristic would miss.

### Pattern D — Delete a class

You want to remove `com.myapp.ObsoleteType`:

1. Remove all references to any `ObsoleteType` instance from the persistent graph.
2. Run housekeeping GC and file compaction to remove their bytes.
3. Add to `refactorings.csv`:

   ```csv
   old;current
   com.myapp.ObsoleteType
   ```

4. Delete the class from source.
5. Restart. If any instance is still reachable, a
   `PersistenceUnreachableTypeHandler` throws when that instance loads — you missed
   a reference; find it and delete it properly.

### Pattern E — Custom legacy type handler (field split)

Old `NicePlace` had a single `String directions`. New `NicePlace` has a
`Location location` (a structured type). Heuristic can't express this.

Write a `BinaryLegacyTypeHandler.AbstractCustom<NicePlace>` subclass that:

- Declares the **old** binary layout (two Strings).
- Implements `create(Binary, PersistenceLoadHandler)` — construct an empty instance.
- Implements `updateState(Binary, NicePlace, PersistenceLoadHandler)` — read old
  fields, build new `Location`.
- Implements `iterateLoadableReferences` — report object-id references in the old
  binary (so the loader can resolve them).

Register on the foundation (see Core API above).

See `references/examples-expanded.md` for the complete 70-line implementation.

### Pattern F — Mapping with inheritance disambiguation

Multiple classes in a hierarchy all had a `count` field; now you want to rename only
the one on `ArticleHolder`:

```csv
old;current
com.myapp.Order#com.myapp.ArticleHolder#count;com.myapp.Order#com.myapp.ArticleHolder#articleCount
```

The `OwningClass#DeclaringClass#field` syntax is only needed when names collide.

### Pattern G — Mapping a specific stored version by Type ID

If you stored a class under multiple shapes (class structure changed, you restarted,
it changed again), you may have multiple Type IDs in the dictionary. Pin the mapping:

```csv
old;current
1012345:com.myapp.Order;com.myapp.Order
```

Type IDs are in `PersistenceTypeDictionary.ptd` in the storage directory.

## Anti-patterns (do NOT do this)

### Anti-pattern 1 — Deleting a class without marking it in the CSV

```java
// class com.myapp.ObsoleteType removed from source
// storage started without a refactoring mapping
```

**Symptom.** `ClassNotFoundException` during type dictionary analysis at startup.

**Fix.** Add `com.myapp.ObsoleteType` as a discard entry in `refactorings.csv`.

### Anti-pattern 2 — Marking a class deleted while instances still live

**Symptom.** `PersistenceUnreachableTypeHandler` throws when that instance is loaded
later.

**Fix.** Before marking a class deleted:

1. Ensure nothing in the graph still references it.
2. Run full GC + file check to actually reclaim the bytes.
3. Restart cleanly. If that works, you can mark it deleted.

### Anti-pattern 3 — Editing stored binary files by hand

Don't. Type dictionary drift is the library's job.

### Anti-pattern 4 — Cross-mapping CSV entries creating ambiguity

```csv
old;current
com.myapp.A#x;com.myapp.A#y
com.myapp.A#y;com.myapp.A#x
```

**Symptom.** Undefined behaviour. The parser may accept this but the mapping
resolution is undefined.

**Fix.** Express each rename in one direction.

### Anti-pattern 5 — Expecting `PersistenceLegacyTypeMappingResultor` prompts in production

The default resultor (`LoggingLegacyTypeMappingResultor`) accepts heuristic results
and logs them. There is no interactive prompt in production. If you want stricter
behaviour (fail on unclear matches), implement a custom resultor.

### Anti-pattern 6 — Changing class names after every commit on a whim

Every change adds an entry to the dictionary. Cumulative mappings become hard to
audit. Prefer stable names.

### Anti-pattern 7 — Wrong CSV delimiter

The parser accepts semicolons and tabs. Commas will be silently treated as part of
field names and your mapping won't do what you expect. Use `;`.

## Pitfalls & gotchas

1. **Heuristic works only for same-name rough matches.** A 0.6 threshold is the rough
   minimum; lower and the heuristic discards. Fully-different names (e.g.
   `customerid` → `pin`) must be explicit.
2. **Ambiguous matches can cross.** If you rename `A.foo` → `bar` and `A.baz` →
   `foo` in the same class, heuristic may swap them. Always check logs and supply
   explicit mappings when renames collide.
3. **Discard entries are lossy.** `old;` drops the stored value forever. If you're
   unsure, keep the field under a legacy name temporarily and migrate its value in
   code before discarding.
4. **Custom legacy handlers need the full old binary offset math right.** Object
   references are stored as longs (ids); call `Binary.objectIdByteLength()` for
   portability. See the `custom-type-handlers` skill's binary-offset reference.
5. **Type ID-prefixed mappings are version-specific.** They map only one particular
   stored shape. Rarely needed; heuristic + name-based mappings cover most cases.
6. **CSV column names (`old`, `current`) are conventional but not required.** The
   parser uses column positions. Keep the header to avoid human confusion.
7. **A deleted class's type handler is `PersistenceUnreachableTypeHandler`.** It
   throws if any reachable instance is loaded. This is the "safety net" for marking
   a class dead.
8. **First-load translation cost is one-time per startup.** The compiled translators
   live for the manager's lifetime. On-load performance is effectively the same as
   current-shape loads.

## Interactions with other skills

- **`root-and-object-graph`** — evolving the root class is the most common case; the
  root is always eagerly loaded at start, so type mapping runs immediately.
- **`storing-data`** — re-storing a legacy-loaded record writes it in current
  format. Over time, legacy records naturally disappear from the dictionary when the
  housekeeping GC reclaims their bytes.
- **`custom-type-handlers`** — legacy handlers and "normal" custom handlers share
  the same Binary API and registration path. Custom legacy handlers are for old
  binary layouts; custom type handlers are for controlling current layout.
- **`housekeeping-and-deletion`** — before marking a class deleted, run GC + file
  compaction so nothing in the bytes still references it.

## Recipes

**"I renamed a field. Will it break?"** → Probably not. Start, watch the log for the
similarity score. If above ~0.6 you're fine; below, write a CSV entry.

**"I renamed a class. Will it break?"** → Yes without explicit mapping. Add a class-
level entry: `old.Fqcn;new.Fqcn`.

**"I moved a class to a different package."** → Same as rename.

**"I added a field, will old data load?"** → Yes. The new field gets the default
value (null/0/false). Re-store the record to persist the field explicitly.

**"I removed a field, will old data load?"** → Yes. The old value is discarded.

**"I changed a field type from int to long."** → Yes, auto widening.

**"I changed a field type from long to int."** → Yes, with Java cast semantics
(truncation possible).

**"I want to split `fullName` into `firstName` + `lastName`."** → Custom legacy type
handler. Field mapping can't compute derivatives.

**"How do I see what the heuristic is doing?"** → Set SLF4J logger
`org.eclipse.serializer.persistence.binary.types.LoggingLegacyTypeMappingResultor`
to INFO (or DEBUG). You'll see the mapping table per type at startup.

**"How do I find a Type ID?"** → Open `PersistenceTypeDictionary.ptd` in the storage
directory. Each class definition starts with its Type ID.

**"Can I automate CSV generation?"** → Write a small tool: diff old dictionary vs.
new class definitions. Upstream doesn't ship one; a custom
`PersistenceLegacyTypeMappingResultor` that logs a suggested CSV is a common
middle ground.

## Deeper lookups (on-demand)

- `references/api-catalogue.md` — foundation hooks, provider interfaces,
  `BinaryLegacyTypeHandler.AbstractCustom<T>` methods, related persistence API.
- `references/examples-expanded.md` — three full scenarios: heuristic run, explicit
  CSV with inheritance, custom legacy handler (70 lines).
- `references/mapping-rules-cheatsheet.md` — every CSV syntax variant with examples.
- `references/refactor-playbook.md` — step-by-step procedures for common refactors
  (rename field, rename class, delete class, split field).
- `references/pitfalls-deep-dive.md` — each pitfall above with reproducer and fix.

## Upstream sources

- `docs/modules/storage/pages/legacy-type-mapping/index.adoc` — full reference.
- `docs/modules/storage/pages/legacy-type-mapping/user-interaction.adoc` —
  interactive confirmation, custom resultors.
- `examples/custom-legacy-type-handler/` — runnable upstream example.
