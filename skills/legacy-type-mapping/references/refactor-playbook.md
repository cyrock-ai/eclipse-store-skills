# Refactor playbook — legacy-type-mapping

Step-by-step procedures for every common class-evolution move.

## Rename a field

1. Change the source: `String name;` → `String lastname;`.
2. Start the app. Scan the log for the similarity score:

   ```
   java.lang.String Contact#name -0.750 ----> java.lang.String Contact#lastname
   ```

3. If above ~0.6, done.
4. If below, add to `refactorings.csv`:

   ```csv
   old;current
   com.myapp.Contact#name;com.myapp.Contact#lastname
   ```

5. Ensure `foundation.setRefactoringMappingProvider(...)` points to the CSV.
6. Restart.

## Rename a class

1. Change source: `com.myapp.v1.Customer` → `com.myapp.Customer`.
2. Add class-level entry:

   ```csv
   old;current
   com.myapp.v1.Customer;com.myapp.Customer
   ```

3. Fields usually follow automatically (heuristic on same-name fields). Add per-field
   entries only for the ones that would mis-map.

## Move a class to a different package

Same as rename. Use the fully qualified names.

## Add a field

No action needed. Heuristic recognizes it as new; stored records load with the
default value (null / 0 / false). When you re-store a loaded record, the new field is
persisted.

If you want to ensure the heuristic treats it as new (not accidentally mapped from a
discarded old field with a similar name):

```csv
old;current
;com.myapp.Order#trackingNumber
```

## Remove a field

Works automatically — old values are discarded. If you want to be explicit (or the
heuristic keeps trying to re-map it):

```csv
old;current
com.myapp.Order#legacyNotes;
```

## Change a primitive type

- Widen (`int` → `long`): lossless, automatic.
- Narrow (`long` → `int`): automatic with Java cast truncation.
- Primitive → wrapper: autoboxing.
- Wrapper → primitive: autoboxing; `null` becomes `0`/`0.0`/`false`.

No CSV needed.

## Split one field into multiple (compute derived value)

Heuristic can't. Custom legacy type handler:

1. Implement `BinaryLegacyTypeHandler.AbstractCustom<T>` (see
   `examples-expanded.md`).
2. Register on the foundation:

   ```java
   foundation.onConnectionFoundation(f ->
       f.getCustomTypeHandlerRegistry().registerLegacyTypeHandler(handler)
   );
   ```

3. The handler reads the old binary layout, computes the new field(s), writes into
   the current-type instance.

## Delete a class

Most dangerous operation. Procedure:

1. In the domain code, remove every reference to the class (collections, fields,
   static references).
2. Store the modified parents so the graph no longer references any instance.
3. Run full housekeeping to reclaim the bytes:

   ```java
   storage.issueFullGarbageCollection();
   storage.issueFullFileCheck();
   ```

4. Shut down, restart. Confirm no errors.
5. Now add to `refactorings.csv`:

   ```csv
   old;current
   com.myapp.ObsoleteType
   ```

6. Delete the class from the source.
7. Restart. If there's still a reachable instance somewhere you missed,
   `PersistenceUnreachableTypeHandler` throws. Find it and restart the procedure.

Only then is the class truly gone.

## Retype a field from custom class to another custom class

Example: `Address address` → `PostalAddress address`.

If the old `Address` is still on the classpath, Eclipse Store needs a type-compatible
mapping — just a field mapping isn't enough because the value classes differ. Options:

1. Keep the old class, convert values in code post-load.
2. Write a custom legacy handler for the owning type that reads the old `Address`
   binary and constructs a `PostalAddress`.
3. Step-migrate: first release adds `PostalAddress`, populates from `Address`
   post-load. Second release removes `Address` (with discard mapping).

Option 3 is the safest real-world choice.

## Recover from a botched mapping

Symptoms: data loads "wrong" (values appear in unexpected fields, or appear null).

1. Stop the app immediately.
2. Restore from backup (you have one, right?).
3. Inspect `PersistenceTypeDictionary.ptd` and correct the CSV.
4. Restart against the restored backup.

Eclipse Store does not automatically recover from incorrect mappings — it believes
what you told it.

## Observation-only mode

When planning a refactor, deploy the new code against a copy of production data with
a custom `PersistenceLegacyTypeMappingResultor` that logs the proposed mapping (or
inspects `result.currentToLegacyMembers()`) and throws to abort startup. Inspect the
log, write the CSV, deploy for real. See `api-catalogue.md` for the interface
signature — the method is `default` so a lambda will not compile, supply an
anonymous class.
