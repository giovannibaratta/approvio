// Isolated architecture experiment using its own fixture schema. Requires PostgreSQL on port 5433 and Docker/Podman.
// Generate its fixture client: yarn prisma generate --schema docs/ADR/reviews/experiments/tenancy-compatibility.prisma
// Run: yarn ts-node --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' docs/ADR/reviews/experiments/tenancy-compatibility.ts
// Creates and removes only its randomly named database and roles.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {Client} from "pg"
import {PrismaPg} from "@prisma/adapter-pg"
import {parse} from "dotenv"
import {PrismaClient, Prisma} from "../../../../generated/tenancy-probe/client"

const projectRoot = path.resolve(__dirname, "../../../..")
const env = parse(fs.readFileSync(path.join(projectRoot, ".env.test")))
assert(env.DATABASE_URL, "DATABASE_URL is required in .env.test")
const original = new URL(env.DATABASE_URL)
assert(["localhost", "127.0.0.1"].includes(original.hostname))
assert.equal(original.port, "5433")
const suffix = crypto.randomBytes(6).toString("hex")
const database = `adr010_probe_${suffix}`
const ownerRole = `adr010_owner_${suffix}`
const runtimeRole = `adr010_runtime_${suffix}`
const password = crypto.randomBytes(24).toString("hex")
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "approvio-adr010-"))
fs.chmodSync(workdir, 0o755)
const A = "00000000-0000-7000-8000-000000000001"
const B = "00000000-0000-7000-8000-000000000002"
const groupA = crypto.randomUUID()
const groupB = crypto.randomUUID()
const checks: string[] = []
const admin = new Client({connectionString: original.toString(), connectionTimeoutMillis: 5000})
const clients: Client[] = []
const pools: PrismaClient[] = []
let databaseCreated = false
let ownerCreated = false
let runtimeCreated = false

function connection(user: string, pass: string) {
  const u = new URL(original)
  u.pathname = `/${database}`
  u.username = user
  u.password = pass
  return u.toString()
}
async function connect(user: string, pass: string) {
  const c = new Client({connectionString: connection(user, pass), connectionTimeoutMillis: 5000})
  await c.connect()
  clients.push(c)
  return c
}
function passed(name: string) {
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function expectPgFailure(operation: () => Promise<unknown>, code: string) {
  let error: unknown
  try {
    await operation()
  } catch (e) {
    error = e
  }
  assert(error instanceof Error && "code" in error, "Expected a database rejection")
  assert.equal(error.code, code)
}
async function main() {
  assert.equal(Prisma.prismaVersion.client, "7.9.1")
  await admin.connect()
  await admin.query(`CREATE ROLE ${ownerRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`)
  ownerCreated = true
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`)
  runtimeCreated = true
  await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`)
  databaseCreated = true
  const ddl = `
CREATE TABLE groups (
 id uuid PRIMARY KEY, name text UNIQUE NOT NULL, description text,
 created_at timestamp NOT NULL, updated_at timestamp NOT NULL, occ bigint NOT NULL,
 org_id uuid NOT NULL DEFAULT nullif(current_setting('app.current_org_id', true), '')::uuid,
 UNIQUE (org_id, id)
);
CREATE TABLE agents (
 id uuid PRIMARY KEY, agent_name text UNIQUE NOT NULL, base64_public_key text NOT NULL,
 created_at timestamp NOT NULL, roles json, occ bigint NOT NULL,
 org_id uuid NOT NULL DEFAULT nullif(current_setting('app.current_org_id', true), '')::uuid,
 UNIQUE (org_id, id)
);
CREATE TABLE agent_group_memberships (
 group_id uuid NOT NULL REFERENCES groups(id), agent_id uuid NOT NULL REFERENCES agents(id),
 created_at timestamp NOT NULL, updated_at timestamp NOT NULL,
 org_id uuid NOT NULL DEFAULT nullif(current_setting('app.current_org_id', true), '')::uuid,
 PRIMARY KEY (group_id, agent_id)
);
GRANT USAGE ON SCHEMA public TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON groups, agents, agent_group_memberships TO ${runtimeRole};
${["groups", "agents", "agent_group_memberships"]
  .map(
    table => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
 USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
 WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);`
  )
  .join("\n")}
