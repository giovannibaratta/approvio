## Main Application Layer

Contains the main NestJS application setup, entry points, modules, and authentication logic.

### Responsibilities

- Bootstrap the NestJS application
- Configure module dependencies and imports
- Handle authentication and authorization setup
- Define application-wide middleware and pipes
- Manage JWT strategy and guards

### Patterns & Conventions

#### Module Organization

- Use NestJS `@Module()` decorator
- Import feature modules (controllers, services, external)
- Keep the root `AppModule` minimal and focused on imports
- Organize auth logic in dedicated `AuthModule`

#### Authentication

- Use Passport.js with JWT strategy
- Validate JWT tokens and extract user information
- Throw `UnauthorizedException` for invalid tokens
- Validate environment variables in constructor (fail fast)

#### Application Bootstrap

- Use NestJS factory pattern in `main.ts`
- Configure global pipes for validation
- Set up proper error handling
- Configure CORS and other middleware as needed

#### Environment Configuration

- Validate required environment variables at startup
- Throw clear errors for missing configuration
- Use process.env directly for critical configuration like JWT secrets

### Content

- `app/main/src/main.ts`: Application bootstrap and startup
- `app/main/src/app.module.ts`: Root application module
- `app/main/src/auth/`: Authentication setup (JWT strategy, guards, decorators)
- `app/main/src/**/*.ts`: Application-wide configuration and middleware
