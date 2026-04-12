#! /usr/bin/env bash

. "$(dirname "$0")/shared.sh"

# Controls the verbosity of the output; when set to 1, standard output of wrapped commands is suppressed
SILENT=0
ARGS=()

for arg in "$@"; do
  if [ "$arg" == "--silent" ]; then
    SILENT=1
  else
    ARGS+=("$arg")
  fi
done


if [ ${#ARGS[@]} -eq 0 ]; then
    echo "No arguments provided for prisma."
    exit 1
fi

ACTION=${ARGS[0]}

case $ACTION in
    generate)
        run_cmd "Generating Prisma schema" yarn prisma generate
        ;;
    pull)
        run_cmd "Pulling Prisma schema" yarn dotenv -e .env.local -- yarn prisma db pull
        run_cmd "Formatting Prisma schema" yarn prisma-case-format --file prisma/schema.prisma -p --table-case pascal,singular --field-case camel
        ;;
    *)
        echo "Action $ACTION not supported by this wrapper yet."
        run_cmd "prisma ${ARGS[@]}" yarn prisma "${ARGS[@]}"
        ;;
esac