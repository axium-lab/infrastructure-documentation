# Instalación de Axium

Axium son tres piezas: **core** (la API), **ui** (la consola web) y **PostgreSQL**. Esta guía
es lo mínimo para levantarlas con Docker y entrar por primera vez.

> **¿Instalas en Google Cloud?** No sigas esta guía: usa `gcp.sh`, que lo hace todo por ti
> —Cloud SQL, los dos servicios en Cloud Run y la comprobación final—. Abre Cloud Shell en tu
> proyecto y ejecuta `TAG=v0.1.0 bash gcp.sh`. Es re-ejecutable para actualizar de versión.


Puedes usar el siguiente comando en GCP:
> wget https://raw.githubusercontent.com/.../gcp.sh && chmod +x gcp.sh && ./gcp.sh

## 1. Antes de empezar

Necesitas Docker y tu token de Quay (el mismo sirve para `core` y para `ui`).

```bash
docker login quay.io
```

## 2. Imágenes

| Pieza | Imagen                    |
| ----- | ------------------------- |
| core  | `quay.io/axiumlab/core`   |
| ui    | `quay.io/axiumlab/ui`     |

Cada una publica tres tags:

| Tag         | Qué es                                                        |
| ----------- | ------------------------------------------------------------- |
| `vX.Y.Z`    | Una versión concreta (`v0.1.0`). **Usa este en producción.**   |
| `vX-latest` | La última del major (`v1-latest`).                            |
| `latest`    | La última publicada.                                          |

```bash
docker pull quay.io/axiumlab/core:latest
docker pull quay.io/axiumlab/ui:latest
```

## 3. Arranque

Una red propia para que el core vea a Postgres:

```bash
docker network create axium
```

### PostgreSQL

```bash
docker run -d --name axium-db --network axium \
  --restart unless-stopped \
  -e POSTGRES_USER=axium \
  -e POSTGRES_PASSWORD=cambia-esto \
  -e POSTGRES_DB=axium-api \
  -v axium-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
```

El volumen `axium-pgdata` es el único estado que hay que conservar: ni el core ni el ui
escriben en disco.

### Core

Genera la clave maestra una vez y guárdala en sitio seguro:

```bash
openssl rand -hex 32
```

```bash
docker run -d --name axium-core --network axium \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://axium:cambia-esto@axium-db:5432/axium-api \
  -e MASTER_ENCRYPTION_KEY=<los 64 caracteres del paso anterior> \
  quay.io/axiumlab/core:latest
```

Esas dos variables son las únicas obligatorias: sin cualquiera de ellas —o con una clave que
no sean 64 caracteres hexadecimales— el proceso se niega a arrancar. El resto es opcional:

| Variable          | Por defecto | Para qué                                                            |
| ----------------- | ----------- | ------------------------------------------------------------------- |
| `PORT`            | `3000`      | Puerto de escucha.                                                  |
| `MAX_UPLOAD_SIZE` | `50mb`      | Techo de un fichero subido; se sostiene entero en RAM por petición.  |
| `LOG_REQUESTS`    | apagado     | `true` para una línea de log por petición HTTP.                     |
| `PUBLIC_BASE_URL` | —           | URL pública del core. Solo si hay un proxy delante que termina TLS.  |
| `TRUST_PROXY`     | `false`     | `true` si hay un proxy delante que termina TLS.                     |

En el primer arranque el core espera a Postgres (hasta 30 segundos), instala el esquema él
mismo y crea el usuario inicial. Reiniciarlo no repite nada.

### Ui

```bash
docker run -d --name axium-ui --network axium \
  --restart unless-stopped \
  -p 3001:3001 \
  -e API_URL=http://localhost:3000/v1 \
  quay.io/axiumlab/ui:latest
```

`API_URL` es la única variable del ui, y **la resuelve el navegador del usuario, no el
contenedor**. Tiene que ser la URL con la que se llega al core desde fuera —en un despliegue
real, algo como `https://axium-api.tu-dominio.com/v1`. Un nombre interno de Docker como
`http://axium-core:3000/v1` **no funciona**, aunque el contenedor del ui sí lo resuelva.
Terminada en `/v1` y sin barra final.

## 4. Comprobar que está arriba

```bash
curl http://localhost:3000/v1/health          # {"status":"ok"}
curl http://localhost:3000/v1/install/status  # {"state":"installed","version":1}
```

Hacen falta las dos: `/v1/health` responde `ok` incluso si la instalación del esquema falló,
así que la que confirma que Axium es usable es `install/status`. Si devuelve `not_installed` o
`partial`, mira los logs:

```bash
docker logs axium-core | grep '\[install\]'
```

## 5. Primer acceso

Abre `http://localhost:3001` y entra con las credenciales que crea el esquema:

- **Usuario:** `admin@axium.local`
- **Contraseña:** `admin123456`

Son las mismas en toda instalación nueva y tienen permisos totales. **Cámbialas en cuanto
entres**: no hay ninguna forma de fijar otras credenciales iniciales desde la configuración.

## 6. Actualizar

```bash
docker pull quay.io/axiumlab/core:v0.2.0
docker stop axium-core && docker rm axium-core
# relanza el docker run del paso 3 con el tag nuevo
```

Los contenedores son desechables y el volumen de Postgres se queda donde está. Lo mismo para
el ui.

## Tres cosas que conviene saber antes

- **La clave maestra no se puede rotar.** `MASTER_ENCRYPTION_KEY` cifra las credenciales de
  proveedor guardadas en la base de datos. Si se pierde o se cambia, ninguna se puede
  descifrar y hay que volver a introducirlas todas a mano.
- **No hay migraciones de esquema.** El core instala el esquema si la base está vacía y no
  toca nada si ya existe, sea de la versión que sea. Actualizar la imagen sobre una base de
  una versión anterior no actualiza el esquema: consúltanos antes de subir de versión mayor.
- **Si sirves el ui por HTTPS, `API_URL` tiene que ser `https://`.** El navegador bloquea las
  peticiones a `http://` desde una página `https` sin dar un error de red claro.
