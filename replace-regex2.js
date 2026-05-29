const { readFileSync, writeFileSync } = require('fs');

function extractAndReplace(filePath) {
    let content = readFileSync(filePath, 'utf8');

    // Add import
    const importRegex = /^(import .* from ".*")$/gm;
    let match;
    let lastIndex = -1;
    while ((match = importRegex.exec(content)) !== null) {
        lastIndex = importRegex.lastIndex;
    }

    if (lastIndex !== -1 && !content.includes('internal-inconsistency')) {
        content = content.slice(0, lastIndex) + '\nimport { isInternalInconsistencyError, handleInternalInconsistency } from "../error/internal-inconsistency"\n' + content.slice(lastIndex);
    }

    // Replace switch (error) with the if check
    content = content.replace(/switch \(error\) \{/g, 'if (isInternalInconsistencyError(error)) {\n    return handleInternalInconsistency(errorCode, context)\n  }\n\n  switch (error) {');

    // Make the regex non-greedy and match any case sequence up to the payload
    // A block starts with case "..." and ends with generateErrorPayload("UNKNOWN_ERROR", ...
    // followed by )
    const blockRegex = /(?:[ \t]*case "[^"]+":\r?\n)+(?:[ \t]*Logger\.error\(`Internal data inconsistency: \${errorCode}`\)\r?\n)?[ \t]*return new InternalServerErrorException\(\r?\n[ \t]*generateErrorPayload\("UNKNOWN_ERROR", `\${context}: internal data inconsistency`\)\r?\n[ \t]*\)\r?\n/gm;

    content = content.replace(blockRegex, '');

    writeFileSync(filePath, content);
}

extractAndReplace('app/controllers/src/auth/auth.mappers.ts');
extractAndReplace('app/controllers/src/auth/cli-auth.mappers.ts');
