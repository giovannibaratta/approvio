# Schema Update Workflow

To update the database schema, follow these steps:

1.  **Modify Liquibase Migration Files:**
    - Locate the migration files in `db-migrations/`.
    - **Important:** Do NOT modify existing migration files as this will break the migration history.
    - Create NEW migration files (XML/YAML/SQL) to define your schema changes (even if they modify existing tables).
    - Ensure `root-changelog.yaml` or `test-root-changelog.yaml` includes your new change sets.

2.  **Apply Changes & Update Prisma:**
    - Run the automated command: `yarn deps:down && yarn db:update-schema`
    - This command will:
      1.  Stop and remove existing database containers.
      2.  Start a fresh database instance.
      3.  Apply all Liquibase migrations (including your new ones).
      4.  Pull the schema from the database into `prisma/schema.prisma`.
      5.  Regenerate the Prisma client.

3.  **Verify Changes:**
    - Check `prisma/schema.prisma` to ensure your changes are correctly reflected.
    - Check `db-migrations/` for correctness of your migration files.

## Alternative Manual Steps

If the automated command fails or you need more control:

1.  **Start Database:** `yarn deps:start`
2.  **Run Liquibase Update:** `yarn liquibase:update:dev`
3.  **Pull Schema:** `yarn prisma:pull` (Updates `prisma/schema.prisma`)
4.  **Generate Client:** `yarn prisma:generate`
