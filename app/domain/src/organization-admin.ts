import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {isEmail, isUUIDv4, PrefixUnion} from "@utils"

export const ORG_ADMIN_EMAIL_MAX_LENGTH = 512

export type OrganizationAdmin = Readonly<OrganizationAdminData>

interface OrganizationAdminData {
  id: string
  email: string
  createdAt: Date
}

type IdValidationError = "invalid_uuid"
type EmailValidationError = "email_empty" | "email_too_long" | "email_invalid"

export type OrganizationAdminValidationError = PrefixUnion<
  "organization_admin",
  UnprefixedOrganizationAdminValidationError
>

type UnprefixedOrganizationAdminValidationError = IdValidationError | EmailValidationError

export class OrganizationAdminFactory {
  /**
   * Creates a new OrganizationAdmin from input data
   * @param data The organization admin data to create
   * @returns Either validation error or valid OrganizationAdmin object
   */
  static newOrganizationAdmin(
    data: Omit<OrganizationAdminData, "id" | "createdAt">
  ): Either<OrganizationAdminValidationError, OrganizationAdmin> {
    const organizationAdmin: OrganizationAdminData = {
      id: randomUUID(),
      email: data.email,
      createdAt: new Date()
    }

    return OrganizationAdminFactory.validate(organizationAdmin)
  }

  /**
   * Validates an existing OrganizationAdmin object
   * @param data The OrganizationAdmin object to validate
   * @returns Either validation error or valid OrganizationAdmin object
   */
  static validate(data: OrganizationAdminData): Either<OrganizationAdminValidationError, OrganizationAdmin> {
    const idValidation = validateOrganizationAdminId(data.id)
    const emailValidation = validateOrganizationAdminEmail(data.email)

    if (isLeft(idValidation)) return idValidation
    if (isLeft(emailValidation)) return emailValidation

    return right({
      id: idValidation.right,
      email: emailValidation.right,
      createdAt: data.createdAt
    })
  }
}

function validateOrganizationAdminId(id: string): Either<OrganizationAdminValidationError, string> {
  if (!isUUIDv4(id)) return left("organization_admin_invalid_uuid")
  return right(id)
}

function validateOrganizationAdminEmail(email: string): Either<OrganizationAdminValidationError, string> {
  if (!email || email.trim().length === 0) return left("organization_admin_email_empty")
  if (email.length > ORG_ADMIN_EMAIL_MAX_LENGTH) return left("organization_admin_email_too_long")
  if (!isEmail(email)) return left("organization_admin_email_invalid")
  return right(email)
}
