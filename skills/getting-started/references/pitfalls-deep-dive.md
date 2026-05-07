# Pitfalls deep-dive — getting-started

Each entry: minimal reproducer → symptom → root cause → fix.

## 1. Assuming `shutdown()` is mandatory

**Reproducer.** The application runs fine. The developer reads "best practice to call
shutdown" in a blog, wraps `EmbeddedStorageManager` in try-with-resources inside
`main()`, and reports that shutdown "takes ages" or "hangs".

**Symptom.** Slow process exit (shutdown waits for managing threads to finish flushing),
or a warning that housekeeping was interrupted.

**Root cause.** `shutdown()` stops the managing threads and releases file locks. For an
application that's exiting anyway, this work is redundant — `System.exit(0)` tears
everything down and the next `.start()` recovers cleanly from any partial write.

**Fix.** Omit `shutdown()` in `main()`. Use it in tests, in tools that need to re-open
the database under a different configuration, or when explicit lock release is required.

## 2. Creating a new root instance and expecting persisted data to appear on it

**Reproducer.**

```java
DataRoot root = new DataRoot();
EmbeddedStorageManager s = EmbeddedStorage.start(root, Paths.get("data"));
// ... expect root.entries() to contain persisted data ...
```

**Symptom.** Works on first run (fresh database). On second run the developer sees an
empty list and concludes storage is broken.

**Root cause.** The confusion is about where the loaded state ends up. Eclipse Store
**populates the passed instance in place** by reconstructing its fields from binary
data. If your `DataRoot` has a `final List<String> entries = new ArrayList<>();`, then:

- first run: the list stays the empty ArrayList you constructed; you mutate and store
  it.
- second run: the list field is **replaced** with the loaded one. The instance you
  constructed still has it attached; you just have to access it via the object that
  came back.

If the fields are not reachable from the root (e.g., they're on an inner object that
the store never saw), they won't be populated.

**Fix.** Always read back from `storage.root()` after `start()`, or from your root
reference — they are the same object. Do not read from fields you captured before
`start()`.

```java
DataRoot root = new DataRoot();
EmbeddedStorageManager s = EmbeddedStorage.start(root, Paths.get("data"));
DataRoot loaded = (DataRoot) s.root();   // or just use `root` — identical
loaded.entries().forEach(System.out::println);
```

## 3. Pointing two managers at the same directory

**Reproducer.**

```java
EmbeddedStorageManager a = EmbeddedStorage.start(r1, Paths.get("data"));
EmbeddedStorageManager b = EmbeddedStorage.start(r2, Paths.get("data"));
```

**Symptom.** Second `.start()` throws, typically a lock file / access violation.

**Root cause.** Eclipse Store places an exclusive lock file (`used.lock`) in the storage
directory on `start()`. One live manager per directory is the hard rule.

**Fix.** Either use one manager (two application services share it) or two directories.
If the user actually wants read-replica semantics, they need to copy the directory
offline and open the copy — Eclipse Store does not have read-replicas built in.

## 4. Reusing a foundation after `.start()`

**Reproducer.**

```java
var foundation = EmbeddedStorage.Foundation(config);
var m1 = foundation.start(r1);
var m2 = foundation.start(r2);
```

**Symptom.** `m2` may appear to work, but type-handler registrations or other
foundation state bleed in surprising ways.

**Root cause.** `EmbeddedStorageFoundation` is a one-shot builder. Internals are
consumed by `.start()`.

**Fix.** Build a new foundation per manager.

## 5. Registering a custom type handler after start

**Reproducer.**

```java
var m = EmbeddedStorage.start(root, dir);
// try to find a hook to add a handler ... there isn't one
```

**Symptom.** No compilable path; developer hacks around via reflection and things break.

**Root cause.** By design. Once the persistence manager is active, the type dictionary
is locked. Registering handlers mid-run would invalidate already-stored objects.

**Fix.** Use the foundation pattern (Pattern B). Register all custom handlers on the
connection foundation before `.start()`. See the `custom-type-handlers` skill.

## 6. Confusing "storage directory" with "working directory"

**Reproducer.** Developer writes `EmbeddedStorage.start(root, Paths.get("data"))`,
launches from an IDE where the working directory is the project root; launches in
production where the working directory is `/`; loses the database.

**Symptom.** `data/` appears somewhere unexpected; data "vanishes" between
environments.

**Root cause.** `Paths.get("data")` is relative to the JVM working directory.

**Fix.** Always pass an absolute path, or resolve relative to a known anchor:

```java
Path dir = Path.of(System.getProperty("app.data.dir", "data")).toAbsolutePath();
EmbeddedStorage.start(root, dir);
```

For production, wire the directory through configuration (the `configuration` skill has
this covered).

## 7. Expecting `start()` to migrate schema automatically from an older binary format

**Reproducer.** Class structure changed (field added/renamed); `.start()` reports a
mismatch or prompts interactively.

**Symptom.** `PersistenceException: Unmatched type dictionary` or similar.

**Root cause.** Eclipse Store detects class-definition drift on load. Simple
reshuffles / renames within one field are auto-handled; class renames and removals
require explicit mapping.

**Fix.** See the `legacy-type-mapping` skill. This is outside the scope of
getting-started but comes up within the first few iterations of real development.

## 8. Running on the module path without legacy-classpath resolution

**Reproducer.** A modular Spring Boot app with Eclipse Store on the module path hits a
`ServiceConfigurationError` or `LayerInstantiationException` at startup.

**Symptom.** Startup fails before any Eclipse Store code runs.

**Root cause.** Some Eclipse Store dependencies are classpath-only (no
`module-info.java`).

**Fix.** Simplest: run on the classpath (Spring Boot's default). If you must use the
module path, add the relevant `automatic-module-name` kludges in
`META-INF/MANIFEST.MF` or wait for upstream module support.

## 9. Lock file left behind after a crash

**Reproducer.** Developer kills `-9` the process. Next start throws about a lock.

**Symptom.** `StorageException` at startup referring to the lock file.

**Root cause.** Typically not an actual crash recovery problem — Eclipse Store can and
will recover. What you're seeing is that another JVM instance is actually still running,
or file system state is stale (NFS without lock support, a container volume that
re-mounted).

**Fix.** Check for stray JVMs holding the lock; on cloud file systems verify advisory
locks work. As a last resort and **only if no other JVM is running**, delete
`used.lock` and re-start. Do not script this into normal operations.
