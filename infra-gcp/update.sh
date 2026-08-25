#!/usr/bin/env bash
# Actualiza Axium en GCP: trae de quay.io a Artifact Registry la imagen del core,
# la de la ui o las dos, y redespliega los servicios de Cloud Run
# correspondientes. Pregunta qué actualizar si no se le dice.
#
# No toca la base de datos, ni los secretos, ni los permisos. Para una
# instalación desde cero (o si algo de eso falta) usa gcp.sh.
#
#   bash update.sh                        # pregunta qué actualizar
#   bash update.sh core                   # solo el core, sin preguntar
#   bash update.sh ui                     # solo la ui
#   TAG=v0.2.0 bash update.sh both        # ambos, en una versión concreta (recomendado)
#   REGION=europe-southwest1 bash update.sh
#   DEBUG=1 bash update.sh                # diagnóstico de red y crane en verbose
set -euo pipefail

# //// CONFIGURACIÓN \\\\
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
# gcloud imprime "(unset)" en vez de nada cuando no hay proyecto configurado.
if [[ "$PROJECT_ID" == "(unset)" ]]; then PROJECT_ID=""; fi
REGION="${REGION:-europe-west1}"
TAG="${TAG:-latest}"

AR_REPO="${AR_REPO:-axium}"
CORE_SERVICE="${CORE_SERVICE:-axium-core}"
UI_SERVICE="${UI_SERVICE:-axium-ui}"

QUAY_CORE="quay.io/axiumlab/core"
QUAY_UI="quay.io/axiumlab/ui"
AR_HOST="${REGION}-docker.pkg.dev"

# //// UTILIDADES \\\\
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[1;33mAVISO: %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# tr y no ${var,,}: el bash 3.2 de macOS no conoce esa expansión.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# //// QUÉ SE ACTUALIZA \\\\
# Se admite por argumento o por variable de entorno para poder lanzarlo sin
# interacción (un pipeline, o alguien que ya sabe lo que quiere), y solo se
# pregunta cuando no viene de ninguna de las dos formas.
TARGET="$(lower "${1:-${TARGET:-}}")"

normalize_target() {
    case "$1" in
        core)                 printf 'core' ;;
        ui)                   printf 'ui'   ;;
        both|ambos|all|todo)  printf 'both' ;;
        *)                    return 1      ;;
    esac
}

# El menú se lee de /dev/tty y no de stdin: así sigue funcionando cuando el
# script llega por una tubería (curl ... | bash), donde stdin es el propio
# script y un read normal se comería sus líneas.
choose_target() {
    local opt tty="/dev/tty"
    [[ -r "$tty" ]] || die "No hay terminal para preguntar qué actualizar.
    Dilo en la propia llamada:
      bash update.sh core     # solo el core
      bash update.sh ui       # solo la ui
      bash update.sh both     # las dos"

    printf '\n\033[1;36m==> ¿Qué quieres actualizar?\033[0m\n'
    printf '      1) core  (la API)\n'
    printf '      2) ui    (la consola web)\n'
    printf '      3) ambos\n\n'
    while :; do
        read -rp "    Opción [3]: " opt <"$tty"
        case "${opt:-3}" in
            1) TARGET=core; return 0 ;;
            2) TARGET=ui;   return 0 ;;
            3) TARGET=both; return 0 ;;
            *) printf '    Escribe 1, 2 o 3.\n' ;;
        esac
    done
}

if [[ -n "$TARGET" ]]; then
    TARGET="$(normalize_target "$TARGET")" \
        || die "'${1:-$TARGET}' no es un objetivo válido. Usa: core, ui o both."
else
    choose_target
fi

UPDATE_CORE=0; UPDATE_UI=0
case "$TARGET" in
    core) UPDATE_CORE=1 ;;
    ui)   UPDATE_UI=1   ;;
    both) UPDATE_CORE=1; UPDATE_UI=1 ;;
esac

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

case "$TARGET" in
    core) WHAT="el core" ;;
    ui)   WHAT="la ui"   ;;
    both) WHAT="el core y la ui" ;;
esac

log "Actualizando $WHAT de Axium"
info "proyecto: $PROJECT_ID"
info "región:   $REGION"
info "versión:  $TAG"

# //// 1. COMPROBACIONES PREVIAS \\\\
# Esto es una actualización, no una instalación: si falta cualquiera de las
# piezas se para aquí en vez de dejar a medias un core sin DATABASE_URL ni clave
# maestra, o una ui sin API_URL.
log "Comprobando que la instalación existe"

require_service() {
    gcloud run services describe "$1" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
        || die "El servicio '$1' no existe en $REGION.
    Este script solo actualiza una instalación que ya está en marcha. Para
    instalar desde cero:
      TAG=${TAG} bash gcp.sh"
    info "el servicio '$1' existe"
}

