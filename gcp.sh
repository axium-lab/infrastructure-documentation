#!/usr/bin/env bash
# Instala Axium en GCP desde Cloud Shell: Cloud SQL (PostgreSQL) + core y ui en
# Cloud Run. Pensado para que el cliente lo pegue y espere.
#
# Es idempotente: se puede volver a ejecutar para actualizar de versión sin
# perder ni la base de datos ni la clave de cifrado. Esa segunda parte es la que
# más cuidado lleva, ver GENERACIÓN DE SECRETOS más abajo.
#
#   bash gcp.sh                      # tags :latest
#   TAG=v0.1.0 bash gcp.sh           # una versión concreta (recomendado)
#   REGION=europe-southwest1 bash gcp.sh
#   DEBUG=1 bash gcp.sh              # diagnóstico de red y crane en verbose
set -euo pipefail

# //// CONFIGURACIÓN \\\\
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
# gcloud imprime "(unset)" en vez de nada cuando no hay proyecto configurado.
if [[ "$PROJECT_ID" == "(unset)" ]]; then PROJECT_ID=""; fi
REGION="${REGION:-europe-west1}"
TAG="${TAG:-latest}"

DB_INSTANCE="${DB_INSTANCE:-axium-db}"
DB_NAME="${DB_NAME:-axium-api}"
DB_USER="${DB_USER:-axium}"
AR_REPO="${AR_REPO:-axium}"
CORE_SERVICE="${CORE_SERVICE:-axium-core}"
UI_SERVICE="${UI_SERVICE:-axium-ui}"

QUAY_CORE="quay.io/axiumlab/core"
QUAY_UI="quay.io/axiumlab/ui"
AR_HOST="${REGION}-docker.pkg.dev"

# //// UTILIDADES \\\\
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Sufijo de asset de los releases de go-containerregistry para esta máquina:
# goreleaser los nombra Linux_x86_64, Darwin_arm64, etc.
crane_asset() {
    local os arch
    case "$(uname -s)" in
        Linux)  os=Linux  ;;
        Darwin) os=Darwin ;;
        *) return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch=x86_64 ;;
        aarch64|arm64) arch=arm64  ;;
        *) return 1 ;;
    esac
    printf '%s_%s' "$os" "$arch"
}

# Deja en $CRANE la ruta a un crane utilizable. Devuelve no-cero SIN abortar: el
# paso de copia tiene reserva con docker para una máquina sin salida a github.com.
CRANE=""
CRANE_DIR="${HOME}/.axium/bin"
ensure_crane() {
    [[ -z "${AXIUM_NO_CRANE:-}" ]] || return 1
    if command -v crane >/dev/null 2>&1; then CRANE="$(command -v crane)"; return 0; fi
    if [[ -x "${CRANE_DIR}/crane" ]]; then CRANE="${CRANE_DIR}/crane"; return 0; fi

    local asset url
    asset="$(crane_asset)" || return 1
    mkdir -p "$CRANE_DIR" || return 1
    # Se descubre la URL en vez de construirla: el nombre del asset lo decide
    # goreleaser y no conviene fijar una versión concreta a mano.
    url="$(curl -fsS --max-time 30 \
        https://api.github.com/repos/google/go-containerregistry/releases/latest \
        | grep -o "https://[^\"]*${asset}\.tar\.gz" | head -1)" || return 1
    [[ -n "$url" ]] || return 1
    curl -fsSL --max-time 180 "$url" | tar -xz -C "$CRANE_DIR" crane || return 1
    chmod +x "${CRANE_DIR}/crane" || return 1
    CRANE="${CRANE_DIR}/crane"
}

