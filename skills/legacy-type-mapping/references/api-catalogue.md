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

Returns a `PersistenceRefactoringMappingProvider`. Overloads accept:

- A `Path` to a CSV file.
- An inline CSV `String` (optionally with a custom value separator).
- A pre-parsed `XGettingSequence<KeyValue<String, String>>` for programmatic
  mappings (build with `X.List(X.KeyValue(old, current), …)`).

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

Interface with one default method, `createMappingResult(legacyTypeDefinition,
currentTypeHandler, explicitMappings, explicitNewMembers, matchedMembers)`. The
default delegates to the static workhorse
`PersistenceLegacyTypeMappingResultor.createLegacyTypeMappingResult(...)`. Because
the method is `default` and the interface has no abstract method, you cannot use a
lambda — supply an anonymous class (or named subtype).

The shipped logging decorator is `LoggingLegacyTypeMappingResultor`; build via
`LoggingLegacyTypeMappingResultor.New(delegate)`.

For a custom resultor (e.g. fail-the-build on low-confidence matches): implement
the interface anonymously, delegate the body to
`PersistenceLegacyTypeMappingResultor.createLegacyTypeMappingResult(...)`, and
inspect `result.currentToLegacyMembers()` for `Similarity` values below your
threshold.

## `PersistenceMemberMatchingProvider` (heuristic replacement)

Default `provideMemberMatchingSimilator(...)` returns `PersistenceMemberSimilator.New(typeSimilarity)`,
a Levenshtein-on-names plus type-similarity blend.

Custom: extend `PersistenceMemberMatchingProvider.Default` and override
`provideMemberMatchingSimilator(...)` to return your own
`Similator<PersistenceTypeDefinitionMember>`. Pass the provider via
`setLegacyMemberMatchingProvider(...)`.

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

- `CustomField(Class<?>, String)` — declare an old field for the super constructor
  (inherited from `AbstractBinaryHandlerCustom`).
- `Binary.objectIdByteLength()` — `8`, the byte size of a stored object id.
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
