#!/usr/bin/env bash
# Actualiza SOLO el core de Axium en GCP: trae la imagen de quay.io a Artifact
# Registry y redespliega el servicio de Cloud Run.
#
# No toca la base de datos, ni los secretos, ni los permisos, ni la ui. Para una
# instalación desde cero (o si algo de eso falta) usa gcp.sh.
#
#   bash gcp-update-core.sh                      # tag :latest
#   TAG=v0.2.0 bash gcp-update-core.sh           # una versión concreta (recomendado)
#   REGION=europe-southwest1 bash gcp-update-core.sh
#   DEBUG=1 bash gcp-update-core.sh              # diagnóstico de red y crane en verbose
set -euo pipefail

# //// CONFIGURACIÓN \\\\
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
# gcloud imprime "(unset)" en vez de nada cuando no hay proyecto configurado.
if [[ "$PROJECT_ID" == "(unset)" ]]; then PROJECT_ID=""; fi
REGION="${REGION:-europe-west1}"
TAG="${TAG:-latest}"

AR_REPO="${AR_REPO:-axium}"
CORE_SERVICE="${CORE_SERVICE:-axium-core}"

QUAY_CORE="quay.io/axiumlab/core"
AR_HOST="${REGION}-docker.pkg.dev"

# //// UTILIDADES \\\\
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[1;33mAVISO: %s\033[0m\n' "$*"; }
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

[[ -n "$PROJECT_ID" ]] || die "No hay proyecto configurado. Ejecuta: gcloud config set project TU_PROYECTO"

log "Actualizando el core de Axium"
info "proyecto: $PROJECT_ID"
info "región:   $REGION"
info "versión:  $TAG"

# //// 1. COMPROBACIONES PREVIAS \\\\
# Esto es una actualización, no una instalación: si falta cualquiera de las dos
# piezas se para aquí en vez de dejar a medias un core sin DATABASE_URL ni clave
# maestra.
log "Comprobando que la instalación existe"
gcloud run services describe "$CORE_SERVICE" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || die "El servicio '$CORE_SERVICE' no existe en $REGION.
    Este script solo actualiza una instalación que ya está en marcha. Para
    instalar desde cero:
      TAG=${TAG} bash gcp.sh"
info "el servicio '$CORE_SERVICE' existe"

gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || die "El repositorio '$AR_REPO' no existe en $REGION.
    Lo crea gcp.sh:
      TAG=${TAG} bash gcp.sh"
info "el repositorio '$AR_REPO' existe"

gcloud auth configure-docker "$AR_HOST" --quiet

# //// 2. COPIAR LA IMAGEN DEL CORE \\\\
# Cloud Run solo despliega desde Artifact Registry: no puede tirar de quay.io ni
# de ningún otro registry de terceros. Por eso hay que copiarla.
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
# reserva con docker.
log "Copiando la imagen del core de Quay a Artifact Registry"
if ensure_crane; then
    info "usando crane: $CRANE"
else
    info "crane no está disponible, uso el daemon de Docker como reserva"
fi

CORE_IMAGE="${AR_HOST}/${PROJECT_ID}/${AR_REPO}/core:${TAG}"

[[ -z "${DEBUG:-}" ]] || diagnose_registry

quay_login() {
    local user token
    info "Introduce tu usuario y token de Quay:"
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

# Un fallo contra un registry es a menudo transitorio, y sin esto cualquiera de
# ellos mataría el script entero.
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

info "${QUAY_CORE}:${TAG} -> ${CORE_IMAGE}"
if ! copy_image "${QUAY_CORE}:${TAG}" "$CORE_IMAGE"; then
    diagnose_registry
    die "No se pudo copiar ${QUAY_CORE}:${TAG} a Artifact Registry.
    Mira el diagnóstico de aquí arriba: si el curl responde 401, la red está bien
    y el problema es local a esta máquina. Con DEBUG=1 el script imprime esto
    mismo antes de empezar y pone a crane en verbose:
      DEBUG=1 TAG=${TAG} bash gcp-update-core.sh"
fi

# //// 3. REDESPLEGAR EL CORE \\\\
# Solo --image, a propósito. Un 'gcloud run deploy' sobre un servicio que ya
# existe conserva todo lo que no se le pasa: variables de entorno, la instancia
# de Cloud SQL adjunta, memoria, concurrencia y la política IAM. Así este script
# nunca lee ni reescribe MASTER_ENCRYPTION_KEY, que no se puede rotar sin dejar
# ilegibles las credenciales de proveedor guardadas en la base de datos.
log "Desplegando $CORE_SERVICE"
gcloud run deploy "$CORE_SERVICE" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --image "$CORE_IMAGE"

CORE_URL="$(gcloud run services describe "$CORE_SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
info "core: $CORE_URL"

# //// 4. COMPROBACIÓN \\\\
# health responde ok aunque el esquema esté roto, así que hay que mirar
# install/status. Aquí es un aviso y no un error: el esquema ya estaba instalado
# de antes, lo que se está comprobando es que la versión nueva sigue viéndolo.
log "Comprobando el despliegue"
for _ in $(seq 1 30); do
    if curl -fsS --max-time 30 "${CORE_URL}/v1/health" >/dev/null 2>&1; then
        break
    fi
    sleep 5
done

STATUS="$(curl -fsS --max-time 30 "${CORE_URL}/v1/install/status" 2>/dev/null || true)"
case "$STATUS" in
    *'"state":"installed"'*)
        info "el core responde y el esquema está instalado"
        ;;
    *)
        warn "El core no confirma que el esquema esté instalado.
    Respuesta de ${CORE_URL}/v1/install/status:
      ${STATUS:-(sin respuesta)}

    Mira la causa con:
      gcloud run services logs read $CORE_SERVICE --region $REGION --project $PROJECT_ID | grep install

    Para volver a la versión anterior mientras tanto:
      gcloud run revisions list --service $CORE_SERVICE --region $REGION --project $PROJECT_ID
      gcloud run services update-traffic $CORE_SERVICE --region $REGION --project $PROJECT_ID --to-revisions REVISION=100"
        ;;
esac

# //// RESUMEN \\\\
cat <<RESUMEN

$(printf '\033[1;32m')Core actualizado a ${TAG}.$(printf '\033[0m')

  API:  $CORE_URL/v1

La ui no se ha tocado: sigue apuntando a esta misma URL, que no cambia entre
despliegues. Si también quieres actualizarla, ejecuta el instalador completo:
  TAG=${TAG} bash gcp.sh

RESUMEN
