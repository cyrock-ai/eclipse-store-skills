# Mapping rules cheatsheet

All the CSV forms and their effects.

## Basic forms

```csv
old;current
com.x.A;com.x.B                          # rename/move class A → B
com.x.A#oldField;com.x.A#newField        # rename field
com.x.A#oldField;                        # delete field (discard)
;com.x.A#newField                        # declare new (prevent heuristic matches)
com.x.A                                  # delete class (all instances must be unreachable)
```

## Inheritance disambiguation

```csv
com.x.Child#com.x.Parent#field;com.x.Child#com.x.Parent#newField
```

Use `OwningClass#DeclaringClass#field` only when multiple fields with the same
simple name exist in the class hierarchy.

## Type-ID-scoped

```csv
1012345:com.x.A;com.x.A                        # only the version with Type ID 1012345
1012345:com.x.A#field;com.x.A#differentField   # field on a specific class version
```

Look up Type IDs in `PersistenceTypeDictionary.ptd`.

## Delimiters & whitespace

- File-based parsing (`Persistence.RefactoringMapping(Path)`) picks the separator
  from the **file extension** via `XCsvDataType`:
  - `.csv` → `,` preferred (highest weight 1.3, then `;` 1.2, tab 1.1).
  - `.tsv` / `.xcsv` → tab preferred (1.3, then `;` 1.2, `,` 1.1).
  There is **no fallback** if content doesn't use the preferred separator: every
  line parses as one column and dictionary analysis fails with
  `ArrayIndexOutOfBoundsException`.
- Inline-string parsing — `Persistence.RefactoringMapping(String)` defaults to the
  XCSV separator (`\t`). To use `;` (or any other) inline, pass it explicitly:
  `Persistence.RefactoringMapping(csv, ';')`.
- To use `;` with a file, read the file yourself:
  `Persistence.RefactoringMapping(Files.readString(path), ';')`.
- `,` works for `.csv` files (it is the preferred separator). Avoid `,` if any
  field name might contain a comma.
- Leading/trailing whitespace on each cell is trimmed.
- Blank lines are ignored.
- Header row is conventional but not required (parser uses column position).

## Cross-class field mapping

If a field moves from one class to another:

```csv
com.x.OldOwner#field;com.x.NewOwner#field
```

This requires that the heuristic or explicit class mapping can bridge the old
`OldOwner` → `NewOwner`. If `OldOwner` still exists but is not the owner anymore,
you need a custom legacy type handler.

## Multiple forms in one file

Mix freely. Example:

```csv
old;current
# Class rename
com.myapp.v1.Order;com.myapp.Order

# Field renames
com.myapp.Order#customerid;com.myapp.Order#pin
com.myapp.Order#firstname;com.myapp.Order#firstName

# Field discards
com.myapp.Order#legacyNotes;
com.myapp.Order#deprecatedFlag;

# Declare new
;com.myapp.Order#trackingNumber
;com.myapp.Order#createdAt

# Class delete
com.myapp.ObsoleteType
```

Eclipse Store processes each line in sequence; order within the file doesn't affect
semantics.

## Mapping constraints

- A field can be mapped by at most one rule.
- A discard entry for a field overrides any heuristic match.
- A `;newField` entry excludes `newField` from heuristic matching against any old
  field.
- Class-level mappings cascade to fields that share simple names between old and
  new class; unmatched fields on the old class are discarded (use explicit entries
  if this is wrong for you).

## Parsing errors

- Missing column or malformed line → `PersistenceException` at startup; the file
  name and line number are in the message.
- Reference to a class or field that doesn't exist → lazy error: the dictionary
  analysis ignores unresolved entries and logs a warning, then falls back to
  heuristic for that type. Double-check FQCNs.

## Best practice

- Keep `refactorings.csv` under version control alongside the source.
- One commit per refactor: source change + CSV update + deployment note.
- Test in a staging environment before touching production data.
- Back up the data directory before any non-trivial CSV change.
