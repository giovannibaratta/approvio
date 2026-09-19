import {AuthenticatedEntity, getEntityId, getEntityType, Actor} from "@domain"

export function extractActorDetails(requestor: AuthenticatedEntity): Actor {
  return {
    id: getEntityId(requestor),
    type: getEntityType(requestor),
    displayName: requestor.entityType === "user" ? requestor.user.displayName : requestor.agent.agentName
  }
}
