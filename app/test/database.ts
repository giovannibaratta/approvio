import {PrismaClient} from "@prisma/client"

import {PrismaPg} from "@prisma/adapter-pg"

import Redis from "ioredis"
import {v7 as uuidv7} from "uuid"

/** Create a duplicated database using the reference database as template
 * @returns the connection string to the new database
 */
export async function prepareDatabase(): Promise<string> {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL
  })

  const prismaClient = new PrismaClient({adapter})

  // Generate a unique database name to isolate test runs
  const databaseName = `integration_test_${uuidv7().replace(/-/g, "")}`

  await prismaClient.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE approvio;`)
  await prismaClient.$disconnect()

  return `postgresql://developer:Safe1!@localhost:5433/${databaseName}?schema=public`
}

// TODO: Why do we need this function ?
/** Drop a database previously created by prepareDatabase using the test admin connection. */
export async function dropPreparedDatabase(connectionString: string): Promise<void> {
  const targetUrl = new URL(connectionString)
  const databaseName = targetUrl.pathname.slice(1)
  if (!/^integration_test_[a-f0-9]+$/.test(databaseName))
    throw new Error(`Refusing to drop unexpected test database: ${databaseName}`)

  const adminConnection = process.env.DATABASE_URL
  if (!adminConnection) throw new Error("DATABASE_URL is required to clean a prepared database")
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
  // Use raw query for AuditLog to bypass the immutability protection in DatabaseClient
  await client.dispatchAttempt.deleteMany()
  await client.tenantEventReceipt.deleteMany()
  await client.workflowActionsEmailTask.deleteMany()
  await client.workflowActionsWebhookTask.deleteMany()
  await client.workflowActionsSlackTask.deleteMany()
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
  await client.tenantOutbox.deleteMany()
  // TOOD: Why using rawUnsafe query ?
  await client.$executeRawUnsafe("DELETE FROM audit_logs;")
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
