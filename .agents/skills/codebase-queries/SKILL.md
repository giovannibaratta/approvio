---
name: codebase-queries
description: Explains the codebase architecture, layer responsibilities, and provides automated query scripts.
---

# Codebase Queries Skill

This skill provides automated tools and architectural context to navigate the Approvio codebase efficiently.

## Core Functionality

This skill enables the agent to:

- Identify which domain handles specific features.
- Locate existing services and their public methods.
- Identify the controllers responsible for API endpoints.
- Explore data persistence and shared utilities.

## Documentation & Tools

Detailed information is organized into specialized reference files:

- **Architecture & Layering** description is available in the skill `explain-architecture`
- **[Automated Scripts](references/SCRIPTS.md)**: Documentation for the automated search tools used to scan controllers, services, domains, repositories, and utils.

## Quick Start (Scripts)

All scripts are located in the `scripts/` directory and support keyword filtering:

```bash
# Example: List user-related services
./scripts/list-services.sh "user"
```

Refer to **[SCRIPTS.md](references/SCRIPTS.md)** for full parameter specifications and usage examples.
