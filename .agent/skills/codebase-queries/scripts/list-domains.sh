#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Auto-detect project root if not provided
PROJECT_ROOT="${2:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

DOMAIN_DIR="$PROJECT_ROOT/app/domain/src"
SEARCH_TERMS=$1

if [ ! -d "$DOMAIN_DIR" ]; then
    echo "Error: Domain directory not found at $DOMAIN_DIR"
    exit 1
fi

echo "# Approvio Domain Models & Entities"
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

find "$DOMAIN_DIR" -name "*.ts" ! -name "index.ts" | sort | while read -r domain_file; do
    # Get relative path for display
    rel_path=${domain_file#$PROJECT_ROOT/}
    file_name=$(basename "$domain_file")

    # If search terms are provided, check if filename matches any of them
    if [ -n "$SEARCH_TERMS" ]; then
        if [[ ! "$file_name" =~ $PATTERN ]]; then
            continue
        fi
    fi

    echo "## $rel_path"
    # Extract interfaces, types, classes, and enums
    grep -E "export (interface|type|class|const|enum) [a-zA-Z0-9_]+" "$domain_file" | sed -E 's/export (interface|type|class|const|enum) ([a-zA-Z0-9_]+).*/- \2 (\1)/' | sort -u
    echo ""
done
