---
name: development-workflow
description: Guides the development process from schema updates to controller implementation.
---

# Development Workflow Skill

This skill outlines the standard workflow for implementing new features or modifying existing ones.

## Standard Development Steps

1.  **Schema Update (if needed):**
    - See `db-schema-changes` skill.

2.  **Define Domain Unit Tests.**
    - Write tests for your entities and value objects.
    - Ensure validation logic is covered.

3.  **Implement Domain Logic.**
    - Create or update entities in `app/domain`.
    - Implement factory methods and validation.

4.  **Write Controller Integration Tests.**
    - Define the expected API behavior.
    - These tests should fail initially.

5.  **Define Service and Dependency Interfaces.**
    - Define repository interfaces in the service layer.
    - Define any 3rd-party provider interfaces.

6.  **Implement External Dependencies.**
    - Implement the repository interfaces in `app/external`.
    - Map Prisma types to Domain types.

7.  **Implement Service Logic.**
    - Implement the business logic in `app/services`.
    - Use `TaskEither` and `fp-ts` patterns.

8.  **Implement Controller Logic.**
    - Implement the HTTP endpoints in `app/controllers`.
    - Map requests/responses (OpenAPI <-> Service).

9.  **Code Review**
    - Use the `code-review` skill to review the code.

## Validation

Use test-runner skill to run tests.

Ensure correctness and prevent regressions before proceeding.

## Constraints

- **No Direct Git Actions:** Do not use `git commit`, `git stash`, or `git push` directly unless instructed.
- **Package Manager:** Use `yarn`, not `npm` or `npx`.
