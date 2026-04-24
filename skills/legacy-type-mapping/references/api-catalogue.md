# API catalogue — legacy-type-mapping

> **File paths** below are relative to the upstream source. Paths under `org/eclipse/store/…` live in [`eclipse-store/store`](https://github.com/eclipse-store/store); paths under `org/eclipse/serializer/…` live in [`eclipse-serializer/serializer`](https://github.com/eclipse-serializer/serializer). Clone the relevant repo alongside your project if you want the AI agent to resolve paths locally.

## Foundation hooks

File: `storage/embedded/.../EmbeddedStorageFoundation.java` and
`persistence/binary/.../PersistenceFoundation.java`.

| Hook | Purpose |
|---|---|
| `foundation.setRefactoringMappingProvider(provider)` | Supplies the explicit CSV mapping. |
| `foundation.onConnectionFoundation(cf -> cf.setLegacyMemberMatchingProvider(...))` | Replace the heuristic. |
| `foundation.onConnectionFoundation(cf -> cf.setLegacyTypeMappingResultor(...))` | Intercept the final mapping (e.g., fail on ambiguity). |
| `foundation.onConnectionFoundation(cf -> cf.getCustomTypeHandlerRegistry().registerLegacyTypeHandler(handler))` | Register a custom legacy type handler. |

## `Persistence.RefactoringMapping`

Factory:

```java
Persistence.RefactoringMapping(Paths.get("refactorings.csv"))
```

Returns a `PersistenceRefactoringMappingProvider`. Accepts:

- A `Path` to a CSV.
- An in-memory map for programmatic mappings.

## CSV format

| Syntax | Meaning |
|---|---|
| `old;current` | Map. |
| `old;` | Discard (delete). |
| `;current` | Declare new (heuristic hint). |
| `com.x.Class` | Class-level identifier. |
| `com.x.Class#field` | Field. |
| `com.x.Class#com.x.Declaring#field` | Field with declaring class. |
| `1012345:com.x.Class[#field]` | Version-specific identifier. |

Delimiters: `;` or `\t`. Header row optional (conventional `old` / `current`).

## `PersistenceLegacyTypeMappingResultor`

Default: `LoggingLegacyTypeMappingResultor` — accepts, logs at INFO.

Custom example — fail on low-confidence matches:

```java
foundation.onConnectionFoundation(f -> f.setLegacyTypeMappingResultor(
    (analysis, currentType) -> {
        if (analysis.memberMappings().values().stream()
                .anyMatch(m -> m.similarity() < 0.5)) {
            throw new IllegalStateException("Ambiguous legacy mapping for " + currentType);
        }
        return LoggingLegacyTypeMappingResultor.Instance.accept(analysis, currentType);
    }
));
```

## `PersistenceMemberSimilator` (heuristic replacement)

Default is Levenshtein distance on field names with type-compatibility filter.

Custom: implement and pass via `setLegacyMemberMatchingProvider(...)`.

Typical customizations:

- Annotation-based (`@MappedFrom("oldName")` → 1.0 similarity).
- Domain naming rules (`prefix match` → boost similarity).
- Stricter/looser threshold.

## `BinaryLegacyTypeHandler.AbstractCustom<T>`

Base class for custom legacy handlers. Subclass contract:

| Method | Must do |
|---|---|
| Constructor | Call `super(currentClass, oldFieldList)` where `oldFieldList` describes the **old** binary layout. |
| `T create(Binary, PersistenceLoadHandler)` | Instantiate an empty current-type object. |
| `void updateState(Binary, T, PersistenceLoadHandler)` | Read old binary fields, populate current-type instance. |
| `void iterateLoadableReferences(Binary, PersistenceReferenceLoader)` | Report every old-format reference id so the loader resolves it. |
| `boolean hasPersistedReferences()` | True if the old layout contained any object references. |
| `boolean hasVaryingPersistedLengthInstances()` | False for fixed-size old layouts. |

Helper fields used in examples:

- `CustomField(Class<?>, String)` — declare an old field for the super constructor.
- `Binary.objectIdByteLength()` — 8 (a long).
- `bytes.read_long(offset)` — read the object id of a referenced object.
- `handler.lookupObject(id)` — resolve the object from the load handler.

## `PersistenceUnreachableTypeHandler`

Created automatically for discard-mapped classes. Throws at runtime if a reachable
instance of that type is loaded — the safety net for "deleted" classes.

## `PersistenceTypeDictionary.ptd`

Human-readable file in the storage directory. Each block:

```
1000055:com.myapp.Customer
{
    +String customerid
    +String firstname
    ...
}
```

The leading number is the Type ID. The `+` marks fields. Useful when writing CSV
entries that need a specific Type ID.

## Related exceptions

- `org.eclipse.serializer.persistence.exceptions.PersistenceException` — generic.
- `PersistenceExceptionTypeConsistency` — type dictionary contradicts current
  classes and no mapping resolves it.
- `PersistenceExceptionTypeHandlerConsistency` — a handler doesn't match its type.
