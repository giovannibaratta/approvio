## Available Scripts

| Script Name             | Command                      | Description                                                                                                                                                | Blocking?  |
| :---------------------- | :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------- |
| `start:backend`         | `yarn start:backend`         | Starts the NestJS backend application using local environment variables from `.env.local`.                                                                 | Yes        |
| `start:backend:dev`     | `yarn start:backend:dev`     | Starts the NestJS backend application in development mode with file watching and debugging, using `.env.local`.                                            | Yes        |
| `start:worker`          | `yarn start:worker`          | Starts the NestJS worker application using local environment variables from `.env.local`.                                                                  | Yes        |
| `start:worker:dev`      | `yarn start:worker:dev`      | Starts the NestJS worker application in development mode with file watching and debugging, using `.env.local`.                                             | Yes        |
| `deps:start`            | `yarn deps:start`            | Starts project dependencies (e.g., Docker containers for database, etc.) using the `./scripts/dependencies.sh start` command.                              | Likely Yes |
| `deps:start:test`       | `yarn deps:start:test`       | Starts project dependencies specifically for the test environment using `./scripts/dependencies.sh start test`.                                            | Likely Yes |
| `deps:stop`             | `yarn deps:stop`             | Stops project dependencies using the `./scripts/dependencies.sh stop` command.                                                                             | No         |
| `deps:down`             | `yarn deps:down`             | Stops and removes project dependencies (e.g., Docker containers and their volumes) using the `./scripts/dependencies.sh down` command.                     | No         |
| `deps:rebuild`          | `yarn deps:rebuild`          | Rebuilds project dependencies (e.g., Docker images) using the `./scripts/dependencies.sh rebuild` command.                                                 | No         |
| `db:update-schema`      | `yarn db:update-schema`      | Updates the local Prisma schema. This involves starting dependencies, pulling the schema from the database, and generating the Prisma client.              | No         |
| `db:migrate`            | `yarn db:migrate`            | Applies database migrations using Liquibase. This script first ensures dependencies are running.                                                           | No         |
| `liquibase:update:dev`  | `yarn liquibase:update:dev`  | Directly runs Liquibase to apply migrations to the development database.                                                                                   | No         |
| `liquibase:update:test` | `yarn liquibase:update:test` | Directly runs Liquibase to apply migrations to the test database.                                                                                          | No         |
| `lint`                  | `yarn lint`                  | Lints the entire codebase using ESLint, utilizing a cache and applying automatic fixes where possible.                                                     | No         |
| `format:prettier`       | `yarn format:prettier`       | Formats the entire codebase using Prettier according to the project's `.prettierrc` configuration.                                                         | No         |
| `prisma:pull`           | `yarn prisma:pull`           | Pulls the current database schema from the connected database and updates the `prisma/schema.prisma` file. It also reformats the schema file.              | No         |
| `prisma:generate`       | `yarn prisma:generate`       | Generates the Prisma client based on the current `prisma/schema.prisma` file.                                                                              | No         |
| `build`                 | `yarn build`                 | Compiles both NestJS applications (backend and worker) TypeScript code into JavaScript.                                                                    | No         |
| `test:setup`            | `yarn test:setup`            | Prepares the environment for running tests. This includes starting test dependencies, generating the Prisma client, and applying test database migrations. | No         |
| `test:bootstrap-env`    | `yarn test:bootstrap-env`    | Bootstraps the test environment by running the test environment setup script.                                                                              | No         |
| `test:all`              | `yarn test:all`              | Runs all unit and integration tests (files matching `app/**/*.test.ts`) after performing `test:setup`. Uses environment variables from `.env.test`.        | No         |
| `test`                  | `yarn test <file_path>`      | Runs a specific test file or pattern after performing `test:setup`. Uses `.env.test`. The path to the test file/pattern must be appended to the command.   | No         |

## Usage Notes

- **Blocking Processes:** Scripts like `start:backend` and `start:worker` are long-running and will block the terminal. Use `&` to run them in the background if needed.
- **Dependencies:** `deps:*` scripts manage Docker containers. Ensure Docker is running.
- **Tests:** `test:all` runs everything. Use `yarn test <path>` for specific files.
