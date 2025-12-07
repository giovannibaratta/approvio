import {Inject, Injectable} from "@nestjs/common"
import {TASK_REPOSITORY_TOKEN, TaskRepository, TaskCreateError, TaskUpdateError, TaskUpdateChecks} from "./interfaces"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionEmailTask,
  WorkflowActionWebhookTask
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"

@Injectable()
export class TaskService {
  constructor(
    @Inject(TASK_REPOSITORY_TOKEN)
    private readonly taskRepo: TaskRepository
  ) {}

  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void> {
    return this.taskRepo.createEmailTask(task)
  }

  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    return this.taskRepo.updateEmailTask(task, checks)
  }

  createWebhookTask(task: DecoratedWorkflowActionWebhookTask<{occ: true}>): TaskEither<TaskCreateError, void> {
    return this.taskRepo.createWebhookTask(task)
  }

  updateWebhookTask(task: WorkflowActionWebhookTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    return this.taskRepo.updateWebhookTask(task, checks)
  }
}
