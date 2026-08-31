#!/bin/sh

# Bridge stock Service Manager stages to the persisted overlay runtime. Always
# return success so manager damage or state corruption cannot block CMU boot.

case "${1:-}" in
    attempt) MANAGER_ACTION=boot-attempt ;;
    success) MANAGER_ACTION=boot-success ;;
    *) exit 0 ;;
esac

OVERLAY_DATA=${MZD_OVERLAY_DATA_DIR:-/data/cmu-overlay}
HOOK_LOG="$OVERLAY_DATA/boot-hook.log"
HOOK_STATUS="$OVERLAY_DATA/boot-hook-status"
RUNTIME_CURRENT="$OVERLAY_DATA/runtime-current"

hook_timestamp() {
    date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf 'time-unavailable'
}

hook_record() {
    HOOK_RESULT=$1
    HOOK_DETAIL=$2
    HOOK_LINE="$(hook_timestamp)|action=$MANAGER_ACTION|result=$HOOK_RESULT|$HOOK_DETAIL"
    printf '%s\n' "$HOOK_LINE" >> "$HOOK_LOG" 2>/dev/null || true
    printf '%s\n' "$HOOK_LINE" > "$HOOK_STATUS.$$.stage" 2>/dev/null &&
        mv -f "$HOOK_STATUS.$$.stage" "$HOOK_STATUS" 2>/dev/null || true
}

if [ ! -r "$RUNTIME_CURRENT" ]; then
    hook_record skipped 'reason=runtime-current-missing'
    exit 0
fi

RUNTIME_ID=$(cat "$RUNTIME_CURRENT" 2>/dev/null)
if [ ${#RUNTIME_ID} -ne 64 ]; then
    hook_record skipped 'reason=runtime-id-length'
    exit 0
fi
case "$RUNTIME_ID" in
    *[!0123456789abcdef]*)
        hook_record skipped 'reason=runtime-id-format'
        exit 0
        ;;
esac

MANAGER="$OVERLAY_DATA/runtime/$RUNTIME_ID/install-patches.sh"
if [ ! -r "$MANAGER" ]; then
    hook_record skipped 'reason=manager-missing'
    exit 0
fi

if sh "$MANAGER" "$MANAGER_ACTION" >> "$HOOK_LOG" 2>&1; then
    hook_record ok "runtime=$RUNTIME_ID"
else
    HOOK_RC=$?
    hook_record failed "runtime=$RUNTIME_ID rc=$HOOK_RC"
fi

exit 0

