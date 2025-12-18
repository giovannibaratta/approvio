import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"
import {PrismaPg} from "@prisma/adapter-pg"
// eslint-disable-next-line node/no-unpublished-import
import Redis from "ioredis"

/** Create a duplicated database using the reference database as template
 * @returns the connection string to the new database
 */
export async function prepareDatabase(): Promise<string> {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL
  })

  const prismaClient = new PrismaClient({adapter})

  // Generate a unique database name to isolate test runs
  const databaseName = `integration_test_${randomUUID().replace(/-/g, "")}`

  await prismaClient.$executeRawUnsafe(`CREATE DATABASE ${databaseName} TEMPLATE approvio;`)
  await prismaClient.$disconnect()

  return `postgresql://developer:Safe1!@localhost:5433/${databaseName}?schema=public`
}

/**
 * Prepare an isolated Redis key prefix for testing
 * @returns a unique prefix string for this test run
 */
export function prepareRedisPrefix(): string {
  return `test_${randomUUID()}_`
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
  await client.agentChallenge.deleteMany()
  await client.organizationAdmin.deleteMany()
  await client.pkceSession.deleteMany()
  await client.workflowActionsEmailTask.deleteMany()
  await client.workflowActionsWebhookTask.deleteMany()
  await client.vote.deleteMany()
  await client.workflow.deleteMany()
  await client.workflowTemplate.deleteMany()
  await client.agentGroupMembership.deleteMany()
  await client.groupMembership.deleteMany()
  await client.group.deleteMany()
  await client.space.deleteMany()
  await client.user.deleteMany()
  await client.agent.deleteMany()
}
