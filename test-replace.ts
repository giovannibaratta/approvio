import { readFileSync, writeFileSync } from 'fs';

function apply(filePath: string) {
    let content = readFileSync(filePath, 'utf8');

    // Add import
    const importMatch = content.match(/import {[^}]*} from "@nestjs\/common"/);
    if (importMatch && !content.includes('internal-inconsistency')) {
        content = content.replace(
            importMatch[0],
            `${importMatch[0]}\nimport { isInternalInconsistencyError, handleInternalInconsistency } from "../error/internal-inconsistency"`
        );
    }

    // Process block
    // We are looking for sequences starting with case "..." and ending with the InternalServerErrorException block.
    // The exact regex for the block body to remove is:
    const blockBodyRegex = /([ \t]*Logger\.error\(`Internal data inconsistency: \${errorCode}`\)\n[ \t]*return new InternalServerErrorException\(\n[ \t]*generateErrorPayload\("UNKNOWN_ERROR", `\${context}: internal data inconsistency`\)\n[ \t]*\)\n?)/g;

    // Wait, replacing it with nothing would leave dangling case statements.
    // Actually, we want to remove the case statements AND the block body.
    const fullBlockRegex = /(?:[ \t]*case "[^"]+":\n)+(?:[ \t]*Logger\.error\(`Internal data inconsistency: \${errorCode}`\)\n)?[ \t]*return new InternalServerErrorException\(\n[ \t]*generateErrorPayload\("UNKNOWN_ERROR", `\${context}: internal data inconsistency`\)\n[ \t]*\)\n?/g;

    content = content.replace(fullBlockRegex, '');

    // Inject the if statement BEFORE the switch
    content = content.replace(/([ \t]*)switch \(error\) \{/g, '$1if (isInternalInconsistencyError(error)) {\n$1  return handleInternalInconsistency(errorCode, context)\n$1}\n\n$1switch (error) {');

    writeFileSync(filePath, content);
}

apply('app/controllers/src/auth/auth.mappers.ts');
apply('app/controllers/src/auth/cli-auth.mappers.ts');
