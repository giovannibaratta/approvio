import { readFileSync, writeFileSync, existsSync } from 'fs';

const indexPath = 'app/controllers/src/error/index.ts';

if (!existsSync(indexPath)) {
    writeFileSync(indexPath, 'export * from "./internal-inconsistency"\n');
    console.log("Created " + indexPath);
} else {
    let content = readFileSync(indexPath, 'utf8');
    if (!content.includes('internal-inconsistency')) {
        content += '\nexport * from "./internal-inconsistency"\n';
        writeFileSync(indexPath, content);
        console.log("Appended to " + indexPath);
    }
}
