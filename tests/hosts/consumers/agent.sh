#!/bin/sh
set -eu
test -z "${CV_API_KEY-}${AWS_ACCESS_KEY_ID-}${AWS_SECRET_ACCESS_KEY-}"
workspace=$1
case "$2" in
  first)
    mkdir "$workspace/empty"
    printf '\000\377agent\012' > "$workspace/payload.bin"
    printf 'delete after checkpoint' > "$workspace/delete-me.txt"
    printf 'unicode file\012' > "$workspace/café.txt"
    ;;
  next)
    rm "$workspace/delete-me.txt"
    printf '\377\000next\200\012' > "$workspace/payload.bin"
    ;;
  tamper) printf 'changed after controller death' > "$workspace/payload.bin" ;;
  abort) printf 'never publish' > "$workspace/discard.txt" ;;
  *) exit 2 ;;
esac
