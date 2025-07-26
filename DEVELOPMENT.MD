# Development Guide

## Architecture

The application follows a clean architecture pattern with clear separation of concerns:

- **Domain Layer** (`app/domain/`): Core business entities and validation logic
- **Service Layer** (`app/services/`): Business logic and use case implementations
- **Controller Layer** (`app/controllers/`): HTTP API endpoints and request/response handling
- **External Layer** (`app/external/`): Database repositories and external service integrations
- **Main Layer** (`app/main/`): Application bootstrap, modules, and configuration

> The core application logic should be implemented in the domain and service layer, but due to performance implication some operation might be delegated to the external layer.

## Technology Stack

- **Framework**: NestJS with Express
- **Language**: TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: JWT with Passport
- **Migrations**: Liquibase
- **Testing**: Jest

## Prerequisites

- Node.js 22
- Docker and Docker Compose
- Yarn package manager

## Quick Start

### Installation

```bash
# Install dependencies
yarn install

# Start dependencies (PostgreSQL, etc.)
yarn deps:start

# Run database migrations
yarn db:migrate

# Update Prisma schema
yarn db:update-schema

# Start development server
yarn start:dev
```

### Testing

```bash
# Run all tests
yarn test
```

### Development Commands

```bash
# Lint code
yarn lint

# Format code
yarn format:prettier

# Build application
yarn build
```
