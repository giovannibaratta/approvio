#!/bin/bash
set -e

# Default values
VERSION="0.0.1"
REGISTRY_USER="giovannibaratta"
POSTGRES_USER="approvio"
POSTGRES_PASSWORD="password"
POSTGRES_DB="approvio"
JWT_SECRET="this-is-a-secret"
JWT_TRUSTED_ISSUERS="approvio"
JWT_ISSUER="approvio"
JWT_AUDIENCE="approvio-api"
ENV="production"
LOG_LEVEL="info"
OIDC_ISSUER_URL=""
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
OIDC_REDIRECT_URI="http://localhost:3000/auth/callback"
OIDC_ALLOW_INSECURE="false"

# Parsing arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --version) VERSION="$2"; shift ;;
        --registry-user) REGISTRY_USER="$2"; shift ;;
        --postgres-user) POSTGRES_USER="$2"; shift ;;
        --postgres-password) POSTGRES_PASSWORD="$2"; shift ;;
        --postgres-db) POSTGRES_DB="$2"; shift ;;
        --jwt-secret) JWT_SECRET="$2"; shift ;;
        --jwt-trusted-issuers) JWT_TRUSTED_ISSUERS="$2"; shift ;;
        --jwt-issuer) JWT_ISSUER="$2"; shift ;;
        --jwt-audience) JWT_AUDIENCE="$2"; shift ;;
        --env) ENV="$2"; shift ;;
        --log-level) LOG_LEVEL="$2"; shift ;;
        --oidc-issuer-url) OIDC_ISSUER_URL="$2"; shift ;;
        --oidc-client-id) OIDC_CLIENT_ID="$2"; shift ;;
        --oidc-client-secret) OIDC_CLIENT_SECRET="$2"; shift ;;
        --oidc-redirect-uri) OIDC_REDIRECT_URI="$2"; shift ;;
        --oidc-allow-insecure) OIDC_ALLOW_INSECURE="true" ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

# Export variables for envsubst
export VERSION
export REGISTRY_USER
export POSTGRES_USER
export POSTGRES_PASSWORD
export POSTGRES_DB
export JWT_SECRET
export JWT_TRUSTED_ISSUERS
export JWT_ISSUER
export JWT_AUDIENCE
export ENV
export LOG_LEVEL
export OIDC_ISSUER_URL
export OIDC_CLIENT_ID
export OIDC_CLIENT_SECRET
export OIDC_REDIRECT_URI
export OIDC_ALLOW_INSECURE

# Generate docker-compose.yml
# We use a temp file to avoid issues if the script is run multiple times or if envsubst fails partial file write
envsubst < docker-compose.template.yml > docker-compose.yml

echo "Successfully generated $(dirname "$0")/docker-compose.yml with:"
echo "VERSION=$VERSION"
echo "REGISTRY_USER=$REGISTRY_USER"
echo "ENV=$ENV"
