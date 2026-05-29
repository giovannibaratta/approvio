const { readFileSync, writeFileSync } = require('fs');

function processFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const outLines = [];

  for(let i=0; i<lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // We also need to add the pre-switch check
    if (trimmed.startsWith('switch (error) {') || trimmed.startsWith('switch(error) {') || trimmed.startsWith('switch (error)')) {
        outLines.push(`  if (isInternalInconsistencyError(error)) {`);
        outLines.push(`    return handleInternalInconsistency(errorCode, context)`);
        outLines.push(`  }`);
        outLines.push(line);
    } else {
        outLines.push(line);
    }
  }

  writeFileSync(filePath, outLines.join('\n'));
}

processFile('app/controllers/src/auth/auth.mappers.ts');
processFile('app/controllers/src/auth/cli-auth.mappers.ts');