# Todo lo que hace falta para entender por qué no se puede escribir en Artifact
# Registry. Se llama al fallar una copia, y con DEBUG=1 también al principio.
# El caso que motiva esto: el daemon de Docker de Cloud Shell devolviendo
# 'connection refused' contra un endpoint al que curl llega sin problema desde el
# mismo shell.
diagnose_registry() {
    local ips code
    log "Diagnóstico de conectividad con Artifact Registry"
    # python3 y no getent: getent no existe en macOS y un 'NO RESUELVE' falso es
    # justo el tipo de pista engañosa que este bloque intenta evitar.
    ips="$(python3 -c "
import socket, sys
try:
    print(' '.join(sorted({i[4][0] for i in socket.getaddrinfo(sys.argv[1], 443)})))
except Exception:
    pass
" "$AR_HOST" 2>/dev/null || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${AR_HOST}/v2/" 2>/dev/null || echo 000)"
    info "host:   $AR_HOST"
    info "dns:    ${ips:-NO RESUELVE}"
    info "curl:   https://${AR_HOST}/v2/ -> HTTP ${code}  (401 es la respuesta correcta)"
    info "crane:  ${CRANE:-no disponible}"
    info "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'daemon no disponible')"
    docker info 2>/dev/null | grep -i 'proxy' | sed 's/^/    docker: /' || true
    if [[ "$code" == "401" ]]; then
        info ""
        info "El shell SÍ llega al registry, así que la red de esta máquina está bien."
        info "Si la copia ha fallado con 'connection refused', el problema es el"
        info "daemon de Docker de aquí. Reinícialo y vuelve a lanzar el script:"
        info "  sudo systemctl restart docker"
    fi
}

# Lee una variable de entorno de un servicio de Cloud Run ya desplegado. Es lo
# que hace idempotente al script: sin Secret Manager, la configuración del
# servicio ES el almacén de los secretos, así que se leen de vuelta antes de
# decidir si hay que generar algo.
read_env() {
    gcloud run services describe "$1" --region "$REGION" --format=json 2>/dev/null \
        | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
c = d.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [{}])
print(next((e.get('value', '') for e in (c[0].get('env') or []) if e.get('name') == '$2'), ''))
" 2>/dev/null || true
}

[[ -n "$PROJECT_ID" ]] || die "No hay proyecto configurado. Ejecuta: gcloud config set project TU_PROYECTO"

log "Axium en GCP"
info "proyecto: $PROJECT_ID"
info "región:   $REGION"
info "versión:  $TAG"

# //// 1. APIS Y ARTIFACT REGISTRY \\\\
log "Habilitando APIs (puede tardar un minuto)"
gcloud services enable \
    sqladmin.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    --project "$PROJECT_ID"

log "Artifact Registry"
if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    info "el repositorio '$AR_REPO' ya existe"
else
    gcloud artifacts repositories create "$AR_REPO" \
        --repository-format=docker --location="$REGION" \
        --description="Imágenes de Axium copiadas de quay.io" \
        --project "$PROJECT_ID"
fi
gcloud auth configure-docker "$AR_HOST" --quiet

# //// 2. COPIAR LAS IMÁGENES DE QUAY \\\\
# Cloud Run solo despliega desde Artifact Registry: no puede tirar de quay.io ni
# de ningún otro registry de terceros. Por eso hay que copiarlas.
#
# La copia la hace crane y no docker, y no es un capricho: el daemon de Docker de
# Cloud Shell no siempre consigue abrir una conexión contra *.pkg.dev y muere con
# 'connection refused' contra un endpoint al que curl llega sin problema desde el
# mismo shell. crane habla el protocolo de registry desde el propio proceso, así
# que no depende del daemon. De propina va por streaming —no deja 1 GB de
# imágenes en el disco efímero de la VM— y copia el índice multiarquitectura tal
# cual, que Cloud Run resuelve a linux/amd64 él solo.
#
# Si crane no se puede descargar (una máquina sin salida a github.com) queda la
# reserva con docker, que es lo que hacía este script antes.
log "Copiando las imágenes de Quay a Artifact Registry"
if ensure_crane; then
    info "usando crane: $CRANE"
else
    info "crane no está disponible, uso el daemon de Docker como reserva"
