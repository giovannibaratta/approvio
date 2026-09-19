# Available Scripts

All scripts must be executed using `yarn`.

| Script Name            | Command                     | Description                                    |
| :--------------------- | :-------------------------- | :--------------------------------------------- |
| `deps:start`           | `yarn deps:start`           | Starts database dependencies (Docker).         |
| `deps:stop`            | `yarn deps:stop`            | Stops database dependencies.                   |
| `deps:down`            | `yarn deps:down`            | Stops and removes database containers/volumes. |
| `db:update-schema`     | `yarn db:update-schema`     | Updates local Prisma schema (full cycle).      |
| `db:migrate`           | `yarn db:migrate`           | Applies Liquibase migrations.                  |
| `liquibase:update:dev` | `yarn liquibase:update:dev` | Runs Liquibase on dev DB.                      |
| `prisma:pull`          | `yarn prisma:pull`          | Pulls DB schema to `schema.prisma`.            |
| `prisma:generate`      | `yarn prisma:generate`      | Generates Prisma client.                       |
