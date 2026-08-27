# Spring AI + google-genai (Vertex AI vía proxy)

Ejemplo mínimo de `org.springframework.ai:spring-ai-google-genai` con **bean
manual**: construyes tú el `com.google.genai.Client` (baseUrl del proxy Axium +
token en lugar de ADC) y se lo pasas al `GoogleGenAiChatModel`, saltándote la
auto-configuración del starter.

No necesitas Java ni Maven instalados: todo corre dentro de Docker.

## Requisitos

- Docker

## Cómo ejecutarlo

Desde la raíz del proyecto:

```bash
docker build -t sa-genai-test .
docker run --rm sa-genai-test
```

Salida esperada:

```
Soy un modelo de lenguaje grande, entrenado por Google.
```

El primer `build` tarda un par de minutos (descarga Spring Boot + Spring AI).
Los siguientes son instantáneos: las dependencias quedan en su propia capa
cacheada.

## Iterar sobre el código

Para probar cambios en `Main.java` sin reconstruir la imagen, monta `src`
como volumen:

```bash
docker run --rm -v "$PWD/src:/app/src" sa-genai-test
```

Solo hace falta volver a ejecutar `docker build` si cambias el `pom.xml`.

## Estructura

```
Dockerfile                            imagen maven + temurin 21, mvn spring-boot:run
pom.xml                               spring-boot-starter + spring-ai-google-genai
src/main/java/demo/Main.java           app + los tres beans
src/main/resources/application.properties   banner off, logs en WARN
```

## Notas

**Módulo directo, no starter.** Se usa `spring-ai-google-genai` (sin
autoconfiguración), así que no hay nada que desactivar. Si prefieres el starter
`spring-ai-starter-model-google-genai`, añade `spring.ai.model.chat=none` para
que su modelo auto-configurado no choque con tu bean ni intente ADC.

**El token va como credencial, no como `apiKey`.** El SDK rechaza `.apiKey()`
junto con `.project()`/`.location()`:

```
Project/location and API key are mutually exclusive in the client initializer.
```

Y con solo `.apiKey()` entra en *Vertex express mode*: cambia la ruta a
`/v1/publishers/google/models/...` (sin `projects/locations`) y el proxy
responde `404 Route not found`. Con `GoogleCredentials.create(new AccessToken(token, null))`
nunca intenta refrescar, se envía como `Authorization: Bearer ax_...` y
`location("global")` sigue decidiendo la región.

**El `Main` va en un paquete (`demo`), no en el paquete por defecto.** Con
`@SpringBootApplication` en la raíz del classpath el component scan recorre
*todo*, incluido `org.springframework.boot.web.*`, y la app revienta con
`ClassNotFoundException: jakarta.servlet.Filter` (no hay dependencia web).

**`spring-boot:run`, no `exec:java`.** El plugin oficial monta el classpath que
Boot espera.

**Sin `seed`.** `ChatOptions` de Spring AI no expone `seed` (sí `temperature`,
`topP`, `topK`, `maxOutputTokens`, `thinkingBudget`...). Si lo necesitas,
usa el SDK oficial directamente — ver el proyecto hermano `../java-vanilla`.

## Uso normal en una app real

Con el bean en el contexto, se inyecta como cualquier otro:

```java
@Service
class MyService {
    private final ChatClient chatClient;

    MyService(GoogleGenAiChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    String ask(String question) {
        return chatClient.prompt().user(question).call().content();
    }
}
```
