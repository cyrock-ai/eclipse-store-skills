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

## 2. Missing accessible no-arg constructor — only on the property-driven path

**Reproducer.**

```properties
org.eclipse.store.root=com.example.AppRoot
```

```java
public class AppRoot {
    public AppRoot(String tenant) { ... }   // no no-arg constructor
}
```

**Symptom.** Startup fails wrapped as
`RuntimeException: Failed to instantiate storage root: class com.example.AppRoot`.

**Root cause.** `EmbeddedStorageFoundationFactory.createNewRootInstance` runs
`rootClass.getDeclaredConstructor().newInstance()` whenever the property is
set. No accessible no-arg constructor → reflection fails.

**Fix.** Two options:

- Add `public AppRoot() {}` to the root class.
- Drop the `org.eclipse.store.root` property and build the manager yourself
  (Pattern D in SKILL.md). With manual wiring you instantiate the root with
  any constructor and call `foundation.setRoot(...)` directly.

Eclipse Store itself never needs the no-arg constructor — it instantiates via
low-level memory allocation, not reflection.

## 3. Missing `spring-boot-starter-aop`

**Reproducer.**

```java
@Write public void add(Customer c) { ... }
```

…without `spring-boot-starter-aop`.

**Symptom.** No compile error. No locking at runtime. Concurrent access
corrupts data. Nothing in the startup log warns about it (`LockAspect` has no
warn log on missing AOP).

**Root cause.** The starter pulls `aspectjweaver` as a compile dep, so the
`AspectJCondition` on `LockAspect` is satisfied and the bean *is* registered.
What's still missing is `spring-aop` (transitively from
`spring-boot-starter-aop`), which Spring Boot's `AopAutoConfiguration` needs
(`@ConditionalOnClass(org.aopalliance.aop.Advice.class)`) to enable
`@EnableAspectJAutoProxy`. Without it, `@Aspect` beans never proxy your
methods.

**Fix.** Add the starter:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

**Verify it works.** `LockAspect` emits TRACE-level events for every call. Turn
the level up:

```properties
logging.level.org.eclipse.store.integrations.spring.boot.types.concurrent.LockAspect=TRACE
```

Call any `@Read`/`@Write` method and watch for entries like:

```
TRACE ... LockAspect : Found method lock annotation for lock: orders
TRACE ... LockAspect : write lock
TRACE ... LockAspect : write unlock
```

If these never appear, the aspect isn't being applied — re-check the AOP
dependency.

## 4. `@Write` on a method that also does `@Transactional`

The combined proxy chain is confusing and sometimes doesn't behave as either
alone. Behaviour depends on Spring's aspect ordering.

**Fix.** Drop `@Transactional` on Eclipse-Store-only methods.

## 5. Injecting the root into a service's constructor as `AppRoot` directly

Might work because the starter sometimes auto-publishes the root bean under its
class name. Might not, if the starter changes or you have multiple roots.

**Fix.** Inject `EmbeddedStorageManager` and read `s.root()`:

```java
public CustomerService(EmbeddedStorageManager s) {
    this.root = s.root();
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

## 11. REST console exposed publicly

Adding the `integrations-spring-boot3-console` artifact auto-enables the Vaadin UI
(`org.eclipse.store.console.ui.enabled=true` by default) without securing the
endpoint in Spring Security.

**Symptom.** Anyone on the internet can browse your data.

**Fix.** Either set `org.eclipse.store.console.ui.enabled=false` outside dev, or
configure `HttpSecurity` to require auth on the console path / restrict it to an
internal-only network.

