import {AuthenticatedEntity, TenantContext} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"

export type ResolveResourceType = "space" | "group"

export interface ResourceResolveRequestItem {
  type: ResolveResourceType
  id: string
}

export interface ResourceResolveRequest {
  resources: ResourceResolveRequestItem[]
}

export interface ResourceResolvedItem {
  type: ResolveResourceType
  id: string
  name: string
}

export interface ResolveResourcesRequest extends TenantContext {
  requestor: AuthenticatedEntity
  request: ResourceResolveRequest
}

// TODO: WTF is this import
export type ResolveResourcesError = AuthorizationError | UnknownError | import("@domain").BoundaryError

export interface ResourceDeniedItem {
  type: ResolveResourceType
  id: string
  reason: "NOT_FOUND" | "NOT_AUTHORIZED"
}

export interface ResourceResolveResponse {
  resolved: ResourceResolvedItem[]
  denied: ResourceDeniedItem[]
}
