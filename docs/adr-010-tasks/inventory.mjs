// Read-only A1 inventory; writes Markdown to stdout for review.
import fs from "node:fs"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
// This read-only planning utility uses TypeScript's compiler API from the root dev dependency.
// eslint-disable-next-line n/no-unpublished-import
import ts from "typescript"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const workspace = path.dirname(root)
/** @param {string} cwd @param {string[]} args */
const run = (cwd, args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim()
/** @param {string} cwd @param {string} dir */
const files = (cwd, dir) =>
  execFileSync("rg", ["--files", dir], {cwd, encoding: "utf8"}).trim().split("\n").filter(Boolean)
/** @param {string} cwd @param {string} file */
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), "utf8")

/** @param {unknown} value @returns {value is Record<string, string>} */
function isStringRecord(value) {
  return typeof value === "object" && value !== null && Object.values(value).every(item => typeof item === "string")
}

/** @param {string} contents */
const parsePackage = contents => {
  /** @type {unknown} */
  const value = JSON.parse(contents)
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  )
    throw new Error("Invalid package metadata")
  const dependencies = "dependencies" in value && isStringRecord(value.dependencies) ? value.dependencies : {}
  return {name: value.name, version: value.version, dependencies}
}
const out = [
  "# A1 source inventory",
  "",
  "Generated from checked-out source by `node docs/adr-010-tasks/inventory.mjs`. This is evidence, not a replacement for the decisions in contracts.md.",
  ""
]
for (const repo of ["approvio", "approvio-api", "approvio-ts-sdk", "approvio-frontend", "approvio-cli"]) {
  const cwd = path.join(workspace, repo)
  const pkg = parsePackage(read(cwd, "package.json"))
  out.push(
    `## ${repo}`,
    "",
    `Branch: \`${run(cwd, ["branch", "--show-current"])}\`. HEAD: \`${run(cwd, ["rev-parse", "HEAD"])}\`.`,
    "",
    "```text",
    run(cwd, ["status", "--short"]) || "(clean)",
    "```",
    "",
    `Package: ${pkg.name}@${pkg.version}; API: ${pkg.dependencies?.["@approvio/api"] || "none"}; SDK: ${pkg.dependencies?.["@approvio/ts-sdk"] || "none"}.`,
    ""
  )
}
out.push(
  "## Backend drift from 37f38f3",
  "",
  "```text",
  run(root, ["diff", "--stat", "37f38f3", "HEAD"]) || "(no file-content changes)",
  "```",
  ""
)
const appFiles = files(root, "app").filter(f => f.endsWith(".ts"))
out.push("## API imports: every declaration", "")
for (const file of appFiles) {
  const source = ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true)
  for (const node of source.statements)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@approvio/api"
    )
      out.push(`- \`${file}\`: \`${node.getText(source).replace(/\s+/g, " ")}\``)
}
out.push(
  "",
  "## Existing service contracts",
  "",
  "Exact declarations below are the baseline for the context-first transformation specified in contracts.md. Preserve overloads/generics and existing request/result types unless the explicit replacement list applies.",
  ""
)
for (const file of appFiles.filter(f => /app\/services\/src\/.*interface.*\.ts$/.test(f))) {
  const source = ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true)
  const declarations = source.statements.filter(n => ts.isInterfaceDeclaration(n))
  if (declarations.length)
    out.push(
      `### ${file}`,
      "",
      "```typescript",
      declarations
        .map(n =>
          n
            .getText(source)
            .replace(/\/\*\*[\s\S]*?\*\//g, "")
            .replace(/\n\s*\n/g, "\n")
        )
        .join("\n"),
      "```",
      ""
    )
}
out.push("## Database models", "")
for (const m of read(root, "prisma/schema.prisma").matchAll(/^model\s(\w+) \{([\s\S]*?)^\}/gm))
  out.push(`- \`${m[1]}\` → \`${m[2].match(/@@map\("([^"]+)"\)/)?.[1] || m[1]}\``)
out.push("", "## OpenAPI operations", "", "| Method | Current path | operationId | File |", "| --- | --- | --- | --- |")
const apiRoot = path.join(workspace, "approvio-api")
for (const m of read(apiRoot, "openapi.yaml").matchAll(/^\s{2}(\/[^\n]+):\n\s{4}\$ref: (.+)$/gm)) {
  const content = read(apiRoot, m[2])
  for (const op of content.matchAll(/^(get|post|put|patch|delete):\n([\s\S]*?)(?=^[a-z]+:|$(?![\s\S]))/gm))
    out.push(
      `| ${op[1].toUpperCase()} | \`${m[1]}\` | ${op[2].match(/operationId: (\S+)/)?.[1] || "(missing)"} | ${m[2]} |`
    )
}
out.push(
  "",
  "## Controller declarations, raw SQL, queues, Redis and encryption",
  "",
  "Includes tests/helpers when they cross database or encryption boundaries. Matches are source locations requiring classification, not proof that every match is a tenant operation.",
  ""
)
const patterns =
  /@(Controller|Get|Post|Put|Patch|Delete|Process|Processor)\(|\$(queryRaw|executeRaw)|\.encrypt\(|\.decrypt\(|keyPrefix|buildAdmissionKey|RedisLock|step_up_token:|dpop_jti:|redis\.defineCommand|redis\.eval|\.add\(|\.addBulk\(/
for (const file of appFiles) {
  const hits = read(root, file)
    .split("\n")
    .flatMap((line, i) => (patterns.test(line) ? [`${i + 1}: ${line.trim()}`] : []))
  if (hits.length) out.push(`### ${file}`, "", "```text", ...hits, "```", "")
}
process.stdout.write(out.join("\n") + "\n")
