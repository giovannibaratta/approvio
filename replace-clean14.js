const { readFileSync, writeFileSync } = require('fs');

function processFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const outLines = [];

  let importAdded = false;

  let lastImportIdx = -1;
  for(let j=0; j<lines.length; j++) {
      if (lines[j].startsWith('import ')) {
          lastImportIdx = j;
      }
  }

  let i = 0;
  while (i < lines.length) {
    if (i === lastImportIdx + 1 && !importAdded) {
      outLines.push('import { isInternalInconsistencyError, handleInternalInconsistency } from "../error"');
      importAdded = true;
    }

    const line = lines[i];
    if (line === undefined) {
        i++;
        continue;
    }

    const trimmed = line.trim();

    // Look for the start of an internal consistency block
    if (trimmed.startsWith('case "')) {
      let isInternal = false;
      let j = i;
      while (j < lines.length && lines[j] !== undefined && (lines[j].trim().startsWith('case "') || lines[j].trim() === '')) {
        j++;
      }

      if (j < lines.length && lines[j] !== undefined && lines[j].includes('Logger.error(`Internal data inconsistency')) {
        isInternal = true;
        // Skip over the logger line and the return InternalServerErrorException
        while (j < lines.length && lines[j] !== undefined && !lines[j].includes(')')) { // finding the end of the return
           j++;
        }
        j++; // skip the closing paren line

        // Ensure we don't accidentally leave dangling parts of the block like
        //       return new InternalServerErrorException(
        //         generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
        //       )
        // Wait! Let's examine auth.mappers.ts:243.
        /*
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
    case "refresh_token_missing_occ":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
        */
        // My while loops logic was: `j` advances past `case "..."`.
        // Then `lines[j].includes('Logger.error')`. Wait. The Logger.error is exactly `lines[j]`.
        // If it isn't `Logger.error`, the `if` fails, and we push `case "..."`.
        // The problem is that in the `auth.mappers.ts`, there are `case`s that don't match,
        // and we push them! But wait, `isInternal` is true, so we do skip `Logger...`.
        // Wait, why did `return new InternalServerErrorException(` show up in the output?
        // Ah! If `lines[j]` includes `Logger.error`, `j` points to the `Logger.error` line!
        // We set `isInternal = true`, and we start skipping until `)`
        // WAIT. We skip from `j`. The original `i` was at the FIRST `case "..."`.
        // By setting `i = j`, we effectively SKIP the cases and the block!
        // Then we `continue`.
        // But the output showed:
        /*
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
        */
        // This implies the block starting at `case "refresh_token_expire_before_create":` DID NOT trigger `lines[j].includes('Logger.error')`!
        // Why? Let's check `auth.mappers.ts` at line 457.
        // It has NO `Logger.error`?!

        i = j;
        continue;
      }
    }

    if (trimmed === 'switch (error) {') {
        outLines.push(`  if (isInternalInconsistencyError(error)) {`);
        outLines.push(`    return handleInternalInconsistency(errorCode, context)`);
        outLines.push(`  }`);
        outLines.push(line);
        i++;
        continue;
    }

    outLines.push(line);
    i++;
  }

  writeFileSync(filePath, outLines.join('\n'));
}

processFile('app/controllers/src/auth/auth.mappers.ts');
processFile('app/controllers/src/auth/cli-auth.mappers.ts');
