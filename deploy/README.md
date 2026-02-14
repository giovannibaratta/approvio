# Deployment and Containerization

This directory contains the configuration and scripts for building, publishing, and deploying the Approvio services using Docker and Docker Compose.

## System Components

The Approvio system is composed of the following containerized services:

- **Backend (`approvio-backend`)**: The main NestJS API server.
- **Worker (`approvio-worker`)**: The background task processor.
- **Migrations (`approvio-migrations`)**: Liquibase-based utility for database schema management.

## Building Images

All Docker images should be built from the **root directory** of the project to ensure the build context includes all necessary source files and configurations.

### Build Backend

The backend and worker share the same Dockerfile but use different build targets.

```bash
docker build --target backend -t ghcr.io/$USERNAME/approvio-backend:0.0.1 -f deploy/Dockerfile .
```

### Build Worker

```bash
docker build --target worker -t ghcr.io/$USERNAME/approvio-worker:0.0.1 -f deploy/Dockerfile .
```

### Build Migrations

```bash
docker build -t ghcr.io/$USERNAME/approvio-migrations:0.0.1 -f deploy/Dockerfile.migrations .
```

## Publishing Images

Images are intended to be published to the GitHub Container Registry (GHCR).

1. **Login to GHCR**:

   ```bash
   echo $GITHUB_TOKEN | docker login ghcr.io -u $USERNAME --password-stdin
   ```

2. **Push the Images**:
   ```bash
   USERNAME=<your-username>
   docker push ghcr.io/$USERNAME/approvio-backend:0.0.1
   docker push ghcr.io/$USERNAME/approvio-worker:0.0.1
   docker push ghcr.io/$USERNAME/approvio-migrations:0.0.1
   ```

## Local Deployment with Docker Compose

The `deploy/` directory includes a template for Docker Compose that can be customized for different environments.

### 1. Generate `docker-compose.yml`

Use the `generate-compose.sh` script to create a customized `docker-compose.yml` file.

```bash
VERSION="0.0.1"
USERNAME="giovannibaratta"
OIDC_ISSUER_URL="http://localhost:4010"
OIDC_CLIENT_ID="development-client-id"
OIDC_CLIENT_SECRET="development-client-secret"

./generate-compose.sh \
  --version $VERSION \
  --registry-user $USERNAME \
  --oidc-issuer-url $OIDC_ISSUER_URL \
  --oidc-client-id $OIDC_CLIENT_ID \
  --oidc-client-secret $OIDC_CLIENT_SECRET \
  --oidc-redirect-uri $OIDC_REDIRECT_URI
```

**Common configuration arguments:**

- `--version`: The image tag to use (default: `0.0.1`).
- `--registry-user`: The GHCR username (default: `giovannibaratta`).
- `--postgres-password`: Password for the PostgreSQL database.
- `--jwt-secret`: Secret key for JWT signing.
- `--oidc-issuer-url`: The URL of your OIDC provider.
- `--oidc-client-id`: The client ID for your OIDC application.
- `--oidc-client-secret`: The client secret for your OIDC application.
- `--oidc-redirect-uri`: The redirect URI for OIDC authentication.
- `--oidc-allow-insecure`: Set to `true` to allow insecure OIDC connections (useful for local dev).

Review the `generate-compose.sh` script for a full list of available parameters (OIDC, Database, JWT, etc.).

### 2. Start the Services

Once generated, start the entire stack using:

```bash
docker compose -f docker-compose.yml up -d
```

The stack includes:

- **PostgreSQL**: Primary database.
- **Redis**: For rate limiting and job queuing.
- **Migration Init**: Automatically runs database migrations before the backend starts.
- **Backend**: API server (exposed on port 3000).
- **Worker**: Background processor.

**Note**: An external OIDC provider must be configured using the `--oidc-*` arguments in the generation script.
