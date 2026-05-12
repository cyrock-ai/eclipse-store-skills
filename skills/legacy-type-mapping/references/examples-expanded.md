# Examples-expanded — legacy-type-mapping

## Example 1 — Heuristic handles the rename

Old:

```java
public class Contact {
    String name; String firstname; int age;
    String email; String note; Object link;
}
```

New:

```java
public class Contact {
    String firstname; String lastname; String emailAddress;
    String supportNote; PostalAddress postalAddress; int age;
}
```

No configuration. Start the app and watch the log:

```
java.lang.String Contact#firstname     -1.000 ----> java.lang.String Contact#firstname
java.lang.String Contact#name          -0.750 ----> java.lang.String Contact#lastname
java.lang.String Contact#email         -0.708 ----> java.lang.String Contact#emailAddress
java.lang.String Contact#note          -0.636 ----> java.lang.String Contact#supportNote
[***new***] PostalAddress Contact#postalAddress
int Contact#age                        -1.000 ----> int Contact#age
java.lang.Object Contact#link [discarded]
```

Five matches, one new field, one discard. All automatic.

## Example 2 — Heuristic guesses wrong, fix with CSV

Old:

```java
public class Customer {
    int customerid; String firstname;
    String surname; String comment;
}
```

New:

```java
public class Customer {
    Integer pin; String firstName;
    String lastName; String commerceId;
    Address address;
}
```

Default heuristic maps `comment` → `commerceId` (0.75 similarity — wrong) and
discards `customerid` (too different from `pin`).

Fix — `refactorings.csv`:

```csv
old;current
com.myapp.Customer#customerid;com.myapp.Customer#pin
com.myapp.Customer#comment;
;com.myapp.Customer#commerceId
```

Wire (semicolon-separated content via inline overload — see SKILL.md "Explicit
mapping via CSV" for the file-extension/separator rule):

```java
EmbeddedStorageFoundation<?> foundation = EmbeddedStorage.Foundation(dataDir);
foundation.setRefactoringMappingProvider(
    Persistence.RefactoringMapping(
        Files.readString(Paths.get("refactorings.csv")),
        ';'
    )
);
EmbeddedStorageManager storage =
    foundation.createEmbeddedStorageManager(root);
storage.start();
```

Now:

- `customerid` → `pin` (explicit).
- `firstname` → `firstName` (heuristic, 0.944).
- `surname` → `lastName` (heuristic, 0.688).
- `comment` discarded (explicit).
- `commerceId`, `address` declared new.
- `int` → `Integer` autoboxed (values preserved).

## Example 3 — Custom legacy type handler (field split)

Old:

```java
public class NicePlace {
    String name;
    String directions;  // "Turn left at Main St, 48.137, 11.576"
}
```

New:

```java
public class NicePlace {
    String name;
    Location location;
}
public class Location {
    String directions;
    double latitude;
    double longitude;
}
```

Handler:

```java
package app.migration;

import java.util.List;

import org.eclipse.serializer.util.X;
import org.eclipse.serializer.persistence.binary.types.Binary;
import org.eclipse.serializer.persistence.binary.types.BinaryLegacyTypeHandler;
import org.eclipse.serializer.persistence.types.PersistenceLoadHandler;
import org.eclipse.serializer.persistence.types.PersistenceReferenceLoader;

public class LegacyTypeHandlerNicePlace
    extends BinaryLegacyTypeHandler.AbstractCustom<NicePlace> {

    // Old binary layout: two object-id references (Strings)
    private static final long
        OFFSET_name       = 0,
        OFFSET_directions = OFFSET_name + Binary.objectIdByteLength();

    public LegacyTypeHandlerNicePlace() {
        super(
            NicePlace.class,
            X.List(
                CustomField(String.class, "name"),
                CustomField(String.class, "directions")
            )
        );
    }

    @Override
    public NicePlace create(Binary bytes, PersistenceLoadHandler lh) {
        return new NicePlace();
    }

    @Override
    public void updateState(Binary bytes, NicePlace inst, PersistenceLoadHandler lh) {
        String name       = (String) lh.lookupObject(bytes.read_long(OFFSET_name));
        String directions = (String) lh.lookupObject(bytes.read_long(OFFSET_directions));

        inst.name     = name;
        inst.location = new Location(directions, 0.0, 0.0);
    }

    @Override
    public void iterateLoadableReferences(Binary bytes, PersistenceReferenceLoader it) {
        it.acceptObjectId(bytes.read_long(OFFSET_name));
        it.acceptObjectId(bytes.read_long(OFFSET_directions));
    }

    @Override public boolean hasPersistedReferences()                   { return true; }
    @Override public boolean hasVaryingPersistedLengthInstances()       { return false; }
}
```

Register:

```java
EmbeddedStorageManager storage = EmbeddedStorage.Foundation(dataDir)
    .onConnectionFoundation(f ->
        f.getCustomTypeHandlerRegistry()
            .registerLegacyTypeHandler(new LegacyTypeHandlerNicePlace())
    )
    .start(root);
```

On load, old NicePlace binaries flow through this handler. On next re-store the
record lands in the current format (plain type handler takes over).

## Example 4 — Delete a class end-to-end

Goal: remove `com.myapp.ObsoleteType`.

```java
// 1. Remove all references in domain code
root.services().removeIf(s -> s instanceof ObsoleteType);
storage.store(root.services());

// 2. Force cleanup so the bytes are gone
storage.issueFullGarbageCollection();
storage.issueFullFileCheck();

// 3. Shut down
storage.shutdown();
```

Add `refactorings.csv`:

```csv
old;current
com.myapp.ObsoleteType
```

Delete the source file for `ObsoleteType`.

Restart. If everything is clean, the type dictionary still has an entry (until the
next rewrite) but no instance is loaded through it; `PersistenceUnreachableTypeHandler`
is installed as a guard.

## Example 5 — Custom heuristic via annotation

```java
public @interface MappedFrom { String value(); }

public class Customer {
    @MappedFrom("customerid") private Integer pin;
    @MappedFrom("firstname")  private String firstName;
    private String lastName;   // heuristic handles this
    private Address address;   // new
}
```

Implement a `Similator<PersistenceTypeDefinitionMember>` that returns `1.0` for
pairs matched by `@MappedFrom`, else falls back to Levenshtein. Plug it in by
extending `PersistenceMemberMatchingProvider.Default` and overriding
`provideMemberMatchingSimilator(...)`:

```java
foundation.onConnectionFoundation(f -> f.setLegacyMemberMatchingProvider(
    new PersistenceMemberMatchingProvider.Default() {
        @Override
        public Similator<PersistenceTypeDefinitionMember> provideMemberMatchingSimilator(
            final TypeMappingLookup<Float> typeSimilarity
        ) {
            return new AnnotationAwareSimilator(typeSimilarity);
        }
    }
));
```

Upside: renames are expressed in Java code, not a CSV — they sit next to the field
they describe. Downside: you own and test a custom similator.
