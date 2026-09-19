#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Auto-detect project root if not provided
PROJECT_ROOT="${2:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"

CONTROLLERS_DIR="$PROJECT_ROOT/app/controllers/src"
SEARCH_TERMS=$1

if [ ! -d "$CONTROLLERS_DIR" ]; then
    echo "Error: Controllers directory not found at $CONTROLLERS_DIR"
    exit 1
fi

echo "# Approvio Controllers"
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

find "$CONTROLLERS_DIR" -name "*.controller.ts" | sort | while read -r controller_file; do
    # Get relative path for display
    rel_path=${controller_file#$PROJECT_ROOT/}
    file_name=$(basename "$controller_file")

    # If search terms are provided, check if filename matches any of them
    if [ -n "$SEARCH_TERMS" ]; then
        if [[ ! "$file_name" =~ $PATTERN ]]; then
            continue
        fi
    fi

    # Extract class name
    class_name=$(grep -E "export class [a-zA-Z0-9_]+" "$controller_file" | sed -E 's/.*class ([a-zA-Z0-9_]+).*/\1/')

    if [ -n "$class_name" ]; then
        echo "## $class_name ($rel_path)"
        # Extract methods
        grep -E "^\s+(async\s+)?[a-zA-Z0-9_]+\(" "$controller_file" | grep -v "constructor" | sed -E 's/^\s+(async\s+)?([a-zA-Z0-9_]+)\(.*/- \2/' | sort -u
        echo ""
    fi
done
