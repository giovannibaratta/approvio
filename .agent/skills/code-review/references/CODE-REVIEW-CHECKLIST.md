# Code Review Checklist

Use this checklist to ensure code quality before submitting your changes.

## Architectural Alignment

- [ ] Does the code follow the layer Responsibilities described by `explain-architecture` skill?
- [ ] Are business rules correctly located in the **Domain** layer?
- [ ] Does the **Controller** handle only mapping and HTTP concerns?
- [ ] Are external dependencies correctly abstracted via interfaces in **Services**?
- [ ] Is there any breaking change to the database schema or internal implementation ?

## Code Quality & Patterns

- [ ] Is the code concise and readable?
- [ ] Are comments used in the proper way?
- [ ] Does it use `fp-ts` patterns correctly (`TaskEither`, `pipe`)?
- [ ] Are there any prohibited `unknown` or `any` casts?

## Testing & Integrity

- [ ] Have you added/updated relevant tests?
- [ ] Did you run `yarn lint` and `yarn build`?
- [ ] Did all tests pass (unit and integration)?

## Documentation & Maintenance

- [ ] Have you updated relevant documentation?

## Bugs & Security

- [ ] Are there any obvious bugs?
- [ ] Are there any obvious race conditions?
- [ ] Are there any obvious deadlocks?
