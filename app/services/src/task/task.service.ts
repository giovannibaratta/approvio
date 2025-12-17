import {Inject, Injectable} from "@nestjs/common"
import {TASK_REPOSITORY_TOKEN, TaskCreateError, TaskRepository, TaskUpdateChecks, TaskUpdateError} from "./interfaces"
import {DecoratedWorkflowActionWebhookPendingTask, Occ, WorkflowActionTaskDecoratorSelector} from "@domain"
import {DecoratedWorkflowActionEmailTask, WorkflowActionEmailTask, DecoratedWorkflowActionWebhookTask} from "@domain"
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

  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void> {
    return this.taskRepo.createWebhookTask(task)
  }

  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ> {
    return this.taskRepo.updateWebhookTask(task, checks)
  }
}
