---
name: union-literal-extraction
description: Extracts all literal values (string, number, boolean) from a TypeScript union type or interface. Useful for resolving exhaustiveness check issues in switch statements.
---

# Union Literal Extraction Skill

This skill allows you to programmatically extract all possible literal values from a TypeScript union type or interface using a specialized script.

## When to use this skill

- When you encounter a TypeScript error related to non-exhaustive `switch` statements (e.g., "Type '...' is not comparable to type 'never'").
- When you need to know all possible values of a union type to implement a full set of handlers.
- When you want to verify if a `switch` statement or an `if/else` chain covers all possible cases of a type.

## Instructions

1.  **Identify the Type**:
    - Find the name of the union type or interface and the file where it is defined.
2.  **Execute the Script**:
    - Run the command: `yarn ai:get-union-literals <filepath> <typename>`.
    - Example: `yarn ai:get-union-literals app/domain/src/types.ts MyUnionType`.
3.  **Analyze the Output**:
    - The script will output a JSON array of literal values.
4.  **Resolve Exhaustiveness**:
    - Compare the list of literal values from the script against the cases handled in your `switch` statement.
    - Identify the missing values.
    - Implement the missing cases in the `switch` statement.
    - Ensure that the `default` case (if used for exhaustiveness checking) correctly narrows the type to `never`.

## Constraints

- The script requires a valid `tsconfig.json` in the root directory to resolve imports.
- It only works for literal unions (strings, numbers, booleans). It will not return complex objects or other types.
- Maximum nesting level for union resolution is 100.

## Examples

**User:** "Fix the exhaustiveness check in the workflow handler."
1. Identify the type: `WorkflowStatus` in `app/domain/src/workflow.ts`.
2. Run script: `yarn ai:get-union-literals app/domain/src/workflow.ts WorkflowStatus`.
3. Output: `["PENDING", "APPROVED", "REJECTED"]`.
4. Check code: The `switch` only handles `PENDING` and `APPROVED`.
5. Action: Add `REJECTED` case.
