# LangChain4j + google-genai (Vertex AI vía proxy)

Ejemplo mínimo del módulo `dev.langchain4j:langchain4j-google-genai` (el wrapper
de LangChain4j sobre el SDK oficial `com.google.genai`) apuntando a un endpoint
propio (proxy Axium) con un token en lugar de ADC.

No necesitas Java ni Maven instalados: todo corre dentro de Docker.

## Requisitos

- Docker

## Cómo ejecutarlo

Desde la raíz del proyecto:

```bash
docker build -t lc4j-genai-test .
docker run --rm lc4j-genai-test
```

Salida esperada:

```
Soy un modelo de lenguaje grande, entrenado por Google.
```

El primer `build` tarda ~1 minuto (descarga las dependencias). Los siguientes
son instantáneos: quedan en su propia capa cacheada.

## Iterar sobre el código

Para probar cambios en `Main.java` sin reconstruir la imagen, monta `src`
como volumen:

```bash
docker run --rm -v "$PWD/src:/app/src" lc4j-genai-test
```

Solo hace falta volver a ejecutar `docker build` si cambias el `pom.xml`.

## Estructura

```
Dockerfile                 imagen maven + temurin 21, ejecuta mvn exec:java
pom.xml                    langchain4j-google-genai + slf4j-nop
src/main/java/Main.java    el ejemplo
```

## Notas

**Todo se configura desde el builder.** `.apiEndpoint()` acepta la URL completa
del proxy (host *y* path), así que no hace falta construir un
`com.google.genai.Client` a mano:

```java
GoogleGenAiChatModel.builder()
    .googleCredentials(GoogleCredentials.create(new AccessToken("ax_...", null)))
    .projectId("lo-que-sea")
    .location("global")
    .apiEndpoint("https://.../vertex")
    .modelName("google/gemini-3.5-flash-lite")
    .seed(42)
    .build();
```

**El token va como credencial, no como `apiKey`.** El builder tiene `.apiKey()`,
pero al pasarlo el SDK subyacente entra en *Vertex express mode*: cambia la ruta
a `/v1/publishers/google/models/...` (sin `projects/locations`) y el proxy
responde `404 Route not found`. Con `.googleCredentials()` y un `AccessToken`
sin expiración (`null`) nunca intenta refrescar, se envía como
`Authorization: Bearer ax_...` y `location("global")` sigue decidiendo la región.

**Alternativa:** si necesitas control total sobre el cliente, el builder también
acepta `.client(com.google.genai.Client)` — ver el proyecto hermano
`../java-vanilla`, que usa el SDK oficial directamente.

**`slf4j-nop`** solo está para silenciar el warning de arranque de SLF4J.
Cámbialo por `slf4j-simple` y añade `.logRequestsAndResponses(true)` al builder
si quieres ver las peticiones HTTP.
