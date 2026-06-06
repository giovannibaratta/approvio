import {mapWorkflowActionToApi, mapWorkflowTemplateToApi} from "../../src/workflow-templates/workflow-templates.mappers"
import {WorkflowActionType, WebhookActionHttpMethod, WebhookActionRedactScope} from "@domain"
import {createMockWorkflowTemplateDomain} from "@test/mock-data"
import "@utils/matchers"

type TestWebhookAction = {
  type: string
  url: string
  method: string
  headers?: Record<string, string>
  redact?: string
}

describe("workflow-templates.mappers", () => {
  describe("mapWorkflowActionToApi", () => {
    describe("Webhook Actions Redaction", () => {
      it("should map webhook actions with non-sensitive URLs and headers without redacting them when using default/smart scope", () => {
        // Given: a webhook action with non-sensitive URL and headers and default scope (unspecified)
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?userId=123&status=active",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "req-12345"
          }
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action)

        // Expect: the mapped action is not redacted
        expect(result).toEqual({
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?userId=123&status=active",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "req-12345"
          }
        })
      })

      it("should redact sensitive query parameters in URL with default/smart scope", () => {
        // Given: sensitive parameter names
        const sensitiveParams = ["auth", "token", "secret", "key", "password", "credential"]

        for (const param of sensitiveParams) {
          // Given: a webhook action with a sensitive query parameter and default scope
          const action = {
            type: WorkflowActionType.WEBHOOK,
            url: `https://api.example.com/v1/callback?userId=123&${param}=sensitive_val&other=normal`,
            method: WebhookActionHttpMethod.POST
          } as const

          // When: the action is mapped to API
          const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

          // Expect: the sensitive query parameter is redacted
          expect(result.type).toBe(WorkflowActionType.WEBHOOK)
          const urlObj = new URL(result.url)
          expect(urlObj.searchParams.get(param)).toBe("***")
          expect(urlObj.searchParams.get("userId")).toBe("123")
          expect(urlObj.searchParams.get("other")).toBe("normal")
        }
      })

      it("should redact sensitive parameters in URL case-insensitively with default/smart scope", () => {
        // Given: a webhook action with mixed-case sensitive query parameters and default scope
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?SECRET_TOKEN=abc&NormalKey=def&NormalParam=ghi",
          method: WebhookActionHttpMethod.POST
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: the mixed-case sensitive query parameters are redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        const urlObj = new URL(result.url)
        expect(urlObj.searchParams.get("SECRET_TOKEN")).toBe("***")
        expect(urlObj.searchParams.get("NormalKey")).toBe("***")
        expect(urlObj.searchParams.get("NormalParam")).toBe("ghi")
      })

      it("should redact user and password basic auth credentials embedded in URL with default/smart scope", () => {
        // Given: a webhook action with basic auth credentials in the URL
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://admin_user:secret_password@api.example.com/v1/callback?userId=123",
          method: WebhookActionHttpMethod.POST
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: the username and password in the URL are redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        const urlObj = new URL(result.url)
        expect(urlObj.username).toBe("***")
        expect(urlObj.password).toBe("***")
        expect(urlObj.searchParams.get("userId")).toBe("123")
      })

      it("should redact sensitive headers with default/smart scope", () => {
        // Given: a webhook action with sensitive headers and default scope
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token123",
            "X-API-KEY": "api-key-456",
            "x-webhook-secret": "secret789",
            Password: "pass",
            "X-Credential-Id": "cred"
          }
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: the sensitive headers are redacted while non-sensitive ones are preserved
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        expect(result.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "***",
          "X-API-KEY": "***",
          "x-webhook-secret": "***",
          Password: "***",
          "X-Credential-Id": "***"
        })
      })

      it("should redact ALL headers completely but smart-redact URL when redact scope is HEADERS", () => {
        // Given: a webhook action with redact: HEADERS
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?normalParam=val&secretParam=key_is_sensitive",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "12345"
          },
          redact: WebhookActionRedactScope.HEADERS
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: all headers are redacted, URL is smart-redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        expect(result.headers).toEqual({
          "Content-Type": "***",
          "X-Request-Id": "***"
        })
        const urlObj = new URL(result.url)
        expect(urlObj.searchParams.get("normalParam")).toBe("val")
        expect(urlObj.searchParams.get("secretParam")).toBe("***")
        expect(result.redact).toBe("HEADERS")
      })

      it("should redact ALL URL query parameters completely but smart-redact headers when redact scope is URL", () => {
        // Given: a webhook action with redact: URL
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?normalParam=val&secretParam=key_is_sensitive",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token"
          },
          redact: WebhookActionRedactScope.URL
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: all URL params are redacted, headers are smart-redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        const urlObj = new URL(result.url)
        expect(urlObj.searchParams.get("normalParam")).toBe("***")
        expect(urlObj.searchParams.get("secretParam")).toBe("***")
        expect(result.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "***"
        })
        expect(result.redact).toBe("URL")
      })

      it("should redact ALL headers and ALL URL query parameters completely when redact scope is ALL", () => {
        // Given: a webhook action with redact: ALL
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "https://api.example.com/v1/callback?normalParam=val",
          method: WebhookActionHttpMethod.POST,
          headers: {
            "Content-Type": "application/json"
          },
          redact: WebhookActionRedactScope.ALL
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: both are fully redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        const urlObj = new URL(result.url)
        expect(urlObj.searchParams.get("normalParam")).toBe("***")
        expect(result.headers).toEqual({
          "Content-Type": "***"
        })
        expect(result.redact).toBe("ALL")
      })

      it("should gracefully handle invalid URLs without crashing", () => {
        // Given: a webhook action with an invalid URL string
        const action = {
          type: WorkflowActionType.WEBHOOK,
          url: "not-a-valid-url",
          method: WebhookActionHttpMethod.POST,
          headers: {
            Authorization: "Bearer token123",
            "Content-Type": "application/json"
          }
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action) as unknown as TestWebhookAction

        // Expect: mapping fallback succeeds and sensitive headers are still redacted
        expect(result.type).toBe(WorkflowActionType.WEBHOOK)
        expect(result.url).toBe("not-a-valid-url")
        expect(result.headers).toEqual({
          Authorization: "***",
          "Content-Type": "application/json"
        })
      })
    })

    describe("Other Actions mapping", () => {
      it("should map EMAIL actions correctly", () => {
        // Given: an email action
        const action = {
          type: WorkflowActionType.EMAIL,
          recipients: ["user1@example.com", "user2@example.com"]
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action)

        // Expect: the recipients are mapped correctly
        expect(result).toEqual({
          type: WorkflowActionType.EMAIL,
          recipients: ["user1@example.com", "user2@example.com"]
        })
      })

      it("should map SLACK actions and redact the webhookUrl while preserving domain and path prefix", () => {
        // Given: a Slack action with a sensitive webhookUrl matching Slack services format
        const action = {
          type: WorkflowActionType.SLACK,
          webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action)

        // Expect: the Slack webhookUrl is redacted to keep the '/services' prefix
        expect(result).toEqual({
          type: WorkflowActionType.SLACK,
          webhookUrl: "https://hooks.slack.com/services/***"
        })
      })

      it("should map SLACK actions and redact the webhookUrl while keeping domain origin for non-standard slack webhooks", () => {
        // Given: a Slack action with a sensitive webhookUrl with custom path format
        const action = {
          type: WorkflowActionType.SLACK,
          webhookUrl: "https://slack.example.com/custom/webhook/path/token"
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action)

        // Expect: the Slack webhookUrl is redacted to keep the domain origin only
        expect(result).toEqual({
          type: WorkflowActionType.SLACK,
          webhookUrl: "https://slack.example.com/***"
        })
      })

      it("should fallback to fully redacting Slack webhookUrl to *** on parse failure", () => {
        // Given: a Slack action with an invalid Slack webhookUrl
        const action = {
          type: WorkflowActionType.SLACK,
          webhookUrl: "not-a-valid-slack-url"
        } as const

        // When: the action is mapped to API
        const result = mapWorkflowActionToApi(action)

        // Expect: the Slack webhookUrl is fully redacted to '***'
        expect(result).toEqual({
          type: WorkflowActionType.SLACK,
          webhookUrl: "***"
        })
      })
    })
  })

  describe("mapWorkflowTemplateToApi", () => {
    it("should map template and redact sensitive fields in actions", () => {
      // Given: a template domain object with webhook action containing sensitive info
      const templateDomain = createMockWorkflowTemplateDomain({
        actions: [
          {
            type: WorkflowActionType.WEBHOOK,
            url: "https://api.example.com?secret_token=abc",
            method: WebhookActionHttpMethod.POST,
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer xyz"
            }
          }
        ]
      })

      const versionedTemplate = {
        ...templateDomain,
        version: 1,
        occ: 1n
      }

      // When: the template is mapped to API
      const result = mapWorkflowTemplateToApi(versionedTemplate)

      // Expect: the template actions are mapped and sensitive fields are redacted
      expect(result.actions).toBeDefined()
      const action = result.actions?.[0] as unknown as TestWebhookAction | undefined
      expect(action?.type).toBe(WorkflowActionType.WEBHOOK)
      expect(action?.url).toContain("secret_token=***")
      expect(action?.headers?.["Authorization"]).toBe("***")
      expect(action?.headers?.["Content-Type"]).toBe("application/json")
    })
  })
})
