# Scripts Reference

This skill provides automated tools to quickly scan the codebase and extract metadata about controllers, services, domains, repositories, and utilities.

## Parameter Specification

All scripts support the following parameters:
`script.sh [keywords] [project_root]`

| Parameter        | Type     | Description                                                                               |
| :--------------- | :------- | :---------------------------------------------------------------------------------------- |
| **keywords**     | `string` | (Optional) Comma-separated list of words to filter filenames (e.g., `"user,auth"`).       |
| **project_root** | `string` | (Optional) Path to the project root. Defaults to auto-detection from the script location. |

## Available Scripts

| Script                         | Purpose                             | Targeted Path (Relative to Root) |
| :----------------------------- | :---------------------------------- | :------------------------------- |
| `scripts/list-controllers.sh`  | Lists HTTP Controllers & methods    | `app/controllers/src/`           |
| `scripts/list-services.sh`     | Lists Services & public methods     | `app/services/src/`              |
| `scripts/list-domains.sh`      | Lists Entities, Types, Enums        | `app/domain/src/`                |
| `scripts/list-repositories.sh` | Lists DB Repositories & methods     | `app/external/src/database/`     |
| `scripts/list-utils.sh`        | Lists Utility functions & constants | `app/utils/src/`                 |

## Usage Examples

```bash
# List everything in services
scripts/list-services.sh

# List controllers related to 'auth'
scripts/list-controllers.sh "auth"

# List repositories for 'user' and 'group'
scripts/list-repositories.sh "user,group"
```
