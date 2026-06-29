import {Injectable, Logger, OnApplicationBootstrap} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as client from "openid-client"
import {OidcError} from "@services/auth/interfaces"
import {ConfigProvider} from "../config/config-provider"
import {OidcProviderConfig} from "../config/interfaces"
import {OidcServerMetadata} from "./oidc-types"
import {isLeft} from "fp-ts/Either"

@Injectable()
export class OidcBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OidcBootstrapService.name)
  private rawConfigurations = new Map<string, client.Configuration>()
  private validatedConfigurations = new Map<string, OidcServerMetadata>()

  constructor(private readonly configProvider: ConfigProvider) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log("Initializing OIDC configurations during bootstrap...")

    const providers = this.configProvider.oidcProviders

    const discoveryPromises = Array.from(providers.entries()).map(async ([providerId, oidcConfig]) => {
      const configurationResult = await this.createConfiguration(oidcConfig)()

      if (isLeft(configurationResult)) {
        const error = configurationResult.left
        this.logger.error(`OIDC configuration initialization failed during bootstrap for provider ${providerId}`, {
          error
        })
        throw new Error(
          `Failed to initialize OIDC provider discovery for ${providerId}: ${error}. ` +
            "Application startup aborted. Please check OIDC configuration and provider availability."
        )
      }

      this.rawConfigurations.set(providerId, configurationResult.right)

      const validatedConfiguration = this.validateAndTransformConfiguration(configurationResult.right)
      this.validatedConfigurations.set(providerId, validatedConfiguration)

      this.logger.log(`OIDC configuration validated successfully during bootstrap for provider ${providerId}`)
      this.logger.log(`OIDC issuer for ${providerId}: ${validatedConfiguration.issuer}`)
    })

    await Promise.all(discoveryPromises)
    this.logger.log("All OIDC configurations initialized successfully.")
  }

  private createConfiguration(oidcConfig: OidcProviderConfig): TaskEither<OidcError, client.Configuration> {
    return TE.tryCatch(
      async () => {
        if (oidcConfig.override) {
          this.logger.log(`Initializing OIDC configuration manually for issuer ${oidcConfig.issuerUrl}`)

          const serverMetadata = {
            issuer: oidcConfig.issuerUrl,
            authorization_endpoint: oidcConfig.override.authorizationEndpoint,
            token_endpoint: oidcConfig.override.tokenEndpoint,
            userinfo_endpoint: oidcConfig.override.userinfoEndpoint
          }

          return new client.Configuration(serverMetadata, oidcConfig.clientId, oidcConfig.clientSecret)
        }

        this.logger.log(`Initializing OIDC discovery from ${oidcConfig.issuerUrl}`)

        const options: client.DiscoveryRequestOptions = {
          execute:
            oidcConfig.allowInsecure !== undefined && oidcConfig.allowInsecure === true
              ? [client.allowInsecureRequests]
              : []
        }

        const config = await client.discovery(
          new URL(oidcConfig.issuerUrl),
          oidcConfig.clientId,
          oidcConfig.clientSecret,
          undefined,
          options
        )

        this.logger.log(`OIDC discovery initialization completed successfully for ${oidcConfig.issuerUrl}`)
        return config
      },
      error => {
        this.logger.error(`OIDC initialization failed for ${oidcConfig.issuerUrl}`, error)
        if (error instanceof Error) {
          if (error.message.includes("Incomplete manual OIDC configuration")) throw error

          if (error.message.includes("network") || error.message.includes("timeout"))
            return "oidc_network_error" as const

          if (error.message.includes("discovery") || error.message.includes("well-known"))
            return "oidc_invalid_provider_response" as const
        }
        return "oidc_network_error" as const
      }
    )
  }

  getConfiguration(providerId: string): OidcServerMetadata {
    const config = this.validatedConfigurations.get(providerId)
    if (!config)
      throw new Error(
        `OIDC configuration not initialized for provider ${providerId}. Service may not have completed bootstrap. This should never happen at runtime.`
      )

    return config
  }

  getRawClientConfiguration(providerId: string): client.Configuration {
    const config = this.rawConfigurations.get(providerId)
    if (!config)
      throw new Error(
        `OIDC raw configuration not initialized for provider ${providerId}. Service may not have completed bootstrap. This should never happen at runtime.`
      )

    return config
  }

  private validateAndTransformConfiguration(config: client.Configuration): OidcServerMetadata {
    const rawMetadata = config.serverMetadata()

    // Validate that all required OIDC endpoints exist
    if (!rawMetadata.issuer) throw new Error("OIDC configuration missing required 'issuer' field")

    if (!rawMetadata.authorization_endpoint)
      throw new Error("OIDC configuration missing required 'authorization_endpoint' field")

    if (!rawMetadata.token_endpoint) throw new Error("OIDC configuration missing required 'token_endpoint' field")

    if (!rawMetadata.userinfo_endpoint) throw new Error("OIDC configuration missing required 'userinfo_endpoint' field")

    // Create validated server metadata with guaranteed non-null values
    const validatedMetadata: OidcServerMetadata = {
      issuer: rawMetadata.issuer,
      authorization_endpoint: rawMetadata.authorization_endpoint,
      token_endpoint: rawMetadata.token_endpoint,
      userinfo_endpoint: rawMetadata.userinfo_endpoint
    }

    return validatedMetadata
  }
}
