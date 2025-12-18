import {Inject, Injectable} from "@nestjs/common"
import {
  TASK_REPOSITORY_TOKEN,
  TaskCreateError,
  TaskGetErrorWebhookTask,
  TaskGetErrorEmailTask,
  TaskLockError,
  TaskReference,
  TaskRepository,
  TaskUpdateChecks,
  TaskUpdateError
} from "./interfaces"
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

  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, Occ> {
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

  lockTask(taskReference: TaskReference, lockOwner: string): TaskEither<TaskLockError, {occ: bigint}> {
    return this.taskRepo.lockTask(taskReference, lockOwner)
  }

  getWebhookTask(taskId: string): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return this.taskRepo.getWebhookTask(taskId)
  }

  getEmailTask(taskId: string): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return this.taskRepo.getEmailTask(taskId)
  }

  releaseLock(taskReference: TaskReference, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    return this.taskRepo.releaseLock(taskReference, checks)
  }
}