if (( UPDATE_CORE )); then require_service "$CORE_SERVICE"; fi
if (( UPDATE_UI ));   then require_service "$UI_SERVICE";   fi

gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || die "El repositorio '$AR_REPO' no existe en $REGION.
    Lo crea gcp.sh:
      TAG=${TAG} bash gcp.sh"
info "el repositorio '$AR_REPO' existe"

gcloud auth configure-docker "$AR_HOST" --quiet

# //// 2. TRAER LAS IMÁGENES DE QUAY \\\\
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
# reserva con docker.
log "Trayendo de Quay lo que hay que actualizar"
if ensure_crane; then
    info "usando crane: $CRANE"
else
    info "crane no está disponible, uso el daemon de Docker como reserva"
fi

AR_CORE="${AR_HOST}/${PROJECT_ID}/${AR_REPO}/core"
AR_UI="${AR_HOST}/${PROJECT_ID}/${AR_REPO}/ui"

# La imagen contra la que se comprueba el acceso a quay: la primera de las
# seleccionadas, para no pedir credenciales por una imagen que no se va a tocar.
if (( UPDATE_CORE )); then PROBE_IMAGE="$QUAY_CORE"; else PROBE_IMAGE="$QUAY_UI"; fi

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
    if "$CRANE" manifest "${PROBE_IMAGE}:${TAG}" >/dev/null 2>&1; then
        info "ya hay acceso a quay.io"
    else
        quay_login
    fi
elif grep -q 'quay\.io' "${HOME}/.docker/config.json" 2>/dev/null; then
    info "ya hay sesión iniciada en quay.io"
else
    quay_login
fi

# Digest de la última imagen copiada a Artifact Registry. Es lo que se despliega:
# fijarlo aquí es lo que garantiza que a Cloud Run llega la imagen que quay.io
# tiene AHORA y no la que resolviera un :latest cinco minutos después. Global
# porque bash 3.2 no tiene nameref para devolverlo por referencia.
COPIED_DIGEST=""

# Un fallo contra un registry es a menudo transitorio, y sin esto cualquiera de
# ellos mataría el script entero.
copy_image() {
    local quay="$1" ar="$2"
    local dst="${ar}:${TAG}" src attempt logfile
    COPIED_DIGEST=""

    if [[ -n "$CRANE" ]]; then
        # Se resuelve el digest del origen ANTES de copiar y se copia por digest:
        # con :latest el tag se mueve, y entre el 'crane copy' y el 'gcloud run
        # deploy' podría publicarse otra imagen. Copiando y desplegando el mismo
        # sha256 no hay ventana. crane no recomprime nada, así que el digest en
        # destino es idéntico al de quay.
        COPIED_DIGEST="$("$CRANE" digest "${quay}:${TAG}")" || return 1
        src="${quay}@${COPIED_DIGEST}"
        info "quay.io tiene ${TAG} -> ${COPIED_DIGEST}"
        for attempt in 1 2 3; do
            # El destino lleva el tag para que siga siendo legible en la consola
            # de Artifact Registry; el despliegue va por digest de todas formas.
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

    # docker no sabe copiar un índice multiarquitectura: baja la variante amd64 y
    # sube solo esa, así que el digest de destino NO es el de quay y hay que
    # sacarlo de la propia subida. El rmi previo es para que el pull sea una
    # descarga de verdad y no un acierto de caché local.
    docker rmi -f "${quay}:${TAG}" >/dev/null 2>&1 || true
    docker pull --platform linux/amd64 "${quay}:${TAG}" || return 1
    docker tag "${quay}:${TAG}" "$dst" || return 1

    logfile="$(mktemp)"
    docker push "$dst" | tee "$logfile" || { rm -f "$logfile"; return 1; }
    COPIED_DIGEST="$(grep -o 'sha256:[0-9a-f]\{64\}' "$logfile" | tail -1)"
    rm -f "$logfile"
    [[ -n "$COPIED_DIGEST" ]] || return 1
}

fetch() {
    local quay="$1" ar="$2"
    info "${quay}:${TAG} -> ${ar}:${TAG}"
    if ! copy_image "$quay" "$ar"; then
        diagnose_registry
        die "No se pudo traer ${quay}:${TAG} a Artifact Registry.
    Mira el diagnóstico de aquí arriba: si el curl responde 401, la red está bien
    y el problema es local a esta máquina. Con DEBUG=1 el script imprime esto
    mismo antes de empezar y pone a crane en verbose:
      DEBUG=1 TAG=${TAG} bash update.sh ${TARGET}"
    fi
}

# Las dos copias se hacen ANTES de desplegar nada. Si la segunda imagen no se
# puede traer, mejor enterarse con los dos servicios todavía en la versión
# anterior que con el core ya actualizado y la ui atrás.
CORE_DIGEST=""; UI_DIGEST=""
if (( UPDATE_CORE )); then fetch "$QUAY_CORE" "$AR_CORE"; CORE_DIGEST="$COPIED_DIGEST"; fi
if (( UPDATE_UI ));   then fetch "$QUAY_UI"   "$AR_UI";   UI_DIGEST="$COPIED_DIGEST";   fi

