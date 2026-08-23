# Installing Axium

Axium is three pieces: **core** (the API), **ui** (the web console) and **PostgreSQL**. This
guide is the minimum needed to bring them up with Docker and log in for the first time.

> **Installing on Google Cloud?** Don't follow this guide: use `gcp.sh`, which does everything
> for you —Cloud SQL, both services on Cloud Run and the final check—. Open Cloud Shell in your
> project and run `TAG=v0.1.0 bash gcp.sh`. It is re-runnable to upgrade versions.


You can use the following command on GCP:
> wget https://raw.githubusercontent.com/axium-lab/infrastructure-documentation/refs/heads/main/gcp.sh && chmod +x gcp.sh && ./gcp.sh

## 1. Before you start

You need Docker and your Quay token (the same one works for both `core` and `ui`).

```bash
docker login quay.io
```

## 2. Images

| Piece | Image                     |
| ----- | ------------------------- |
| core  | `quay.io/axiumlab/core`   |
| ui    | `quay.io/axiumlab/ui`     |

Each one publishes three tags:

| Tag         | What it is                                                    |
| ----------- | ------------------------------------------------------------- |
| `vX.Y.Z`    | A specific version (`v0.1.0`). **Use this one in production.** |
| `vX-latest` | The latest of the major (`v1-latest`).                        |
| `latest`    | The latest published.                                         |

```bash
docker pull quay.io/axiumlab/core:latest
docker pull quay.io/axiumlab/ui:latest
```

## 3. Startup

A dedicated network so the core can see Postgres:

```bash
docker network create axium
```

### PostgreSQL

```bash
docker run -d --name axium-db --network axium \
  --restart unless-stopped \
  -e POSTGRES_USER=axium \
  -e POSTGRES_PASSWORD=change-this \
  -e POSTGRES_DB=axium-api \
  -v axium-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
```

The `axium-pgdata` volume is the only state you have to preserve: neither the core nor the ui
write to disk.

### Core

Generate the master key once and store it somewhere safe:

```bash
openssl rand -hex 32
```

```bash
docker run -d --name axium-core --network axium \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://axium:change-this@axium-db:5432/axium-api \
  -e MASTER_ENCRYPTION_KEY=<the 64 characters from the previous step> \
  quay.io/axiumlab/core:latest
```

Those two variables are the only mandatory ones: without either of them —or with a key that
isn't 64 hexadecimal characters— the process refuses to start. Everything else is optional:

| Variable          | Default     | What it's for                                                       |
| ----------------- | ----------- | ------------------------------------------------------------------- |
| `PORT`            | `3000`      | Listening port.                                                     |
| `MAX_UPLOAD_SIZE` | `50mb`      | Ceiling for an uploaded file; it is held entirely in RAM per request. |
| `LOG_REQUESTS`    | off         | `true` for one log line per HTTP request.                           |
| `PUBLIC_BASE_URL` | —           | Public URL of the core. Only if there is a proxy in front terminating TLS. |
| `TRUST_PROXY`     | `false`     | `true` if there is a proxy in front terminating TLS.                |

On the first startup the core waits for Postgres (up to 30 seconds), installs the schema
itself and creates the initial user. Restarting it repeats nothing.

### Ui

```bash
docker run -d --name axium-ui --network axium \
  --restart unless-stopped \
  -p 3001:3001 \
  -e API_URL=http://localhost:3000/v1 \
  quay.io/axiumlab/ui:latest
```

`API_URL` is the ui's only variable, and **it is resolved by the user's browser, not by the
container**. It has to be the URL the core is reached at from the outside —in a real
deployment, something like `https://axium-api.your-domain.com/v1`. An internal Docker name
like `http://axium-core:3000/v1` **does not work**, even if the ui container can resolve it.
It must end in `/v1` with no trailing slash.

## 4. Check that it is up

```bash
curl http://localhost:3000/v1/health          # {"status":"ok"}
curl http://localhost:3000/v1/install/status  # {"state":"installed","version":1}
```

You need both: `/v1/health` answers `ok` even if the schema installation failed, so the one
that confirms Axium is usable is `install/status`. If it returns `not_installed` or
`partial`, check the logs:

```bash
docker logs axium-core | grep '\[install\]'
```

## 5. First login

Open `http://localhost:3001` and log in with the credentials the schema creates:

- **User:** `admin@axium.local`
- **Password:** `admin123456`

They are the same in every new installation and have full permissions. **Change them as soon
as you log in**: there is no way to set different initial credentials from the configuration.

## 6. Upgrading

```bash
docker pull quay.io/axiumlab/core:v0.2.0
docker stop axium-core && docker rm axium-core
# relaunch the docker run from step 3 with the new tag
```

The containers are disposable and the Postgres volume stays where it is. Same for the ui.

## Three things worth knowing beforehand

- **The master key cannot be rotated.** `MASTER_ENCRYPTION_KEY` encrypts the provider
  credentials stored in the database. If it is lost or changed, none of them can be
  decrypted and they all have to be entered again by hand.
- **There are no schema migrations.** The core installs the schema if the database is empty
  and touches nothing if it already exists, whatever version it is. Upgrading the image over
  a database from an earlier version does not upgrade the schema: ask us before moving up a
  major version.
- **If you serve the ui over HTTPS, `API_URL` has to be `https://`.** The browser blocks
  requests to `http://` from an `https` page without giving a clear network error.
