## Worker Layer

Contains the background worker application that handles asynchronous job processing and event-driven architecture components.

### Patterns & Conventions

#### Worker Structure

- Use NestJS `@Processor()` decorator for queue processors
- Use `@Process()` decorator for specific job handlers

#### Job Processing

- Use deterministic task IDs for idempotency
- Implement proper error handling and logging
- The logic implemented should be resilient to failure and idempotent. It should always assume that a job can be retried multiple times and the overall semantic for the actions performed should be at least one. This might clash with the idempotency requirement of the job, the meaning is that the result of the job should be idempotent but the actions taken to complete the job might be triggered multiple times.

### Content

- `app/worker/src/main.ts`: Worker application bootstrap and graceful shutdown
- `app/worker/src/worker.module.ts`: Worker module configuration and providers
- `app/worker/src/worker.constants.ts`: Worker-specific constants
- `app/worker/src/processor/*.ts`: Queue processors for different job types

### Example Pattern

```typescript
@Processor(QUEUE_NAME)
export class ExampleProcessor {
  constructor(
    private readonly service: ExampleService,
    private readonly queueService: QueueService
  ) {}

  @Process("job-type")
  async handleJob(job: Job<JobData>) {
    const data = job.data
    Logger.log(`Processing job ${job.id} with data: ${JSON.stringify(data)}`)

    const result = await pipe(
      TE.Do,
      TE.bindW("entity", () => this.service.getEntity(data.entityId)),
      TE.chainW(({entity}) => this.processEntity(entity, data)),
      TE.mapLeft(error => {
        Logger.error(`Failed to process job ${job.id}`, error)
        return error
      })
    )()

    if (isLeft(result)) throw new Error(`Job processing failed: ${JSON.stringify(result.left)}`)

    return result.right
  }
}
```
