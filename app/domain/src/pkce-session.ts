import {Either, isLeft, left, right} from "fp-ts/Either"
import {Brand, brand, isObject} from "@utils"
import {StepUpOperation} from "./authenticated-entity"

interface PkceDataBase {
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly oidcState: string
  readonly providerId: string
}

export interface InitialLoginPkceData extends PkceDataBase {
  readonly flow: "initial_login"
}

export interface InitialCliLoginPkceData extends PkceDataBase {
  readonly flow: "initial_cli_login"
}

export interface StepUpPkceData extends PkceDataBase {
  readonly flow: "step_up"
  readonly sessionId: string
  readonly stepUpTarget: {
    readonly organizationId: string
    readonly operation: StepUpOperation
    readonly resourceId: string
    readonly contextVersion: bigint
  }
}

export type PkceData = InitialLoginPkceData | InitialCliLoginPkceData | StepUpPkceData
export type PkceStorageData = PkceData & {readonly createdAt: Date; readonly expiresAt: Date}
type PkceSessionProps = PkceStorageData & {readonly state: string; readonly occ: bigint; readonly usedAt?: Date}

declare const _PkceSessionBrand: unique symbol
export type PkceSessionData = Brand<PkceSessionProps, typeof _PkceSessionBrand>

export type PkceSessionValidationError =
  | "pkce_session_malformed_object"
  | "pkce_session_invalid_state"
  | "pkce_session_invalid_code_verifier"
  | "pkce_session_invalid_redirect_uri"
  | "pkce_session_invalid_oidc_state"
  | "pkce_session_invalid_provider_id"
  | "pkce_session_invalid_created_at"
  | "pkce_session_invalid_expires_at"
  | "pkce_session_invalid_occ"
  | "pkce_session_invalid_used_at"
  | "pkce_session_invalid_flow"
  | "pkce_session_unexpected_step_up_context"
  | "pkce_session_invalid_session_id"
  | "pkce_session_invalid_step_up_target"
  | "pkce_session_invalid_organization_id"
  | "pkce_session_invalid_operation"
  | "pkce_session_invalid_resource_id"
  | "pkce_session_invalid_context_version"

export class PkceSessionFactory {
  static validate(data: unknown): Either<PkceSessionValidationError, PkceSessionData> {
    if (!isObject(data)) return left("pkce_session_malformed_object")
    if (typeof data.state !== "string") return left("pkce_session_invalid_state")
    if (typeof data.codeVerifier !== "string") return left("pkce_session_invalid_code_verifier")
    if (typeof data.redirectUri !== "string") return left("pkce_session_invalid_redirect_uri")
    if (typeof data.oidcState !== "string") return left("pkce_session_invalid_oidc_state")
    if (typeof data.providerId !== "string") return left("pkce_session_invalid_provider_id")
    if (!isValidDate(data.createdAt)) return left("pkce_session_invalid_created_at")
    if (!isValidDate(data.expiresAt)) return left("pkce_session_invalid_expires_at")
    if (typeof data.occ !== "bigint") return left("pkce_session_invalid_occ")
    if (data.usedAt !== undefined && !isValidDate(data.usedAt)) return left("pkce_session_invalid_used_at")

    const metadata = {
      state: data.state,
      codeVerifier: data.codeVerifier,
      redirectUri: data.redirectUri,
      oidcState: data.oidcState,
      providerId: data.providerId,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      occ: data.occ,
      usedAt: data.usedAt
    }
    if (data.flow === "initial_login" || data.flow === "initial_cli_login") {
      if (data.sessionId !== undefined || data.stepUpTarget !== undefined)
        return left("pkce_session_unexpected_step_up_context")
      return right(brand<PkceSessionProps, typeof _PkceSessionBrand>({...metadata, flow: data.flow}))
    }
    if (data.flow !== "step_up") return left("pkce_session_invalid_flow")
    if (typeof data.sessionId !== "string") return left("pkce_session_invalid_session_id")
    const target = validateStepUpTarget(data.stepUpTarget)
    if (isLeft(target)) return target
    return right(
      brand<PkceSessionProps, typeof _PkceSessionBrand>({
        ...metadata,
        flow: "step_up",
        sessionId: data.sessionId,
        stepUpTarget: target.right
      })
    )
  }
}

function validateStepUpTarget(data: unknown): Either<PkceSessionValidationError, StepUpPkceData["stepUpTarget"]> {
  if (!isObject(data)) return left("pkce_session_invalid_step_up_target")
  if (typeof data.organizationId !== "string") return left("pkce_session_invalid_organization_id")
  if (data.operation !== "admin_action" && data.operation !== "delete_organization")
    return left("pkce_session_invalid_operation")
  if (typeof data.resourceId !== "string") return left("pkce_session_invalid_resource_id")
  if (typeof data.contextVersion !== "bigint") return left("pkce_session_invalid_context_version")
  return right({
    organizationId: data.organizationId,
    operation: data.operation,
    resourceId: data.resourceId,
    contextVersion: data.contextVersion
  })
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}
