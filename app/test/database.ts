import {PrismaClient} from "@prisma/client"

import {PrismaPg} from "@prisma/adapter-pg"

import Redis from "ioredis"
import {v7 as uuidv7} from "uuid"

const TEST_DATABASE_TEMPLATE = "approvio"

/** Clone the test template database.
 * @returns a connection string for the clone, preserving the configured host and credentials
 */
export async function prepareDatabase(): Promise<string> {
  // Generate a unique database name to isolate test runs
  const databaseName = `integration_test_${uuidv7().replace(/-/g, "")}`
  const adminConnection = process.env.TENANT_DATABASE_URL
  if (!adminConnection) throw new Error("TENANT_DATABASE_URL is required to prepare an isolated database")

  const admin = new PrismaClient({adapter: new PrismaPg({connectionString: adminConnection})})

  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "${TEST_DATABASE_TEMPLATE}"`)
  } finally {
    await admin.$disconnect()
  }

  const testConnection = new URL(adminConnection)
  testConnection.pathname = `/${databaseName}`
  testConnection.searchParams.set("schema", "public")
  return testConnection.toString()
}

/** Connect to the clone*/
export function createFixturePrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({adapter: new PrismaPg({connectionString})})
}

/**
 * Drops an isolated database created by prepareDatabase. Tests use the admin connection because
 * the restricted application roles intentionally cannot create or drop databases.
 */
export async function dropPreparedDatabase(connectionString: string): Promise<void> {
  const targetUrl = new URL(connectionString)
  const databaseName = targetUrl.pathname.slice(1)
  if (!/^integration_test_[a-f0-9]+$/.test(databaseName))
    throw new Error(`Refusing to drop unexpected test database: ${databaseName}`)

  const adminConnection = process.env.TENANT_DATABASE_URL
  if (!adminConnection) throw new Error("TENANT_DATABASE_URL is required to clean a prepared database")
  const adminUrl = new URL(adminConnection)
  adminUrl.pathname = "/postgres"

  const admin = new PrismaClient({adapter: new PrismaPg({connectionString: adminUrl.toString()})})
  try {
    await admin.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}`
    await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`)
  } finally {
    await admin.$disconnect()
  }
}

/**
 * Prepare an isolated Redis key prefix for testing
 * @returns a unique prefix string for this test run
 */
export function prepareRedisPrefix(): string {
  return `test_${uuidv7()}_`
}

/**
 * Clean (delete) all Redis keys with a specific prefix
 * @param prefix The prefix string to match keys for deletion
 */
export async function cleanRedisByPrefix(prefix: string): Promise<void> {
  const redisHost = process.env.REDIS_HOST || "localhost"
  const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10)
  const redisDb = parseInt(process.env.REDIS_DB || "0", 10)

  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    db: redisDb
  })

  // Find all keys matching the prefix pattern
  const keys = await redis.keys(`${prefix}*`)

  if (keys.length > 0) await redis.del(...keys)
  await redis.quit()
}

export async function cleanDatabase(client: PrismaClient): Promise<void> {
  // Clean in dependency order (children before parents)
  await client.dispatchAttempt.deleteMany()
  await client.workflowActionsEmailTask.deleteMany()
  await client.workflowActionsWebhookTask.deleteMany()
  await client.workflowActionsSlackTask.deleteMany()
  await client.durableWork.deleteMany()
  await client.vote.deleteMany()
  await client.workflow.deleteMany()
  await client.workflowTemplate.deleteMany()
  await client.agentChallenge.deleteMany()
  await client.agentRefreshToken.deleteMany()
  await client.agentGroupMembership.deleteMany()
  await client.groupMembership.deleteMany()
  await client.organizationInvitation.deleteMany()
  await client.stepUpReceipt.deleteMany()
  await client.group.deleteMany()
  await client.space.deleteMany()
  await client.agent.deleteMany()
  await client.usageSettlementIntent.deleteMany()
  await client.usageOperation.deleteMany()
  await client.quota.deleteMany()
  await client.usageEvent.deleteMany()
  await client.tenantEventReceipt.deleteMany()
  await client.tenantOutbox.deleteMany()
  await client.auditLog.deleteMany()
  await client.user.deleteMany()
  await client.refreshToken.deleteMany()
  await client.pkceSession.deleteMany()
  await client.browserSession.deleteMany()
  await client.platformAccountIdentity.deleteMany()
  await client.platformSecurityEvent.deleteMany()
  await client.platformAccount.deleteMany()
  await client.providerConnection.deleteMany()
  await client.organization.deleteMany()
}
