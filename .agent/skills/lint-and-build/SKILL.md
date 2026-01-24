---
name: lint-and-build
description: Handles code quality checks (linting) and project compilation (building). Can filter results to report only specific types of issues if requested.
---

# Lint and Build Skill

This skill manages the project's integrity by running lints and builds. It is capable of parsing large logs to find specific error types if the user requests them.

## When to use this skill
- When the user asks to "lint the code", "check for syntax errors", or "check code quality".
- When the user asks to "build the project" or "compile".
- When the user asks to "verify the codebase" (implies running both).
- When the user specifically asks to find certain errors (e.g., "Check for any 'unused variable' lint errors").

## Instructions

### 1. Analyze Intent & Filters
Determine which actions are required:
- **Lint Only:** Triggers: "lint", "check style".
- **Build Only:** Triggers: "build", "compile".
- **Both:** Triggers: "verify", "check everything", "pre-push check".

**Check for Filters:**
Did the user specify a category of issue? (e.g., "Show me *deprecation* warnings" or "Report *formatting* issues"), or "Report issues related to the *auth* service".
- **If YES:** Note the keywords (e.g., "deprecation", "indentation", "unused").
- **If NO:** Prepare to report ALL issues.

### 2. Execution
Run the necessary commands in the terminal.

**Step A: Linting** (If required)
- Run: `yarn lint`
- *Decision:* If linting fails and the user asked for a "build", ask the user if they want to proceed with the build anyway, or stop here (unless instructed to "fix and build").

**Step B: Building** (If required)
- Run: `yarn build`

### 3. Reporting Logic (Crucial)
Analyze the terminal output from the commands above.

**Scenario A: User provided specific filters**
- Scan the output lines.
- **Only** report the errors/warnings that contain the user's keywords or related error codes.
- Explicitly state: "Filtering results for [User's Keyword]..."
- If the specific issue is not found, report: "No issues found matching [Keyword]."

**Scenario B: No filters provided (Default)**
- Summarize the result (Pass/Fail).
- List **all** errors and warnings found.
- If the output is massive (>50 lines), summarize the top 3 most frequent errors and ask the user if they want the full log.

## Constraints
- Do not run `yarn install` unless the commands fail due to missing packages.
- If the build fails, analyze the stack trace and provide the likely cause (e.g., missing type definition, syntax error).

## Examples

**User:** "Build the project."
**Action:** `yarn build`
**Report:** "Build successful." (or list of build errors)

**User:** "Lint the code but only tell me about unused variables."
**Action:** `yarn lint`
**Report:** Analyzes output, ignores formatting errors, and lists only `no-unused-vars` errors.

**User:** "Check the code integrity."
**Action:** Runs `yarn lint` followed by `yarn build` (if lint passes). Reports all issues.