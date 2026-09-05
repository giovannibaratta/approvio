# Requirements: Native Evaluators

## 1. System Overview & Boundaries

Approvio supports two evaluation models for automated workflow reviews: **Bring Your Own Logic (BYOL)** and **Built-in (Native) Evaluators**.

### Boundary Matrix

| Capability / Responsibility | Built-in (Native) Evaluators | BYOL (External Agents & Systems) |
| :--- | :--- | :--- |
| **Execution Environment** | Approvio worker runtime | Customer-managed infrastructure / private network |
| **Input Surface** | In-payload workflow artifact + configured static prompt/rubric | Any data source, VPC resource, or external API |
| **Tool Calling / Egress** | None (sandboxed LLM inference only) | Arbitrary tools, shell commands, database queries, HTTP endpoints |
| **Credential Management** | Platform-managed LLM connection or Space-level LLM API key | Customer-managed secrets, IAM roles, private keys |
| **Decision Delivery** | Approvio internal worker casts vote directly | External system submits vote via Approvio REST API |
| **Operational Overhead** | Zero infrastructure setup (configured via API/UI) | Requires deploying, monitoring, and maintaining an external service |

---

## 2. User Journeys

### Journey 1: Sourcing & Configuring an Evaluator
1. Space Admin or Template Author selects an Evaluator:
   - **Option A**: Picks a pre-built evaluator from the **Evaluator Library** (organization catalog).
   - **Option B**: Authors a custom evaluator with a persona, rubric, and model selection.
2. The author assigns the Evaluator to an Approver Group in a Workflow Template.
3. The author publishes the template for execution.

### Journey 2: Workflow Execution & Consensus
1. An upstream system, agent, or user triggers a workflow with a structured payload (the artifact).
2. Approvio initiates the workflow and calculates required approvals from the template's boolean approval rule.
3. The worker runs the Built-in Evaluator(s) against the payload.
4. The Evaluator outputs a structured vote (`APPROVE` or `VETO`), a confidence score, and a Markdown reasoning report.
5. If the rule requires both automated and human approvals, human approvers review the evaluator's report alongside the artifact before voting.

---

## 3. Core Governance Archetypes

Built-in Evaluators enforce deterministic policy gates across three primary patterns:

### 1. Risk & Policy Compliance Gates
- **Focus**: Validate structured request payloads against organizational matrices, legal thresholds, and regulatory constraints.
- **Workflow**: Pre-screen high-volume requests (e.g., exception approvals, procurement sign-offs, discount authorizations, vendor agreements).

### 2. Autonomous Agent Action Verification
- **Focus**: Run an independent safety check between an autonomous AI agent's planned action and its execution.
- **Workflow**: An autonomous agent generates a proposed action payload (e.g., bulk data mutation, configuration change, financial transaction); the Evaluator checks the payload against safety guardrails before granting approval.

### 3. Multi-Stakeholder Pre-flight & Triage
- **Focus**: Vet complex multi-field submissions before escalating to senior decision-makers.
- **Workflow**: Rejects non-compliant submissions immediately to reduce noise for human approvers, and attaches summary reports to valid requests.

---

## 4. Evaluator Registry & Sharing (Catalog Model)

Evaluators package as portable, reusable configurations:

- **Package Structure**:
  - Metadata (name, author, version, description, category tags).
  - Target input payload schema (JSON Schema).
  - System prompt & evaluation rubric.
  - Recommended model parameters and providers.
  - Sample test payloads with expected outcomes.
- **Scopes**:
  - **Space / Organization Scope**: Private to a specific tenant for proprietary internal rules.
  - **Public Registry**: Community marketplace to discover, fork, and publish domain-specific evaluators.

---

## 5. Phased Implementation Roadmap

### Stage 1: Core Sandboxed Evaluator (Initial Implementation)
- **Scope**:
  - Built-in Evaluator entity scoped to Spaces and assigned to Approver Groups.
  - Configuration interface for system prompts, rubrics, and model provider selection.
  - Worker execution engine with structured JSON output parsing (`decision`, `confidence`, `reasoningMarkdown`).
  - Space-level Bring Your Own Key (BYOK) credential management (OpenAI, Anthropic, Google).
- **Constraints**:
  - Sandboxed execution (zero external network egress).
  - In-payload evaluation only.

### Stage 2: Reusable Knowledge & Evaluator Catalog
- **Scope**:
  - **Evaluator Library**: Organization-level catalog to publish, version, and import reusable evaluators across Spaces.
  - **Static Context Attachments**: Support referencing static policy documents (Markdown, PDF) attached to Spaces or Evaluators.
  - **Checklist-based Scoring**: Structured evaluations with itemized criteria breakdowns.
  - **Confidence-based Escalation**: Automatic abstention and human escalation when model confidence is low.

### Stage 3: Ecosystem & Advanced Verification
- **Scope**:
  - **Public Evaluator Marketplace**: Community registry for sharing, rating, and installing verified domain evaluators.
  - **Multi-Persona Consensus**: Orchestrating distinct evaluators with contrasting personas to evaluate complex proposals.
  - **Evaluator Regression & Drift Testing**: Test harnesses to benchmark evaluator prompts against historical workflow datasets before publishing updates.
