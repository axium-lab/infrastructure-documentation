# google-genai en Java (Vertex AI vía proxy)

Ejemplo mínimo del SDK oficial `com.google.genai:google-genai` apuntando a un
`baseUrl` propio (proxy Axium) con un token en lugar de ADC.

No necesitas Java ni Maven instalados: todo corre dentro de Docker.

## Requisitos

- Docker

## Cómo ejecutarlo

Desde la raíz del proyecto:

```bash
docker build -t genai-test .
docker run --rm genai-test
```

Salida esperada:

```
Soy un modelo de lenguaje grande, entrenado por Google.
```

El primer `build` tarda ~1 minuto (descarga el SDK). Los siguientes son
instantáneos: las dependencias quedan en su propia capa cacheada.

## Iterar sobre el código

Para probar cambios en `Main.java` sin reconstruir la imagen, monta `src`
como volumen (las dependencias Maven ya están dentro de la imagen):

```bash
docker run --rm -v "$PWD/src:/app/src" genai-test
```

Solo hace falta volver a ejecutar `docker build` si cambias el `pom.xml`.

Para trastear dentro del contenedor:

```bash
docker run --rm -it -v "$PWD/src:/app/src" genai-test sh
# y dentro:
mvn -q compile exec:java
```

## Estructura

```
Dockerfile                 imagen maven + temurin 21, ejecuta mvn exec:java
pom.xml                    una sola dependencia: google-genai
src/main/java/Main.java    el ejemplo
```

## Nota sobre la autenticación

A diferencia del SDK de JS, en Java `.apiKey()` es **mutuamente excluyente**
con `.project()` / `.location()`:

```
Project/location and API key are mutually exclusive in the client initializer.
```

Y si usas solo `.apiKey()`, el SDK entra en *Vertex express mode* y cambia la
ruta a `/v1/publishers/google/models/...` (sin `projects/locations`), con lo que
el proxy responde `404 Route not found`.

La solución es pasar el token como credencial estática, que cumple el mismo
doble propósito que el `apiKey` en JS (evitar ADC y enviar el token):

```java
.credentials(GoogleCredentials.create(new AccessToken("ax_...", null)))
```

Con `null` como expiración nunca intenta refrescar. Se envía como
`Authorization: Bearer ax_...` y `project`/`location` se mantienen en la ruta,
así que `location("global")` sigue decidiendo la región de Google.
