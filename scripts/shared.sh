# Executes a command normally, or silently if SILENT=1.
# In silent mode, stdout and stderr are redirected to a temporary file.
# If the command fails, the contents of the temporary file are printed.
# Args:
#   $1: Message to print before executing the command
#   $2...: Command to execute
function run_cmd() {
  local msg="$1"
  shift

  echo "$msg ..."

  if [ "$SILENT" -eq 1 ]; then
    local tmpfile=$(mktemp)
    if ! "$@" > "$tmpfile" 2>&1; then
      echo "Error executing command: $msg. The command output is:"
      cat "$tmpfile"
      rm "$tmpfile"
      exit 1
    fi
    rm "$tmpfile"
  else
    "$@"
  fi
}