import { readFileSync, writeFileSync } from 'fs';

function applySafe(file: string) {
    let content = readFileSync(file, 'utf8');

    // Add imports
    content = content.replace(
        /(import {[^}]*} from "@nestjs\/common")/,
        '$1\nimport { isInternalInconsistencyError, handleInternalInconsistency } from "../error"'
    );

    const lines = content.split('\n');
    const result: string[] = [];

    let i = 0;
    while (i < lines.length) {
        let line = lines[i];

        if (line.includes('switch (error) {')) {
            result.push('  if (isInternalInconsistencyError(error)) {');
            result.push('    return handleInternalInconsistency(errorCode, context)');
            result.push('  }');
            result.push(line);
            i++;
            continue;
        }

        if (line.trim().startsWith('case "')) {
            let nextLoggerIdx = -1;
            let currentIsInternal = false;
            for(let j=i; j<Math.min(lines.length, i + 150); j++) {
                 if (lines[j].trim() === '' || lines[j].trim().startsWith('//')) {
                     continue;
                 }
                 if (lines[j].includes('Logger.error(`Internal data inconsistency')) {
                     currentIsInternal = true;
                     nextLoggerIdx = j;
                     break;
                 }
                 if (!lines[j].trim().startsWith('case "')) {
                     break;
                 }
            }

            if (currentIsInternal) {
                // skip all these cases
                // skip Logger.error
                // skip return ...
                // skip generateErrorPayload ...
                // skip )
                let j = nextLoggerIdx;
                while(j < lines.length && !lines[j].includes(')')) {
                    j++;
                }
                j++; // skip the paren
                i = j;
                continue;
            }
        }

        result.push(line);
        i++;
    }

    writeFileSync(file, result.join('\n'));
}

applySafe('app/controllers/src/auth/auth.mappers.ts');
applySafe('app/controllers/src/auth/cli-auth.mappers.ts');
