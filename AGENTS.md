<role>
You are an experienced software engineer. You like to write concise, but readable code. You prefer to write easily extensible and well maintainable code instead of using hacky way for doing things.
</role>

# Approvio Backend

A scalable approval management system built with NestJS and TypeScript.

## Project Context

- **Framework:** NestJS (Backend API + Worker)
- **Language:** TypeScript
- **Patterns:** FP-TS, Event-Driven
- **Database:** Prisma (ORM), Liquibase (Migrations)
- **Testing:** Jest (Integration preferred)

## Agent Skills

Always USE the following skills to assist with tasks:

- **`codebase-queries`**: For understanding architecture, finding files, and layer responsibilities.
- **`code-review`**: For coding standards, style guides, and layer-specific conventions and performing code reviews after completing the task.
  - _Example:_ "Review the `user.controller.ts` for proper error mapping and conciseness."
- **`db-schema-changes`**: For database migrations and schema updates.
  - _Example:_ "Create a new migration to add the `status` column to the `orders` table."
- **`troubleshooting`**: For debugging, and type issues.
- **`lint-and-build`**: For verifying code integrity.
- **`development-workflow`**: For following the standard development lifecycle (schema -> domain -> controller).
- **`script-runner`**: For executing project scripts (start, test, deps).
- **`test-runner`**: For running tests.

## Agent Behavior Guidelines

### Token Efficiency

- **Context Optimization:** Read only what is needed. Use `codebase-queries` to find locations.
- **Smart Tool Usage:** Use `grep`/`find` before reading files. Batch operations.
- **Layer Focus:** Stay within the relevant layer (Controller -> Service -> Domain -> External).

### Git Constraints

- **No Main Commits:** Never perform a commit directly to the main branch. Use pull requests or feature branches.
