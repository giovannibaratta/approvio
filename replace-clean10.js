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

        i = j;
        continue;
      }
    }

    // Check for switch (error)
    if (trimmed === 'switch (error) {') {
        outLines.push(`  if (isInternalInconsistencyError(error)) {`);
        outLines.push(`    return handleInternalInconsistency(errorCode, context)`);
        outLines.push(`  }`);
        outLines.push(line);
        i++;
        continue;
    }

    // A bug in previous scripts deleted the ending } of switches.
    // The previous scripts just matched and ignored blocks, but we shouldn't have lost the switch closing bracket unless it was somehow eaten.
    // Wait, the block eating loop `while(!lines[j].includes(')'))` might be eating everything if there is no `)`! But there is `)` for InternalServerErrorException!
    // Oh wait, `return new InternalServerErrorException(` ends with `)`. If we skip it, we shouldn't skip `}`.
    // Let's verify by just logging what's skipped.

    outLines.push(line);
    i++;
  }

  writeFileSync(filePath, outLines.join('\n'));
}

processFile('app/controllers/src/auth/auth.mappers.ts');
processFile('app/controllers/src/auth/cli-auth.mappers.ts');