fi

CORE_IMAGE="${AR_HOST}/${PROJECT_ID}/${AR_REPO}/core:${TAG}"
UI_IMAGE="${AR_HOST}/${PROJECT_ID}/${AR_REPO}/ui:${TAG}"

[[ -z "${DEBUG:-}" ]] || diagnose_registry

quay_login() {
    local user token
    info "Introduce tu usuario y token de Quay (el mismo sirve para core y ui):"
    read -rp  "    Usuario: " user
    read -rsp "    Token:   " token; printf '\n'
    # --password-stdin para que el token no acabe en la línea de comandos.
    if [[ -n "$CRANE" ]]; then
        printf '%s' "$token" | "$CRANE" auth login quay.io -u "$user" --password-stdin
    else
        printf '%s' "$token" | docker login quay.io -u "$user" --password-stdin
    fi
}

# Con crane se comprueba el acceso leyendo un manifest de verdad, en lugar de
# adivinarlo mirando si hay una entrada en ~/.docker/config.json.
if [[ -n "$CRANE" ]]; then
    if "$CRANE" manifest "${QUAY_CORE}:${TAG}" >/dev/null 2>&1; then
        info "ya hay acceso a quay.io"
    else
        quay_login
    fi
elif grep -q 'quay\.io' "${HOME}/.docker/config.json" 2>/dev/null; then
    info "ya hay sesión iniciada en quay.io"
else
    quay_login
fi

# Un fallo contra un registry es a menudo transitorio, y hasta ahora cualquiera
# de ellos mataba el script entero.
copy_image() {
    local src="$1" dst="$2" attempt
    if [[ -n "$CRANE" ]]; then
        for attempt in 1 2 3; do
            if "$CRANE" ${DEBUG:+--verbose} copy "$src" "$dst"; then
                return 0
            fi
            if (( attempt < 3 )); then
                info "el intento $attempt de 3 ha fallado, reintento en $((attempt * 5))s"
                sleep $((attempt * 5))
            fi
        done
        info "crane no ha podido copiar, pruebo con el daemon de Docker"
    fi
    docker pull --platform linux/amd64 "$src" \
        && docker tag "$src" "$dst" \
        && docker push "$dst"
}

for pair in "${QUAY_CORE}:${TAG} ${CORE_IMAGE}" "${QUAY_UI}:${TAG} ${UI_IMAGE}"; do
    read -r src dst <<<"$pair"
    info "$src -> $dst"
    if ! copy_image "$src" "$dst"; then
        diagnose_registry
        die "No se pudo copiar $src a Artifact Registry.
    Mira el diagnóstico de aquí arriba: si el curl responde 401, la red está bien
    y el problema es local a esta máquina. Con DEBUG=1 el script imprime esto
    mismo antes de empezar y pone a crane en verbose:
      DEBUG=1 TAG=${TAG} bash gcp.sh"
    fi
done

# //// 3. CLOUD SQL \\\\
# La configuración más barata que admite Cloud SQL: vCPU compartida, disco HDD
# de 10 GB, una sola zona y sin backups automáticos. Es una instalación de
# piloto: para producción de verdad, quita --no-backup.
log "Cloud SQL"
if gcloud sql instances describe "$DB_INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1; then
    info "la instancia '$DB_INSTANCE' ya existe"
else
    info "creando '$DB_INSTANCE'. Esto tarda entre 5 y 10 minutos, no cierres la sesión."
    gcloud sql instances create "$DB_INSTANCE" \
        --project "$PROJECT_ID" \
        --database-version=POSTGRES_17 \
        --edition=enterprise \
        --tier=db-f1-micro \
        --region="$REGION" \
        --storage-type=HDD \
        --storage-size=10GB \
        --availability-type=zonal \
        --no-backup
fi

if gcloud sql databases describe "$DB_NAME" --instance="$DB_INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1; then
    info "la base de datos '$DB_NAME' ya existe"
