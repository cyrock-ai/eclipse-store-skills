# Examples-expanded — spring-boot

## Example 1 — Minimal Spring Boot app

`pom.xml`:

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
  </dependency>
  <dependency>
    <groupId>org.eclipse.store</groupId>
    <artifactId>integrations-spring-boot3</artifactId>
    <version>${eclipse-store.version}</version>
  </dependency>
</dependencies>
```

`application.properties`:

```properties
org.eclipse.store.root=com.example.AppRoot
org.eclipse.store.storage-directory=data
```

`AppRoot.java`:

```java
package com.example;

import java.util.ArrayList;
import java.util.List;

public class AppRoot {
    public AppRoot() {}                              // REQUIRED by Spring

    private final List<String> messages = new ArrayList<>();
    public List<String> messages() { return messages; }
}
```

`MessageService.java`:

```java
@Service
public class MessageService {
    private final EmbeddedStorageManager storage;
    private final AppRoot root;

    public MessageService(EmbeddedStorageManager storage) {
        this.storage = storage;
        this.root    = storage.root();
    }

    @Write
    public void add(String m) {
        root.messages().add(m);
        storage.store(root.messages());
    }

    @Read
    public List<String> all() {
        return List.copyOf(root.messages());         // defensive copy
    }
}
```

`MessageController.java`:

```java
@RestController
@RequestMapping("/messages")
public class MessageController {
    private final MessageService svc;
    public MessageController(MessageService svc) { this.svc = svc; }

    @GetMapping
    public List<String> all() { return svc.all(); }

    @PostMapping
    public void add(@RequestBody String m) { svc.add(m); }
}
```

## Example 2 — Per-aggregate `@Mutex`

```java
@Service
@Mutex("customers")
public class CustomerService {
    private final EmbeddedStorageManager storage;
    private final AppRoot root;

    public CustomerService(EmbeddedStorageManager s) {
        this.storage = s;
        this.root    = s.root();
    }

    @Write
    public void add(Customer c) {
        root.customers().put(c.email(), c);
        storage.store(root.customers());
    }

    @Read
    public Customer find(String email) {
        return root.customers().get(email);
    }
}

@Service
@Mutex("orders")
public class OrderService {
    // same shape, independent lock
}
```

Customer operations don't block order operations.

## Example 3 — Cloud storage in prod, local in dev

`application.properties`:

```properties
org.eclipse.store.root=com.example.AppRoot
```

`application-dev.properties`:

```properties
org.eclipse.store.storage-directory=data-dev
org.eclipse.store.channel-count=1
```

`application-prod.properties`:

```properties
org.eclipse.store.storage-directory=my-bucket/prod-data
org.eclipse.store.storage-filesystem.aws.s3.region=eu-north-1
org.eclipse.store.storage-filesystem.aws.s3.credentials.type=default

org.eclipse.store.backup-directory=my-bucket/prod-backup
org.eclipse.store.backup-filesystem.aws.s3.region=eu-north-1
org.eclipse.store.backup-filesystem.aws.s3.credentials.type=default

org.eclipse.store.channel-count=4
org.eclipse.store.housekeeping-adaptive=true
```

Ensure the AWS S3 AFS artifact is on the classpath (`afs-aws-s3` +
`software.amazon.awssdk:s3`).

## Example 4 — Test with a temp directory

```java
@SpringBootTest
@AutoConfigureMockMvc
class MessageServiceTest {

    @Autowired MessageService svc;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry reg) throws IOException {
        Path dir = Files.createTempDirectory("es-test");
        reg.add("org.eclipse.store.storage-directory", () -> dir.toString());
    }

    @Test
    void roundtrip() {
        svc.add("hello");
        assertEquals(1, svc.all().size());
    }
}
```

Each test class gets a fresh temp directory; when Spring shuts down, the
manager closes automatically.

## Example 5 — GigaMap in a Spring Boot app

```java
public class AppRoot {
    public AppRoot() {}

    private final GigaMap<Person> people = GigaMap.<Person>Builder()
        .withBitmapIdentityIndex(PersonIndices.id)
        .withBitmapIndex(PersonIndices.lastName)
        .build();

    public GigaMap<Person> people() { return people; }
}
```

```java
@Service
@Mutex("people")
public class PeopleService {
    private final AppRoot root;
    public PeopleService(EmbeddedStorageManager s) { this.root = s.root(); }

    @Write
    public void add(Person p) {
        root.people().add(p);
        root.people().store();                // use gigaMap.store(), not storage.store(map)
    }

    @Read
    public List<Person> findByLastName(String ln) {
        return root.people().query(PersonIndices.lastName.is(ln)).toList();
    }
}
```

Note: the service uses `gigaMap.store()` internally — this is the correct path
even inside a Spring `@Write` method.

## Example 6 — Enable REST console

Add the artifact:

```xml
<dependency>
  <groupId>org.eclipse.store</groupId>
  <artifactId>integrations-spring-boot3-console</artifactId>
  <version>${eclipse-store.version}</version>
</dependency>
```

The Vaadin UI is on by default once the artifact is on the classpath
(`org.eclipse.store.console.ui.enabled=true`). Configure the mount path:

```properties
vaadin.url-mapping=/store-console/*
```

Accessing `http://localhost:8080/store-console/` gives a read-only UI to browse
the graph. Dev/ops only — do not expose publicly.
