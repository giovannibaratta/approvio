import {Project, Type} from "ts-morph"
import * as path from "path"
import * as fs from "fs"

// Get command-line arguments
const args = process.argv.slice(2)
if (args.length !== 2) {
  console.error("Usage: yarn ai:get-union-literals <filepath> <typename>")
  console.error("Example: yarn ai:get-union-literals app/domain/src/types.ts MyUnionType")
  process.exit(1)
}

const [filePathArg, typeName] = args as [string, string]

// Resolve the absolute file path
const filePath = path.resolve(process.cwd(), filePathArg)

// Initialize a ts-morph project
// We load the main tsconfig.json so it correctly resolves aliases and imports
const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
  skipAddingFilesFromTsConfig: true // we only care about the specific file and its dependencies
})

// Ensure the file exists before adding it to avoid ts-morph throwing an unhandled exception
if (!fs.existsSync(filePath)) {
  console.error(`Error: File does not exist at ${filePath}`)
  process.exit(1)
}

// Add the target file to the project
const sourceFile = project.addSourceFileAtPath(filePath)

// Find the type alias, interface, or enum declaration
const typeAlias = sourceFile.getTypeAlias(typeName)
const interfaceDecl = sourceFile.getInterface(typeName)
const enumDecl = sourceFile.getEnum(typeName)

// Get the actual ts-morph Type object
const typeToResolve = typeAlias
  ? typeAlias.getType()
  : interfaceDecl
    ? interfaceDecl.getType()
    : enumDecl
      ? enumDecl.getType()
      : null

if (!typeToResolve) {
  console.error(`Error: Could not find a type alias, interface or enum named '${typeName}' in ${filePath}`)
  process.exit(1)
}

// Helper function to extract literals from a type
const MAX_NESTING_LEVEL = 100
function extractLiterals(type: Type, depth = 0): Set<string | number | boolean> {
  if (depth > MAX_NESTING_LEVEL) {
    throw new Error(`Exceeded maximum nesting level of ${MAX_NESTING_LEVEL}`)
  }
  const literals = new Set<string | number | boolean>()

  // If the type is a union, traverse its constituent types
  if (type.isUnion()) {
    const unionTypes = type.getUnionTypes()

    for (const unionType of unionTypes) {
      const nestedLiterals = extractLiterals(unionType, depth + 1)
      nestedLiterals.forEach(val => literals.add(val))
    }
  } else if (type.isStringLiteral()) {
    literals.add(type.getLiteralValue() as string)
  } else if (type.isNumberLiteral()) {
    literals.add(type.getLiteralValue() as number)
  } else if (type.isBooleanLiteral()) {
    // getLiteralValue() returns a boolean for boolean literals in ts-morph
    literals.add(type.getText() === "true")
  }

  return literals
}

const literalsSet = extractLiterals(typeToResolve)
const literalsArray = Array.from(literalsSet)

// Output the result as JSON to stdout
console.log(JSON.stringify(literalsArray, null, 2))
