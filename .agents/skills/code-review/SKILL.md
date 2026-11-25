---
name: code-review
description: Provides guidelines for code style, architectural patterns, and layer-specific conventions.
---

# Code Review Skill

This skill ensures that code changes adhere to Approvio's standards, architectural patterns, and best practices.

## Core Responsibilities

- **Architectural Validation**: Ensure new code is aligned with the architecture described in the architecture described by the `explain-architecture` skill.
- **Style Review**: Enforce coding standards and functional programming patterns.
- **Quality Assurance**: Verify testing strategies and code integrity.

## Detailed Guidelines

Access detailed review criteria in these reference files:

- **[Code Style Guide](references/CODE-STYLE.md)**: Standards for conciseness, TypeScript usage, and FP-patterns.
- **[Testing Style Guide](references/TEST-STYLE.md)**: Rules for test structure, matchers, and integration strategies.
- **[Review Checklist](references/CODE-REVIEW-CHECKLIST.md)**: A quick reference checklist to run before completing tasks.

## Usage Guide

When asked to "write code", the agent should use this skill to ensure that the code is aligned with the architecture definition, and the code style guide.

When asked to "review code", the agent should check the proposed or existing changes against these guidelines and provide actionable feedback focused on maintaining system integrity and readability.
