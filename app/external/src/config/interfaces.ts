import {Option} from "fp-ts/lib/Option"

export type EmailProviderConfig = GenericEmailProviderConfig

export interface GenericEmailProviderConfig {
  type: "generic"
  smtpUsername: string
  smtpPassword: string
  smtpEndpoint: string
  smtpPort: number
  senderEmail: string
  allowSelfSignedCertificates: boolean
}

export interface OidcProviderConfig {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  allowInsecure?: boolean
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userinfoEndpoint?: string
  scopes?: string
}

export interface JwtConfig {
  secret: string
  trustedIssuers: [string, ...string[]]
  issuer: string
  audience: string
  accessTokenExpirationSec?: number
}

export interface RedisConfig {
  host: string
  port: number
  db: number
  prefix?: string
}

export interface ConfigProviderInterface {
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>
  oidcConfig: OidcProviderConfig
  jwtConfig: JwtConfig
  redisConfig: RedisConfig
}
