# Pitfalls deep-dive — spring-boot

## 1. `@Transactional` has no effect

**Reproducer.**

```java
@Service
public class CustomerService {
    @Transactional
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        // no store() call
    }
}
```

**Symptom.** Customer not persisted; no error.

**Root cause.** `@Transactional` manages JDBC transactions (via a
`PlatformTransactionManager`). Eclipse Store isn't a JDBC resource.

**Fix.** Call `storage.store(root.customers())` yourself.

## 2. Missing public no-arg constructor on root class

**Reproducer.**

```java
public class AppRoot {
    public AppRoot(String tenant) { ... }   // no no-arg constructor
}
```

**Symptom.** Spring startup fails: no suitable constructor.

**Fix.** Add `public AppRoot() {}`.

## 3. Missing `spring-boot-starter-aop`

**Reproducer.**

```java
@Write public void add(Customer c) { ... }
```

…without `spring-boot-starter-aop`.

**Symptom.** No compile error. No locking at runtime. Concurrent access
corrupts data.

**Fix.** Add:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

## 4. `@Write` on a method that also does `@Transactional`

The combined proxy chain is confusing and sometimes doesn't behave as either
alone. Behaviour depends on Spring's aspect ordering.

**Fix.** Drop `@Transactional` on Eclipse-Store-only methods.

## 5. Injecting the root into a service's constructor as `AppRoot` directly

Might work because the starter sometimes auto-publishes the root bean under its
class name. Might not, if the starter changes or you have multiple roots.

**Fix.** Inject `EmbeddedStorageManager` and cast `.root()`:

```java
public CustomerService(EmbeddedStorageManager s) {
    this.root = (AppRoot) s.root();
}
```

## 6. Spring Boot test pollutes storage across tests

**Reproducer.** `@SpringBootTest` caches the context across test classes; same
storage directory reused → state leaks.

**Fix.** `@DirtiesContext` between tests, or use `@DynamicPropertySource` to
give each test a fresh temp dir.

## 7. Long `@Write` method blocks the app

**Reproducer.**

```java
@Write
public void importHugeFile(File f) {
    // 30 minutes
}
```

**Fix.** Parse offline; mutate briefly under `@Write`:

```java
public void importHugeFile(File f) {
    List<Customer> parsed = parse(f);
    applyBatch(parsed);
}

@Write
private void applyBatch(List<Customer> batch) {
    batch.forEach(c -> root.customers().put(c.email(), c));
    storage.store(root.customers());
}
```

## 8. Multiple `EmbeddedStorageManager` beans with the same directory

**Reproducer.** Second `@Bean` without disabling the default.

**Symptom.** Startup fails: lock conflict.

**Fix.** `org.eclipse.store.auto-create-default-storage=false` + explicitly
define each manager with distinct directories.

## 9. Cloud storage credentials wired correctly in dev, not in prod

**Reproducer.** Dev properties work; prod has IAM role set up but
`credentials.type=static` in the properties.

**Symptom.** Prod fails to start; static credentials wrong or absent.

**Fix.** `credentials.type=default` in prod; rely on the SDK's default chain
(env vars, IAM role, etc.).

## 10. `@Write` inside `@Read` deadlock

**Reproducer.**

```java
@Read public void analyze() { computeAndPersist(); }

@Write public void computeAndPersist() { ... }  // called from within analyze()
```

**Symptom.** Thread re-entering with an upgraded lock request. Depending on
`ReentrantReadWriteLock` behaviour, can throw or deadlock.

**Fix.** Don't nest read→write. Split into two public methods, one of each
kind, called from the outside.

## 11. GigaMap inside the Spring Boot app — wrong store path

```java
@Write
public void add(Person p) {
    root.people().add(p);
    storage.store(root.people());   // WRONG — no lock on the map
}
```

**Fix.**

```java
@Write
public void add(Person p) {
    root.people().add(p);
    root.people().store();   // GigaMap's own store()
}
```

## 12. REST console exposed publicly

```properties
org.eclipse.store.rest.enabled=true
```

…without securing the endpoint in Spring Security.

**Symptom.** Anyone on the internet can browse your data.

**Fix.** `HttpSecurity` config to require auth on the console path, or behind
an internal-only network.

## 13. Relaxed binding camelCase vs. kebab-case

Mixing styles within one properties file:

```properties
org.eclipse.store.storage-directory=data
org.eclipse.store.channelCount=2      # works, but inconsistent
```

Harmless but hard to audit. Pick one per file.
