---
name: db-schema-changes
description: Handles database schema modifications, migrations using Liquibase, and updating the Prisma client.
---

# Database Schema Changes Skill

This skill guides you through the process of modifying the database schema, creating migrations, and updating the application to reflect these changes.

## When to use this skill

- When you need to add, modify, or remove database tables or columns.
- When working with Liquibase migrations (`db-migrations/`).
- When updating the Prisma schema (`prisma/schema.prisma`).
- When regenerating the Prisma client.

## Core Documentation

Detailed workflows and script references are available in the following files:

- **[Schema Update Workflow](references/SCHEMA-UPDATE-WORKFLOW.md)**: Steps for modifying migrations and updating the Prisma client.
- **[Available Scripts](references/AVAILABLE-SCRIPTS.md)**: Reference for all database and migration related scripts.

## Constraints & Best Practices

- **Do not edit `schema.prisma` manually** for schema definition changes. It is auto-generated from the database schema via `prisma:pull`.
- **Always use Liquibase** for schema changes to ensure version control and reproducibility.
- **Avoid business logic** in the database layer. Focus on data persistence.
- **Use `TaskEither`** for all database operations in the application code.