else
    gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE" --project "$PROJECT_ID"
fi

CONN="$(gcloud sql instances describe "$DB_INSTANCE" --project "$PROJECT_ID" --format='value(connectionName)')"
info "connectionName: $CONN"

# //// 4. GENERACIÓN DE SECRETOS \\\\
# Se leen primero del servicio ya desplegado. La clave maestra NO SE REGENERA
# NUNCA si ya existe: cifra las credenciales de proveedor guardadas en la base y
# cambiarla las dejaría todas ilegibles para siempre. Igual con el DSN, que es
# el que lleva la contraseña de la base dentro.
log "Configuración del core"
DATABASE_URL="$(read_env "$CORE_SERVICE" DATABASE_URL)"
MASTER_KEY="$(read_env "$CORE_SERVICE" MASTER_ENCRYPTION_KEY)"

if [[ -n "$MASTER_KEY" ]]; then
    info "reutilizando la clave maestra existente"
else
    # tr -d '\n' no es cosmético: la api valida que sean exactamente 64
    # caracteres hexadecimales y un salto de línea le sobra.
    MASTER_KEY="$(openssl rand -hex 32 | tr -d '\n')"
    info "clave maestra nueva generada"
fi

if [[ -n "$DATABASE_URL" ]]; then
    info "reutilizando la conexión a la base existente"
else
    # Hexadecimal a propósito: así no hay nada que percent-encodear en el DSN ni
    # ninguna coma que rompa el --set-env-vars de gcloud.
    DB_PASS="$(openssl rand -hex 24)"
    if gcloud sql users list --instance="$DB_INSTANCE" --project "$PROJECT_ID" --format='value(name)' | grep -qx "$DB_USER"; then
        info "el usuario '$DB_USER' ya existe, le pongo una contraseña nueva"
        gcloud sql users set-password "$DB_USER" --instance="$DB_INSTANCE" --project "$PROJECT_ID" --password="$DB_PASS"
    else
        gcloud sql users create "$DB_USER" --instance="$DB_INSTANCE" --project "$PROJECT_ID" --password="$DB_PASS"
    fi

    # OJO con el 'localhost': es relleno obligatorio, no un despiste. knex hace
    # un new URL() sobre el DSN antes de parsearlo y, si lanza, se cae en
    # silencio a sqlite3 y la api acaba intentando conectar a localhost:5432. Un
    # DSN con la authority vacía (...@/axium-api) hace exactamente eso. El
    # socket real es el del query param host=, que es el que gana.
    DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost/${DB_NAME}?host=/cloudsql/${CONN}"
fi

# //// 5. PERMISOS \\\\
log "Permisos del service account de ejecución"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/cloudsql.client" \
    --condition=None >/dev/null
info "$RUNTIME_SA -> roles/cloudsql.client"

# //// 6. DESPLEGAR EL CORE \\\\
# TRUST_PROXY=true porque Cloud Run termina el TLS por delante y reescribe
# siempre las cabeceras X-Forwarded-*. PORT lo inyecta Cloud Run y NODE_ENV ya
# viene en la imagen, así que no se pasan. Memoria y concurrencia salen del
# techo de subida (50 MB por petición, que se sostienen en RAM).
log "Desplegando $CORE_SERVICE"
if ! gcloud run deploy "$CORE_SERVICE" \
    --project "$PROJECT_ID" \
    --image "$CORE_IMAGE" \
    --region "$REGION" \
    --allow-unauthenticated \
    --member=allUsers \
    --add-cloudsql-instances "$CONN" \
    --set-env-vars "DATABASE_URL=${DATABASE_URL},MASTER_ENCRYPTION_KEY=${MASTER_KEY},TRUST_PROXY=true" \
    --memory 1Gi --cpu 1 --concurrency 20 \
    --min-instances 0 --max-instances 4; then
    die "Falló el despliegue del core.
    Si el error menciona IAM o allUsers, tu organización tiene activada la
    política de dominio restringido y no permite servicios públicos. Habla con
    quien administre la organización, o despliega con --no-allow-unauthenticated
    y pon un balanceador delante."
