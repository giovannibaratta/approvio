#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Auto-detect project root if not provided
PROJECT_ROOT="${2:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

REPOS_DIR="$PROJECT_ROOT/app/external/src/database"
SEARCH_TERMS=$1

if [ ! -d "$REPOS_DIR" ]; then
    echo "Error: Repositories directory not found at $REPOS_DIR"
    exit 1
fi

echo "# Approvio Repositories"
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

find "$REPOS_DIR" -name "*.repository.ts" | sort | while read -r repo_file; do
    # Get relative path for display
    rel_path=${repo_file#$PROJECT_ROOT/}
    file_name=$(basename "$repo_file")

    # If search terms are provided, check if filename matches any of them
    if [ -n "$SEARCH_TERMS" ]; then
        if [[ ! "$file_name" =~ $PATTERN ]]; then
            continue
        fi
    fi

    # Extract class name
    class_name=$(grep -E "export class [a-zA-Z0-9_]+" "$repo_file" | sed -E 's/.*class ([a-zA-Z0-9_]+).*/\1/')

    if [ -n "$class_name" ]; then
        echo "## $class_name ($rel_path)"
        # Extract methods (async or public methods)
        grep -E "^\s+(async\s+)?[a-zA-Z0-9_]+\(" "$repo_file" | grep -v "constructor" | sed -E 's/^\s+(async\s+)?([a-zA-Z0-9_]+)\(.*/- \2/' | sort -u
        echo ""
    fi
done