# //// 3. REDESPLEGAR \\\\
# Solo --image, a propósito. Un 'gcloud run deploy' sobre un servicio que ya
# existe conserva todo lo que no se le pasa: variables de entorno, la instancia
# de Cloud SQL adjunta, memoria, concurrencia y la política IAM. Así este script
# nunca lee ni reescribe MASTER_ENCRYPTION_KEY —que no se puede rotar sin dejar
# ilegibles las credenciales de proveedor guardadas en la base de datos— ni el
# API_URL de la ui, que además no haría falta tocar: la URL de Cloud Run del core
# no cambia entre despliegues.
deploy() {
    local service="$1" image="$2"
    log "Desplegando $service"
    gcloud run deploy "$service" \
        --project "$PROJECT_ID" \
        --region "$REGION" \
        --image "$image"
}

service_url() {
    gcloud run services describe "$1" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)'
}

# El core va primero cuando se actualizan los dos: es quien sirve la API que la
# ui consulta desde el navegador.
CORE_URL=""; UI_URL=""
if (( UPDATE_CORE )); then
    deploy "$CORE_SERVICE" "${AR_CORE}@${CORE_DIGEST}"
    CORE_URL="$(service_url "$CORE_SERVICE")"
    info "core: $CORE_URL"
fi

if (( UPDATE_UI )); then
    deploy "$UI_SERVICE" "${AR_UI}@${UI_DIGEST}"
    UI_URL="$(service_url "$UI_SERVICE")"
    info "ui: $UI_URL"
fi

# //// 4. COMPROBACIÓN \\\\
log "Comprobando el despliegue"

# Espera al arranque en frío de la revisión nueva. Devuelve no-cero si no
# responde, sin abortar: el aviso concreto lo da cada comprobación.
wait_for() {
    local url="$1" _
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 30 -o /dev/null "$url" 2>/dev/null; then
            return 0
        fi
        sleep 5
    done
    return 1
}

if (( UPDATE_CORE )); then
    # health responde ok aunque el esquema esté roto, así que hay que mirar
    # install/status. Aquí es un aviso y no un error: el esquema ya estaba
    # instalado de antes, lo que se comprueba es que la versión nueva sigue
    # viéndolo.
    wait_for "${CORE_URL}/v1/health" || true
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
fi

if (( UPDATE_UI )); then
    # La ui no tiene endpoint de estado: es una web estática servida por Node, y
    # que la raíz devuelva 200 es todo lo que se puede comprobar desde aquí. Que
    # hable con el core depende de API_URL, y eso lo resuelve el navegador.
    if wait_for "$UI_URL"; then
        info "la ui responde"
    else
        warn "La ui no responde en $UI_URL.
    Mira la causa con:
      gcloud run services logs read $UI_SERVICE --region $REGION --project $PROJECT_ID

    Para volver a la versión anterior mientras tanto:
      gcloud run revisions list --service $UI_SERVICE --region $REGION --project $PROJECT_ID
      gcloud run services update-traffic $UI_SERVICE --region $REGION --project $PROJECT_ID --to-revisions REVISION=100"
    fi
fi

# //// RESUMEN \\\\
printf '\n\033[1;32mActualizado %s a %s.\033[0m\n\n' "$WHAT" "$TAG"

if (( UPDATE_CORE )); then
    printf '  API:     %s/v1\n' "$CORE_URL"
    printf '  Imagen:  %s\n' "$CORE_DIGEST"
fi
if (( UPDATE_UI )); then
    printf '  Consola: %s\n' "$UI_URL"
    printf '  Imagen:  %s\n' "$UI_DIGEST"
fi
printf '\n'

# Las URL de Cloud Run no cambian entre despliegues, así que actualizar una sola
# pieza no deja a la otra apuntando a ninguna parte. Lo que sí puede pasar es que
# queden en versiones que no se entiendan entre ellas.
if (( UPDATE_CORE )) && (( ! UPDATE_UI )); then
    cat <<'RESUMEN'
La ui no se ha tocado: sigue apuntando a esta misma URL, que no cambia entre
despliegues. Si también quieres actualizarla:
  bash update.sh ui

RESUMEN
elif (( UPDATE_UI )) && (( ! UPDATE_CORE )); then
    cat <<'RESUMEN'
El core no se ha tocado. Si la versión nueva de la ui necesita una API más
reciente, actualízalo también:
  bash update.sh core

RESUMEN
fi

cat <<'RESUMEN'
Ni la base de datos, ni la clave maestra, ni los permisos se han tocado. Si
falta algo de eso —o quieres instalar desde cero— usa gcp.sh.

RESUMEN
