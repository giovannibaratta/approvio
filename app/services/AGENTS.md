## Services Layer

Contains the core business logic of the application, orchestrating domain objects and external dependencies.

### Responsibilities

- Implement use cases and business workflows
- Orchestrate interactions between domain entities and external dependencies
- Handle authorization and validation at the service level
- Manage transactional boundaries
- Transform between domain models and repository interfaces

### Patterns & Conventions

#### Service Structure

- Use NestJS `@Injectable()` decorator
- Inject dependencies via constructor using tokens
- Use `TaskEither` for asynchronous operations with error handling
- Implement functional programming patterns with `fp-ts`

#### Error Handling

- Define service-specific error union types
- Include authorization, validation, and unknown errors
- Use `TaskEither<ErrorType, SuccessType>` for all async operations
- Compose error types from domain validation errors

#### Dependency Injection

- Define repository interfaces in service layer
- Use exported tokens for dependency injection
- Keep interfaces focused and minimal

#### Functional Composition

- Use `pipe` for composing operations
- Chain operations with `TE.chainW` (TaskEither chain)
- Convert between `Either` and `TaskEither` as needed
- Preserve "this" context with lambda functions when needed

### Content

- `app/services/src/**/*service.ts`: Core business logic implementations
- `app/services/src/**/interfaces.ts`: Repository interfaces and error type definitions

### Example Pattern

```typescript
export type ServiceError = "business_error" | AuthorizationError | DomainValidationError | UnknownError

export const REPOSITORY_TOKEN = "REPOSITORY_TOKEN"

export interface Repository {
  method(param: Type): TaskEither<ServiceError, Result>
}

@Injectable()
export class BusinessService {
  constructor(
    @Inject(REPOSITORY_TOKEN)
    private readonly repo: Repository
  ) {}

  performAction(request: Request): TaskEither<ServiceError, Result> {
    const validateRequest = (req: Request) => {
      // validation logic
    }

    const persistData = (data: Type) => this.repo.method(data)

    return pipe(request, validateRequest, TE.fromEither, TE.chainW(persistData))
  }
}
```
