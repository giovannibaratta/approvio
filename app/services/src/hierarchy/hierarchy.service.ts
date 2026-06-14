import {Node, NodeAtOrAbove, NodeType} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {DEFAULT_ORG_ID} from "../constants"
import {UnknownError} from "@services/error"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowRepository} from "../workflow/interfaces"
import {WORKFLOW_TEMPLATE_REPOSITORY_TOKEN, WorkflowTemplateRepository} from "../workflow-template/interfaces"
import {pipe} from "fp-ts/function"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"

@Injectable()
export class HierarchyService {
  constructor(
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN) private readonly workflowTemplateRepository: WorkflowTemplateRepository,
    @Inject(WORKFLOW_REPOSITORY_TOKEN) private readonly workflowRepository: WorkflowRepository
  ) {}

  getParents<T extends NodeType>(node: Node<T>): TaskEither<UnknownError, NodeAtOrAbove<T>[]> {
    switch (node.type) {
      case "Org":
        return TE.right([])
      case "Group":
        return TE.right([{type: "Org", identifier: DEFAULT_ORG_ID}] as NodeAtOrAbove<T>[])
      case "Space":
        return TE.right([{type: "Org", identifier: DEFAULT_ORG_ID}] as NodeAtOrAbove<T>[])
      case "User":
        return TE.right([{type: "Org", identifier: DEFAULT_ORG_ID}] as NodeAtOrAbove<T>[])
      case "WorkflowTemplate":
        return pipe(
          this.workflowTemplateRepository.getParentSpace(node.identifier),
          TE.chainW(spaceId =>
            pipe(
              this.getParents({type: "Space" as const, identifier: spaceId}),
              TE.map(parents => [{type: "Space" as const, identifier: spaceId}, ...parents])
            )
          ),
          TE.mapLeft(() => "unknown_error" as const),
          TE.map(res => res as NodeAtOrAbove<T>[])
        )
      case "Workflow":
        return pipe(
          this.workflowRepository.getParentWorkflowTemplate(node.identifier),
          TE.chainW(templateId =>
            pipe(
              this.getParents({type: "WorkflowTemplate" as const, identifier: templateId}),
              TE.map(parents => [{type: "WorkflowTemplate" as const, identifier: templateId}, ...parents])
            )
          ),
          TE.mapLeft(() => "unknown_error" as const),
          TE.map(res => res as NodeAtOrAbove<T>[])
        )
    }
  }
}
