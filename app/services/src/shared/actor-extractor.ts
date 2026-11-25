import {AuthenticatedEntity, getEntityId, getEntityType, OriginatingActor} from "@domain"

export function extractActorDetails(requestor: AuthenticatedEntity): OriginatingActor {
  return {
    id: getEntityId(requestor),
    type: getEntityType(requestor),
    displayName: requestor.entityType === "user" ? requestor.user.displayName : requestor.agent.agentName
  }
}
