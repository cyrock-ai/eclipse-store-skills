# Pitfalls deep-dive — legacy-type-mapping

## 1. `ClassNotFoundException` after deleting a class

**Reproducer.** Remove `com.myapp.ObsoleteType`; restart. Startup throws.

**Root cause.** Type dictionary contains `ObsoleteType`; no mapping says "this is
gone".

**Fix.** Add discard entry to `refactorings.csv`:

```csv
old;current
com.myapp.ObsoleteType
```

## 2. `PersistenceUnreachableTypeHandler` throws on load

**Reproducer.** Marked a class deleted in CSV; some instance is still reachable in
the graph.

**Symptom.** Runtime exception when that instance loads (not at startup).

**Root cause.** The "deleted" class's type handler throws if any instance actually
needs to be loaded.

**Fix.** Revert the CSV delete, find the remaining reference, remove it, store the
parent, run full GC + file check, restart without the CSV entry, verify clean, then
re-add the delete entry.

## 3. Heuristic crosses two renames

**Reproducer.**

```java
// old
String alpha; String beta;
// new
String beta; String alpha;  // swapped!
```

**Symptom.** On load, data appears in the wrong field with no error.

**Root cause.** Levenshtein distance gives both fields a best match against their
same-name counterpart in the other slot.

**Fix.** Explicit CSV entries for both:

```csv
old;current
com.myapp.X#alpha;com.myapp.X#beta
com.myapp.X#beta;com.myapp.X#alpha
```

Eclipse Store processes explicit mappings first; the heuristic won't re-map them.

## 4. File extension and separator mismatch silently breaks parsing

```csv
# saved as refactorings.csv but content uses ';'
old;current
com.x.A#a;com.x.A#b
```

**Symptom.** Startup fails with `ArrayIndexOutOfBoundsException: Index 1 out of
bounds for length 1` during dictionary analysis.

**Root cause.** `Persistence.RefactoringMapping(Path)` picks the separator from
the file extension via `XCsvDataType`: `.csv` prefers `,`, `.tsv`/`.xcsv` prefer
`\t`. There is no auto-detect fallback — every line parses as one column when
content doesn't use the preferred separator.

**Fix.** Either align the extension with the content (rename to `.tsv` and use
tabs, or keep `.csv` and use commas), or read the file yourself and supply the
separator explicitly:

```java
Persistence.RefactoringMapping(
    Files.readString(Paths.get("refactorings.csv")),
    ';'
);
```

## 5. CSV path not resolved at runtime

**Reproducer.**

```java
foundation.setRefactoringMappingProvider(
    Persistence.RefactoringMapping(Paths.get("refactorings.csv"))
);
```

…and running in a JAR with the CSV inside `src/main/resources`.

**Symptom.** `NoSuchFileException` at startup.

**Root cause.** `Paths.get("refactorings.csv")` is a working-directory path, not a
classpath resource.

**Fix.** Either extract the CSV to a runtime location, or supply the mapping
programmatically. `PersistenceRefactoringMappingProvider.New(...)` accepts an
`Iterable<KeyValue<String, String>>` (use `X.List(X.KeyValue(old, current), …)`),
not a `Map`:

```java
foundation.setRefactoringMappingProvider(
    PersistenceRefactoringMappingProvider.New(
        X.List(
            X.KeyValue("com.myapp.Customer#customerid", "com.myapp.Customer#pin")
        )
    )
);
```

Alternatively, feed an inline CSV string. Note: the single-arg
`Persistence.RefactoringMapping(String)` parses with the default XCSV separator
(`\t`). For semicolon-delimited inline content use the explicit-separator overload:

```java
Persistence.RefactoringMapping(
    "old;current\n"
    + "com.myapp.Customer#customerid;com.myapp.Customer#pin\n",
    ';'
);
```

## 6. Class-level mapping but field names also changed

**Reproducer.**

```csv
old;current
com.myapp.v1.Order;com.myapp.Order
```

…and `v1.Order` has `orderNr` field that became `orderNumber` in `Order`.

**Symptom.** Field heuristic runs on the old `orderNr` vs. new `orderNumber` — may
succeed (0.75+), but if it does not, `orderNr` is discarded.

**Fix.** Add an explicit field mapping:

```csv
com.myapp.v1.Order;com.myapp.Order
com.myapp.v1.Order#orderNr;com.myapp.Order#orderNumber
```

## 7. Changing a primitive to a custom class

**Reproducer.**

```java
// old
int amount;
// new
Money amount;
```

**Symptom.** Eclipse Store tries to match the types and fails — primitive → custom
class is not an automatic conversion.

**Fix.** Custom legacy type handler. Read the old `int`, wrap in `new Money(...)` in
`updateState(...)`.

## 8. Mapping a field to a different owning class via CSV

```csv
old;current
com.myapp.OldOwner#field;com.myapp.NewOwner#field
```

**Symptom.** Silently ignored or throws "no owning class mapping".

**Root cause.** Field-level mapping between different classes assumes the class
mapping is also defined.

**Fix.** Add class mapping too, or use a custom legacy handler to reshape the data.

## 9. Multiple stored versions of the same class

**Reproducer.** The class structure has changed several times during development;
`PersistenceTypeDictionary.ptd` has three Type IDs for `com.myapp.Order`.

**Symptom.** CSV entry `com.myapp.Order#old;com.myapp.Order#new` applies to all
versions — may be wrong.

**Fix.** Scope the mapping:

```csv
1012345:com.myapp.Order#old;com.myapp.Order#new
1012348:com.myapp.Order#old;com.myapp.Order#differentNew
```

## 10. Heuristic produces a low similarity — is 0.6 enough?

The default threshold is not strictly 0.6; Eclipse Store tries to pick the best
available match per field. A 0.5 match beats nothing. If you're uncertain:

1. Log the mapping (default resultor does this).
2. If the score feels low, supply the explicit mapping.
3. Or tighten the resultor to refuse matches below 0.7.

## 11. Forgetting to back up before a big schema evolution

If the mapping is wrong, loaded data goes into the wrong fields silently — no
error, just incorrect application behaviour.

**Fix.** Before a non-trivial schema change:

1. Stop the service.
2. Copy the data directory.
3. Make the change, restart, test.
4. If wrong, restore from the copy.

## 12. `PersistenceTypeDictionary.ptd` handcrafted

Users sometimes edit the dictionary file to "speed up" schema evolution.

**Symptom.** Storage corruption on next startup.

**Root cause.** The dictionary file is parsed strictly; manual edits break checksums
and offsets.

**Fix.** Always use refactoring mappings / custom legacy handlers. Never edit
`PersistenceTypeDictionary.ptd` by hand.
