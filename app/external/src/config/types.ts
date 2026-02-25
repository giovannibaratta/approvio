/**
 * Allowed OIDC providers for the application.
 */
export const ALLOWED_OIDC_PROVIDERS = ["auth0", "zitadel", "keycloak", "custom"] as const

/**
 * Type representing one of the allowed OIDC providers.
 */
export type OidcProvider = (typeof ALLOWED_OIDC_PROVIDERS)[number]

/**
 * Type guard to check if a string is a valid OIDC provider.
 * @param provider The string to check.
 */
export function isOidcProvider(provider: string): provider is OidcProvider {
  return (ALLOWED_OIDC_PROVIDERS as readonly string[]).includes(provider)
}
