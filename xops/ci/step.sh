#!/usr/bin/env bash
# Adapted from wfform's tool/ci-step.sh. Keep command output and its real status.
set -uo pipefail
if [[ $# -lt 2 ]]; then
  printf 'usage: step.sh LABEL COMMAND [ARGUMENTS...]\n' >&2
  exit 64
fi
label=$1
shift
if [[ "$label" == *$'\n'* || "$label" == *$'\r'* ]]; then
  printf 'Step label must fit on one line.\n' >&2
  exit 64
fi
cyan='' green='' red='' reset=''
if [[ -z "${NO_COLOR+x}" && ( -t 1 || "${GITHUB_ACTIONS:-}" == true ) ]]; then
  cyan=$'\033[1;36m'; green=$'\033[1;32m'; red=$'\033[1;31m'; reset=$'\033[0m'
fi
run_marker='▶️'; pass_marker='✅'; fail_marker='❌'
if [[ "${FAAC_ASCII:-}" == 1 ]]; then
  run_marker='[run]'; pass_marker='[passed]'; fail_marker='[failed]'
fi
printf '%s%s %s%s\n' "$cyan" "$run_marker" "$label" "$reset"
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::group::%s\n' "$label"; fi
started=$SECONDS
if "$@"; then
  code=0
else
  code=$?
fi
elapsed=$((SECONDS - started))
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::endgroup::\n'; fi
if [[ $code -eq 0 ]]; then
  printf '%s%s %s (%ss)%s\n' "$green" "$pass_marker" "$label" "$elapsed" "$reset"
  status="$pass_marker $label (${elapsed}s)"
else
  printf '%s%s %s (exit %s, %ss)%s\n' "$red" "$fail_marker" "$label" "$code" "$elapsed" "$reset" >&2
  status="$fail_marker $label (exit $code, ${elapsed}s)"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf -- '- %s\n' "$status" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$code"
