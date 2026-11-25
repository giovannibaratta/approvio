import {Node, NodeAtOrAbove, NodeType, TenantContext} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository, WorkflowGetParentTemplateError} from "../workflow/interfaces"
import {
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  WorkflowTemplateRepository,
  WorkflowTemplateGetParentSpaceError
} from "../workflow-template/interfaces"
import {pipe} from "fp-ts/function"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "@services/transaction/interfaces"

@Injectable()
export class HierarchyService {
  constructor(
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN) private readonly workflowTemplateRepository: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN) private readonly workflowRepository: WorkflowRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactionManager: TenantTransactionManager
  ) {}

  getParents<T extends NodeType>(
    node: Node<T>,
    context: TenantContext
  ): TaskEither<
    WorkflowGetParentTemplateError | WorkflowTemplateGetParentSpaceError | TransactionError,
    NodeAtOrAbove<T>[]
  > {
    switch (node.type) {
      case "Org":
        return TE.right([])
      case "Group":
      case "Space":
      case "User":
        return TE.right([{type: "Org", identifier: context.organizationId}] as NodeAtOrAbove<T>[])
      case "WorkflowTemplate":
        return this.transactionManager.execute(context, () =>
          pipe(
            this.workflowTemplateRepository.getParentSpace(context, node.identifier),
            TE.chainW(spaceId =>
              pipe(
                this.getParents({type: "Space" as const, identifier: spaceId}, context),
                TE.map(parents => [{type: "Space" as const, identifier: spaceId}, ...parents])
              )
            ),
            TE.map(res => res as NodeAtOrAbove<T>[])
          )
        )
      case "Workflow":
        return this.transactionManager.execute(context, () =>
          pipe(
            this.workflowRepository.getParentWorkflowTemplate(context, node.identifier),
            TE.chainW(templateId =>
              pipe(
                this.getParents({type: "WorkflowTemplate" as const, identifier: templateId}, context),
                TE.map(parents => [{type: "WorkflowTemplate" as const, identifier: templateId}, ...parents])
              )
            ),
            TE.map(res => res as NodeAtOrAbove<T>[])
          )
        )
    }
  }
}
