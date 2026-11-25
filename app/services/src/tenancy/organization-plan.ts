import {PlanTier} from "@domain"

export const initialOrganizationPlanTier = (edition: "self_hosted" | "saas_cloud"): PlanTier =>
  edition === "self_hosted" ? "SELF_HOSTED_UNLIMITED" : "FREE"