fi

CORE_URL="$(gcloud run services describe "$CORE_SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
info "core: $CORE_URL"

# //// 7. DESPLEGAR LA UI \\\\
# API_URL la resuelve el NAVEGADOR del usuario, no el contenedor: tiene que ser
# una URL pública. La de Cloud Run del core lo es y además es https, así que no
# hay contenido mixto. Por eso el core va primero.
log "Desplegando $UI_SERVICE"
gcloud run deploy "$UI_SERVICE" \
    --project "$PROJECT_ID" \
    --image "$UI_IMAGE" \
    --region "$REGION" \
    --allow-unauthenticated \
    --member=allUsers \
    --set-env-vars "API_URL=${CORE_URL}/v1" \
    --memory 512Mi --cpu 1 --concurrency 80 \
    --min-instances 0 --max-instances 4

UI_URL="$(gcloud run services describe "$UI_SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

# //// 8. COMPROBACIÓN \\\\
# La primera petición provoca el arranque en frío, y con él la instalación del
# esquema. Después hay que mirar install/status y no health: health responde ok
# aunque la instalación haya fallado, así que es el único que distingue una
# instalación buena de una rota.
log "Comprobando la instalación"
for _ in $(seq 1 30); do
    if curl -fsS --max-time 30 "${CORE_URL}/v1/health" >/dev/null 2>&1; then
        break
    fi
    sleep 5
done

STATUS="$(curl -fsS --max-time 30 "${CORE_URL}/v1/install/status" 2>/dev/null || true)"
case "$STATUS" in
    *'"state":"installed"'*)
        info "esquema instalado correctamente"
        ;;
    *)
        die "El core responde pero el esquema NO está instalado.
    Respuesta de ${CORE_URL}/v1/install/status:
      ${STATUS:-(sin respuesta)}

    Mira la causa con:
      gcloud run services logs read $CORE_SERVICE --region $REGION --project $PROJECT_ID | grep install

    Si el log dice 'permission denied for database', al usuario '$DB_USER' le
    falta permiso para crear esquemas. Se arregla en tres pasos:
      gcloud sql users set-password postgres --instance=$DB_INSTANCE --prompt-for-password
      gcloud sql connect $DB_INSTANCE --user=postgres --database=$DB_NAME
      GRANT CREATE ON DATABASE \"$DB_NAME\" TO $DB_USER;
    Después vuelve a ejecutar este script: reutilizará todo lo que ya existe."
        ;;
esac

# //// RESUMEN \\\\
cat <<RESUMEN

$(printf '\033[1;32m')Axium está instalado.$(printf '\033[0m')

  Consola:  $UI_URL
  API:      $CORE_URL/v1

  Usuario:     admin@axium.local
  Contraseña:  admin123456

Antes de cualquier otra cosa:

  1. Entra y cambia esa contraseña. Es la misma en toda instalación nueva y
     tiene permisos totales.

  2. Guarda la clave maestra en tu gestor de contraseñas:

       $MASTER_KEY

     Cifra las credenciales de proveedor guardadas en la base de datos y NO SE
     PUEDE ROTAR: si se pierde, hay que volver a introducirlas todas a mano.

Dos cosas que conviene saber:

  - La clave maestra y la contraseña de la base están en claro en la
    configuración del servicio de Cloud Run, así que las ve cualquiera con
    acceso de lectura al proyecto. Para endurecerlo, muévelas a Secret Manager
    y cambia --set-env-vars por --set-secrets en este script.

  - No hay migraciones de esquema. Volver a ejecutar este script con un TAG más
    nuevo actualiza las imágenes, pero no toca un esquema ya instalado.

Para actualizar:  TAG=v0.2.0 bash gcp.sh

RESUMEN
