#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Auto-detect project root if not provided
PROJECT_ROOT="${2:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

UTILS_DIR="$PROJECT_ROOT/app/utils/src"
SEARCH_TERMS=$1

if [ ! -d "$UTILS_DIR" ]; then
    echo "Error: Utils directory not found at $UTILS_DIR"
    exit 1
fi

echo "# Approvio Utils"
[ -n "$SEARCH_TERMS" ] && echo "(Filtered by: $SEARCH_TERMS)"
echo ""

# Convert comma-separated string to regex pattern
IFS=',' read -ra ADDR <<< "$SEARCH_TERMS"
PATTERN=""
for i in "${ADDR[@]}"; do
    if [ -z "$PATTERN" ]; then
        PATTERN="$i"
    else
        PATTERN="$PATTERN|$i"
    fi
done

find "$UTILS_DIR" -name "*.ts" ! -name "index.ts" | sort | while read -r utils_file; do
    # Get relative path for display
    rel_path=${utils_file#$PROJECT_ROOT/}
    file_name=$(basename "$utils_file")

    # If search terms are provided, check if filename matches any of them
    if [ -n "$SEARCH_TERMS" ]; then
        if [[ ! "$file_name" =~ $PATTERN ]]; then
            continue
        fi
    fi

    echo "## $rel_path"
    # Extract exported functions, constants, and types
    grep -E "export (const|function|type|interface|enum) [a-zA-Z0-9_]+" "$utils_file" | sed -E 's/export (const|function|type|interface|enum) ([a-zA-Z0-9_]+).*/- \2 (\1)/' | sort -u
    echo ""
done
