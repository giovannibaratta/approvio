import {Brand, brand} from "@utils"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"
import {TaskKind, TaskReadyEvent} from "./events"
import {OrganizationId} from "./shared"
import {DecoratedWorkflowActionTask} from "./workflow-tasks/base"
import {TaskState} from "./durable-task"

// Shared by deterministic task IDs and task.ready event IDs; changing it changes replay identities.
export const TASK_ID_NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"
declare const _TaskCreationBrand: unique symbol

interface TaskCreationData {
  readonly work: {
    readonly id: string
    readonly organizationId: OrganizationId
    readonly kind: TaskKind
    readonly state: TaskState
    readonly availableAt: Date
    readonly attempts: 0
    readonly fencing: 0n
    readonly createdAt: Date
    readonly updatedAt: Date
    readonly occ: bigint
  }
  readonly outbox: {
    readonly id: string
    readonly event: TaskReadyEvent
    readonly availableAt: Date
    readonly attempts: 0n
    readonly occ: 0n
    readonly createdAt: Date
  }
}

export type TaskCreation = Brand<TaskCreationData, typeof _TaskCreationBrand>

export class TaskCreationFactory {
  /** Derives initial work and publication data from an already validated task. */
  static create(
    task: DecoratedWorkflowActionTask<{occ: true}>,
    kind: TaskKind,
    sourceEventId: string,
    availableAt: Date
  ): TaskCreation {
    return brand<TaskCreationData, typeof _TaskCreationBrand>({
      work: {
        id: task.id,
        organizationId: task.organizationId,
        kind,
        state: task.status,
        availableAt,
        attempts: 0,
        fencing: 0n,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        occ: task.occ
      },
      outbox: {
        id: uuidv7(),
        event: {
          schemaVersion: 1,
          eventId: uuidv5(`${sourceEventId}:task.ready:${task.id}`, TASK_ID_NAMESPACE),
          taskOcc: task.occ,
          organizationId: task.organizationId,
          type: "task.ready",
          taskId: task.id,
          taskKind: kind
        },
        availableAt,
        attempts: 0n,
        occ: 0n,
        createdAt: task.createdAt
      }
    })
  }
}
