#!/bin/sh

# Read-only CMU diagnostic collector.  It is installed as the phase-2 proof
# overlay but is never added to the boot path or executed automatically.

OUTPUT=${1:-/data/cmu-overlay/diagnostic.txt}
VERSION_FILE=${CMU_VERSION_FILE:-/jci/version.ini}
WATCHDOG_FILE=${CMU_WATCHDOG_FILE:-/sys/class/gpio/Watchdog Disable/value}

{
    printf 'captured_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf unavailable)"
    if [ -r "$VERSION_FILE" ]; then
        grep '^JCI_SW_\|^JCI_BUILD_' "$VERSION_FILE"
        if command -v sha256sum >/dev/null 2>&1; then
            VERSION_SHA256=$(sha256sum "$VERSION_FILE" | awk '{print $1}')
        else
            VERSION_SHA256=$(openssl dgst -sha256 "$VERSION_FILE" | awk '{print $NF}')
        fi
        printf 'version_sha256=%s\n' "$VERSION_SHA256"
    fi
    awk '$2 == "/" { print "root_mount_flags=" $4 }' /proc/mounts
    [ -r "$WATCHDOG_FILE" ] && printf 'watchdog_disable=%s\n' "$(cat "$WATCHDOG_FILE")"
    df -Pk / /data 2>/dev/null
} > "$OUTPUT"