`
  fs.writeFileSync(path.join(workdir, "changelog.sql"), "--liquibase formatted sql\n--changeset adr010:probe\n" + ddl)
  const lbEnv = {
    ...process.env,
    LIQUIBASE_COMMAND_URL: `jdbc:postgresql://${original.hostname}:${original.port}/${database}`,
    LIQUIBASE_COMMAND_USERNAME: ownerRole,
    LIQUIBASE_COMMAND_PASSWORD: password
  }
  const lb = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${workdir}:/liquibase/changelog:ro`,
      "-e",
      "LIQUIBASE_COMMAND_URL",
      "-e",
      "LIQUIBASE_COMMAND_USERNAME",
      "-e",
      "LIQUIBASE_COMMAND_PASSWORD",
      "liquibase/liquibase:4.31.1",
      "--search-path=/liquibase/changelog",
      "--changelog-file=changelog.sql",
      "update"
    ],
    {env: lbEnv, encoding: "utf8", timeout: 90000}
  )
  fs.writeFileSync(path.join(workdir, "liquibase.log"), (lb.stdout || "") + (lb.stderr || ""))
  assert.equal(lb.status, 0, `Liquibase fixture failed; inspect ${workdir}/liquibase.log`)
  passed("Liquibase 4.31.1 applies PostgreSQL tables and RLS policies")
  const owner = await connect(ownerRole, password)
  const root = await connect(decodeURIComponent(original.username), decodeURIComponent(original.password))
  await root.query(
    "INSERT INTO groups (id,name,created_at,updated_at,occ,org_id) VALUES ($1,$2,now(),now(),1,$3),($4,$5,now(),now(),1,$6)",
    [groupA, "A", A, groupB, "B", B]
  )
  assert.equal((await owner.query("SELECT * FROM groups")).rowCount, 2)
  passed("Table owner bypasses ENABLE RLS")
  for (const table of ["groups", "agents", "agent_group_memberships"])
    await owner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
  assert.equal((await owner.query("SELECT * FROM groups")).rowCount, 0)
  assert.equal((await root.query("SELECT * FROM groups")).rowCount, 2)
  passed("FORCE RLS restricts non-superuser owner; superuser still bypasses")
  const prisma = new PrismaClient({
    adapter: new PrismaPg({connectionString: connection(runtimeRole, password), max: 1})
  })
  pools.push(prisma)
  const events: {model: string | null; operation: string}[] = []
  const scoped = prisma.$extends({
    query: {
      $allOperations: async ({model, operation, args, query}) => {
        events.push({model: model || null, operation})
        const result: unknown = await query(args)
        return result
      }
    }
  })
  type ScopedTransaction = Omit<typeof scoped, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">
  async function withTenant<T>(tenant: string, operation: (tx: ScopedTransaction) => Promise<T>): Promise<T> {
    return scoped.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.current_org_id', ${tenant}, true)`
      return operation(tx)
    })
  }
  assert.deepEqual(await scoped.group.findMany(), [])
  passed("Prisma 7.9.1 with restricted runtime role fails closed without context")
  assert.deepEqual(
    (await withTenant(A, tx => tx.group.findMany())).map(x => x.name),
    ["A"]
  )
  assert.deepEqual(await scoped.group.findMany(), [])
  assert.deepEqual(
    (await withTenant(B, tx => tx.group.findMany())).map(x => x.name),
    ["B"]
  )
  passed("SET LOCAL via parameterized set_config stays on interactive transaction and resets after commit/pool reuse")
  const sentinel = new Error("intentional rollback")
  await assert.rejects(
    withTenant(A, async tx => {
      await tx.group.findMany()
      throw sentinel
    }),
    e => e === sentinel
  )
  assert.deepEqual(await scoped.group.findMany(), [])
  passed("Tenant context resets after rollback on reused connection")
  const agentId = crypto.randomUUID()
  events.length = 0
  const agent = await withTenant(A, tx =>
    tx.agent.create({
      data: {
        id: agentId,
        agentName: "nested-agent",
        base64PublicKey: "fixture",
        createdAt: new Date(),
        occ: 1n,
        agentGroupMemberships: {create: {groupId: groupA, createdAt: new Date(), updatedAt: new Date()}}
      },
      include: {agentGroupMemberships: true}
    })
  )
  assert.equal(agent.agentGroupMemberships.length, 1)
  assert(events.some(x => x.model === "Agent" && x.operation === "create"))
  assert(!events.some(x => x.model === "AgentGroupMembership"))
  passed("Nested create/include works, but query extension receives no nested-model callbacks in 7.9.1")
  events.length = 0
  await withTenant(A, tx => tx.agent.findMany({include: {agentGroupMemberships: {include: {groups: true}}}}))
  assert.deepEqual(
    events.filter(x => x.model !== null).map(x => x.model),
    ["Agent"]
  )
  passed("Nested relation read also lacks nested-model callbacks")
  assert(events.some(x => x.model === null && x.operation === "$queryRaw"))
  passed("Raw-query extension callback has no model for automatic where injection")
  await withTenant(A, tx =>
    tx.agentGroupMembership.create({
      data: {
        agentId,
        groupId: groupB,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
  )
  const badLink = await root.query<{org_id: string}>(
    "SELECT org_id FROM agent_group_memberships WHERE group_id=$1 AND agent_id=$2",
    [groupB, agentId]
  )
  assert(badLink.rows[0], "Expected the inserted membership")
  assert.equal(badLink.rows[0].org_id, A)
  passed("Simple FK plus RLS accepts cross-org relation when scalar foreign ID is supplied")
  await root.query("DELETE FROM agent_group_memberships WHERE group_id=$1 AND agent_id=$2", [groupB, agentId])
  await owner.query(
    "ALTER TABLE agent_group_memberships ADD CONSTRAINT same_org_group FOREIGN KEY (org_id,group_id) REFERENCES groups(org_id,id)"
  )
  await owner.query(
    "ALTER TABLE agent_group_memberships ADD CONSTRAINT same_org_agent FOREIGN KEY (org_id,agent_id) REFERENCES agents(org_id,id)"
  )
  await assert.rejects(
    withTenant(A, tx =>
      tx.agentGroupMembership.create({
        data: {
          agentId,
          groupId: groupB,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    ),
    (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003"
  )
  passed("Composite tenant FK rejects the same cross-org relation through Prisma")
  const runtime = await connect(runtimeRole, password)
  await runtime.query("BEGIN")
  await runtime.query("SELECT set_config('app.current_org_id', $1, true)", [A])
  await expectPgFailure(
    () =>
      runtime.query("INSERT INTO groups (id,name,created_at,updated_at,occ,org_id) VALUES ($1,$2,now(),now(),1,$3)", [
        crypto.randomUUID(),
        "bad",
        B
      ]),
    "42501"
  )
  await runtime.query("ROLLBACK")
  passed("RLS WITH CHECK rejects explicitly wrong tenant on insert")
  const concurrent = new PrismaClient({
    adapter: new PrismaPg({connectionString: connection(runtimeRole, password), max: 2})
  })
  pools.push(concurrent)
  await Promise.all(
    [A, B].map(tenant =>
      concurrent.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('app.current_org_id', ${tenant}, true)`
        await tx.$queryRaw`SELECT 1 FROM pg_sleep(0.05)`
        assert.deepEqual(
          (await tx.group.findMany()).map(x => x.id),
          [tenant === A ? groupA : groupB]
        )
      })
    )
  )
  passed("Concurrent A/B Prisma transactions preserve distinct tenant settings")
  fs.writeFileSync(
    path.join(workdir, "schema.prisma"),
    'generator client {\n provider = "prisma-client"\n output = "./generated"\n}\ndatasource db {\n provider = "postgresql"\n}\n'
  )
  fs.writeFileSync(
    path.join(workdir, "prisma.config.ts"),
    "export default { datasource: { url: process.env.DATABASE_URL } }\n"
  )
  const introspection = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "node_modules/prisma/build/index.js"),
      "db",
      "pull",
      "--schema",
      path.join(workdir, "schema.prisma"),
      "--config",
      path.join(workdir, "prisma.config.ts")
    ],
    {
      cwd: projectRoot,
      env: {...process.env, DATABASE_URL: connection(ownerRole, password)},
      encoding: "utf8",
      timeout: 30000
    }
  )
  fs.writeFileSync(path.join(workdir, "introspection.log"), (introspection.stdout || "") + (introspection.stderr || ""))
  assert.equal(introspection.status, 0, `Introspection failed; inspect ${workdir}/introspection.log`)
  assert(/row.level security/i.test(introspection.stdout + introspection.stderr))
  const flags = await owner.query<{relrowsecurity: boolean; relforcerowsecurity: boolean}>(
    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='groups'::regclass"
  )
  assert(flags.rows[0], "Expected group table RLS metadata")
  assert.equal(flags.rows[0].relrowsecurity, true)
  assert.equal(flags.rows[0].relforcerowsecurity, true)
  passed("Prisma 7.9.1 db pull succeeds, warns about RLS, and leaves policies enabled")
  const result = {prisma: Prisma.prismaVersion.client, postgres: "17.4", liquibase: "4.31.1", checks, workdir}
  fs.writeFileSync("/tmp/approvio-adr010-probe-results.json", JSON.stringify(result, null, 2))
  console.log(`Completed ${checks.length} checks. Artifacts: ${workdir}`)
}
main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    for (const p of pools) await p.$disconnect()
    for (const c of clients) await c.end()
    if (databaseCreated) await admin.query(`DROP DATABASE ${database}`)
    if (runtimeCreated) await admin.query(`DROP ROLE ${runtimeRole}`)
    if (ownerCreated) await admin.query(`DROP ROLE ${ownerRole}`)
    await admin.end()
    console.log("Isolated database and roles cleaned up.")
  })
