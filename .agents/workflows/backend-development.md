---
description: Development workflow for Approvio Backend (Schema -> Domain -> Service -> Controller)
---

# Backend Development Workflow

This workflow outlines the standard steps for implementing new features or modifying existing ones in the Approvio Backend.

## Standard Development Steps

1.  **Schema Update (if needed):**
    - Update the database schema using Liquibase.
    - Run `yarn prisma generate` to update the Prisma client.
    - See `db-schema-changes` skill for more details.

2.  **Define Domain Unit Tests:**
    - Write tests for your entities and value objects in `app/domain`.
    - Ensure validation logic and business rules are covered.

3.  **Implement Domain Logic:**
    - Create or update entities and value objects in `app/domain`.
    - Implement factory methods and validation.

4.  **Write Controller Integration Tests:**
    - Define the expected API behavior in `app/controllers/test`.
    - These tests should fail initially (TDD).

5.  **Define Service and Dependency Interfaces:**
    - Define repository interfaces in the service layer (`app/services`).
    - Define any 3rd-party provider interfaces.

6.  **Implement External Dependencies:**
    - Implement the repository interfaces in `app/external`.
    - Map Prisma types to Domain types.

7.  **Implement Service Logic:**
    - Implement the business logic in `app/services`.
    - Use `TaskEither` and `fp-ts` patterns for error handling and composition.

8.  **Implement Controller Logic:**
    - Implement the HTTP endpoints in `app/controllers`.
    - Map requests/responses (OpenAPI <-> Service).

9.  **Code Review:**
    - Use the `code-review` skill to review the code and ensure it follows project conventions.

## Validation

- Use the `test-runner` skill to run integration and unit tests.
- Ensure correctness and prevent regressions before proceeding.

## Constraints

- **No Direct Git Actions:** Do not use `git commit`, `git stash`, or `git push` directly unless instructed.
- **Package Manager:** Use `yarn`, not `npm` or `npx`.
