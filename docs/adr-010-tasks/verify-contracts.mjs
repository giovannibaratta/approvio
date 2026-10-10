// Validate the documentation contract without building or changing the application.
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
// This read-only planning utility uses TypeScript's compiler API from the root dev dependency.
// eslint-disable-next-line n/no-unpublished-import
import ts from "typescript"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const doc = fs.readFileSync(path.join(__dirname, "contracts.md"), "utf8")
const inventory = fs.readFileSync(path.join(__dirname, "inventory.md"), "utf8")
const source = [...doc.matchAll(/```typescript\n([\s\S]*?)```/g)].map(m => m[1]).join("\n")
const virtualFile = path.join(root, "a1-contract-check.ts")
const options = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16
}
const host = ts.createCompilerHost(options)
const originalRead = host.readFile.bind(host)
const originalExists = host.fileExists.bind(host)
/** @param {string} file */
host.readFile = file => (file === virtualFile ? source : originalRead(file))
/** @param {string} file */
host.fileExists = file => file === virtualFile || originalExists(file)
const program = ts.createProgram([virtualFile], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: f => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    })
  )
  process.exitCode = 1
}
const inventoryOperations = inventory.split("## OpenAPI operations")[1].split("## Controller")[0]
const routes = [...inventoryOperations.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)`/gm)]
const missing = [...new Set(routes.map(m => m[2]))].filter(route => !doc.includes(route))
if (missing.length) {
  process.stderr.write(`Unmapped API paths: ${missing.join(", ")}\n`)
  process.exitCode = 1
}
for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith(".md"))) {
  const content = fs.readFileSync(path.join(__dirname, file), "utf8")
  for (const match of content.replace(/`[^`]*`/g, "").matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0]
    if (!target || /^(https?:|app:)/.test(target)) continue
    if (!fs.existsSync(path.resolve(__dirname, target))) {
      process.stderr.write(`Missing link in ${file}: ${target}\n`)
      process.exitCode = 1
    }
  }
}
if (!process.exitCode)
  process.stdout.write(
    `Contract TypeScript checks passed; ${routes.length} API operations have path mappings; local Markdown links resolve.\n`
  )
