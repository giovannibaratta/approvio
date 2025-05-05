import {PrismaClient} from "@prisma/client"
import {randomUUID} from "crypto"

/** Create a duplicated database using the reference database as template
 * @returns the connection string to the new database
 */
export async function prepareDatabase(): Promise<string> {
  const referenceDb = process.env.DATABASE_URL
  // Create a client connected to the reference database
  const prismaClient = new PrismaClient({
    datasources: {
      db: {
        url: referenceDb
      }
    }
  })

  // Generate a unique database name to isolate test runs
  const databaseName = `integration_test_${randomUUID().replace(/-/g, "")}`

  await prismaClient.$executeRawUnsafe(`CREATE DATABASE ${databaseName} TEMPLATE approvio;`)
  await prismaClient.$disconnect()

  return `postgresql://developer:Safe1!@localhost:5433/${databaseName}?schema=public`
}

export async function cleanDatabase(client: PrismaClient): Promise<void> {
  await client.workflow.deleteMany()
  await client.groupMembership.deleteMany()
  await client.group.deleteMany()
  await client.user.deleteMany()
}
