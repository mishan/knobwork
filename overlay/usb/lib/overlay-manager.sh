#!/bin/sh

# Transactional, BusyBox-compatible overlay manager for Mazda Connect Gen 6.
# Production paths are fixed.  MZD_OVERLAY_TEST_MODE is accepted only by the
# off-target regression suite, where it redirects the CMU root and state paths.

OVERLAY_FORMAT_VERSION=1
OVERLAY_MANIFEST="$OVERLAY_USB_DIR/manifest.v1"
OVERLAY_DATA_DIR="${MZD_OVERLAY_DATA_DIR:-/data/cmu-overlay}"
OVERLAY_BACKUP_DIR="$OVERLAY_DATA_DIR/backups/files"
OVERLAY_NVRAM_BACKUP_DIR="$OVERLAY_DATA_DIR/backups/nvram"
OVERLAY_STATE_FILE="$OVERLAY_DATA_DIR/state"
OVERLAY_ATTEMPT_FILE="$OVERLAY_DATA_DIR/boot-attempts"
OVERLAY_ACTIVE_TRANSACTION="$OVERLAY_DATA_DIR/active-transaction"
OVERLAY_CAN_PID_FILE="$OVERLAY_DATA_DIR/can-capture.pid"
OVERLAY_CAN_OUTPUT_FILE="$OVERLAY_DATA_DIR/can-capture-output"
OVERLAY_DATA_LOG="$OVERLAY_DATA_DIR/journal.log"
OVERLAY_USB_REAL=$(readlink -f "$OVERLAY_USB_DIR" 2>/dev/null || printf '%s' "$OVERLAY_USB_DIR")
OVERLAY_DATA_REAL=$(readlink -f "$OVERLAY_DATA_DIR" 2>/dev/null || true)
case "$OVERLAY_USB_REAL" in
    "$OVERLAY_DATA_REAL"/runtime/*) OVERLAY_DEFAULT_MIRROR_LOG="$OVERLAY_DATA_DIR/runtime-journal.log" ;;
    *) OVERLAY_DEFAULT_MIRROR_LOG="$OVERLAY_USB_DIR/overlay-manager.log" ;;
esac
OVERLAY_USB_LOG="${MZD_OVERLAY_USB_LOG:-$OVERLAY_DEFAULT_MIRROR_LOG}"
OVERLAY_ROOT_PREFIX=""
OVERLAY_TMP="/tmp/cmu-overlay.$$"
OVERLAY_ENTRIES="$OVERLAY_TMP.entries"
OVERLAY_NVRAM_ENTRIES="$OVERLAY_TMP.nvram"
OVERLAY_TXN_DIR=""
OVERLAY_TXN_ID=""
OVERLAY_ROLLBACK_COUNT=0
OVERLAY_INITIAL_MOUNT=""
OVERLAY_MOUNT_CHANGED=0
OVERLAY_WATCHDOG_VALUE=""
OVERLAY_WATCHDOG_CHANGED=0
OVERLAY_LOG_READY=0
OVERLAY_MUTATION_STARTED=0
OVERLAY_ACTION=""
OVERLAY_HASH_TOOL=""
OVERLAY_CAN_RESULT_MESSAGE=""

overlay_stderr() { printf '%s\n' "[cmu-overlay] $*" >&2; }

overlay_timestamp() {
    date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf 'time-unavailable'
}

overlay_journal() {
    overlay_level=$1
    shift
    overlay_line="$(overlay_timestamp)|action=$OVERLAY_ACTION|level=$overlay_level|$*"
    printf '%s\n' "$overlay_line"
    [ "$OVERLAY_LOG_READY" = "1" ] || return 0
    printf '%s\n' "$overlay_line" >> "$OVERLAY_DATA_LOG" || return 1
    printf '%s\n' "$overlay_line" >> "$OVERLAY_USB_LOG" || return 1
}

overlay_fail_injected() {
    [ "${MZD_OVERLAY_FAIL_POINT:-}" = "$1" ]
}

overlay_crash_injected() {
    [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] || return 0
    [ "${MZD_OVERLAY_CRASH_POINT:-}" = "$1" ] || return 0
    overlay_stderr "simulated process loss at $1"
    exit 99
}

overlay_sync() {
    overlay_fail_injected sync && return 1
    [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && return 0
    sync
}

overlay_select_hash_tool() {
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && [ -n "${MZD_OVERLAY_TEST_HASH_TOOL:-}" ]; then
        case "$MZD_OVERLAY_TEST_HASH_TOOL" in
            sha256sum|openssl) OVERLAY_HASH_TOOL=$MZD_OVERLAY_TEST_HASH_TOOL ;;
            *) return 1 ;;
        esac
    elif command -v sha256sum >/dev/null 2>&1; then
        OVERLAY_HASH_TOOL=sha256sum
    elif command -v openssl >/dev/null 2>&1; then
        OVERLAY_HASH_TOOL=openssl
    else
        return 1
    fi
    overlay_empty_hash=$(printf '' | overlay_sha256_stream) || return 1
    [ "$overlay_empty_hash" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ]
}

overlay_sha256_stream() {
    case "$OVERLAY_HASH_TOOL" in
        sha256sum) sha256sum 2>/dev/null | awk '{print $1}' ;;
        openssl) openssl dgst -sha256 2>/dev/null | awk '{print $NF}' ;;
        *) return 1 ;;
    esac
}

overlay_sha256() {
    case "$OVERLAY_HASH_TOOL" in
        sha256sum) overlay_digest=$(sha256sum "$1" 2>/dev/null | awk '{print $1}') ;;
        openssl) overlay_digest=$(openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}') ;;
        *) return 1 ;;
    esac
    overlay_is_hex_hash "$overlay_digest" || return 1
    printf '%s\n' "$overlay_digest"
}

overlay_sha256_value() {
    overlay_digest=$(printf '%s\n' "$1" | overlay_sha256_stream) || return 1
    overlay_is_hex_hash "$overlay_digest" || return 1
    printf '%s\n' "$overlay_digest"
}

overlay_hash_or_absent() {
    if [ -L "$1" ]; then
        printf 'unsafe-link\n'
    elif [ -f "$1" ]; then
        overlay_sha256 "$1"
    elif [ -e "$1" ]; then
        printf 'unexpected-type\n'
    else
        printf 'absent\n'
    fi
}

overlay_target_path() { printf '%s%s\n' "$OVERLAY_ROOT_PREFIX" "$1"; }

overlay_is_hex_hash() {
    [ ${#1} -eq 64 ] || return 1
    case "$1" in *[!0123456789abcdef]*) return 1 ;; esac
}

overlay_safe_absolute_path() {
    case "$1" in
        /*) ;;
        *) return 1 ;;
    esac
    case "$1" in
        *'..'*|*'//'*) return 1 ;;
    esac
    return 0
}

overlay_safe_payload_path() {
    case "$1" in
        ''|/*|*'..'*|*'//'*) return 1 ;;
    esac
    return 0
}

overlay_init_environment() {
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ]; then
        [ -n "${MZD_OVERLAY_ROOT_PREFIX:-}" ] || {
            overlay_stderr "test mode requires MZD_OVERLAY_ROOT_PREFIX"
            return 1
        }
        OVERLAY_ROOT_PREFIX=${MZD_OVERLAY_ROOT_PREFIX%/}
        OVERLAY_DATA_DIR="${MZD_OVERLAY_DATA_DIR:-$OVERLAY_ROOT_PREFIX/data/cmu-overlay}"
        OVERLAY_BACKUP_DIR="$OVERLAY_DATA_DIR/backups/files"
        OVERLAY_NVRAM_BACKUP_DIR="$OVERLAY_DATA_DIR/backups/nvram"
        OVERLAY_STATE_FILE="$OVERLAY_DATA_DIR/state"
        OVERLAY_ATTEMPT_FILE="$OVERLAY_DATA_DIR/boot-attempts"
        OVERLAY_ACTIVE_TRANSACTION="$OVERLAY_DATA_DIR/active-transaction"
        OVERLAY_CAN_PID_FILE="$OVERLAY_DATA_DIR/can-capture.pid"
        OVERLAY_CAN_OUTPUT_FILE="$OVERLAY_DATA_DIR/can-capture-output"
        OVERLAY_DATA_LOG="$OVERLAY_DATA_DIR/journal.log"
        OVERLAY_DATA_REAL=$(readlink -f "$OVERLAY_DATA_DIR" 2>/dev/null || true)
    else
        [ -d /jci ] || {
            overlay_stderr "refusing to run off-target: /jci is missing"
            return 1
        }
        [ -z "${MZD_OVERLAY_ROOT_PREFIX:-}" ] || {
            overlay_stderr "MZD_OVERLAY_ROOT_PREFIX is test-only"
            return 1
        }
        mkdir -p /tmp/mnt/data 2>/dev/null || return 1
        [ -e /data ] || ln -s /tmp/mnt/data /data 2>/dev/null || mkdir -p /data || return 1
    fi
    OVERLAY_NVRAM_DIR="${MZD_OVERLAY_NVRAM_DIR:-$OVERLAY_ROOT_PREFIX/sys/class/nvram/nv-config}"
    return 0
}

overlay_prepare_log_mount() {
    [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && return 0
    overlay_usb_flags=$(awk -v path="$OVERLAY_USB_DIR" '$2 == path {print $4; exit}' /proc/mounts)
    [ -n "$overlay_usb_flags" ] || return 0
    case ",$overlay_usb_flags," in
        *,rw,*) return 0 ;;
    esac
    mount -o rw,remount "$OVERLAY_USB_DIR" || return 1
    overlay_usb_flags=$(awk -v path="$OVERLAY_USB_DIR" '$2 == path {print $4; exit}' /proc/mounts)
    case ",$overlay_usb_flags," in *,rw,*) return 0 ;; esac
    return 1
}

overlay_init_logging() {
    mkdir -p "$OVERLAY_DATA_DIR" || return 1
    : >> "$OVERLAY_DATA_LOG" || return 1
    : >> "$OVERLAY_USB_LOG" || return 1
    OVERLAY_LOG_READY=1
    return 0
}

overlay_popup() {
    [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && return 0
    [ -x /jci/tools/jci-dialog ] || return 0
    killall -q jci-dialog 2>/dev/null || true
    /jci/tools/jci-dialog --info --title="CMU OVERLAY" --text="$1" --no-cancel >/dev/null 2>&1 &
}

overlay_choose_action() {
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ]; then
        case "${MZD_OVERLAY_TEST_ACTION:-install}" in
            install|repair|disable|restore|capture-can|cancel) printf '%s\n' "${MZD_OVERLAY_TEST_ACTION:-install}" ;;
            *) return 1 ;;
        esac
        return
    fi
    [ -x /jci/tools/jci-dialog ] || {
        overlay_stderr "jci-dialog is unavailable; pass an explicit action from a bench shell"
        return 1
    }
    killall -q jci-dialog 2>/dev/null || true
    if [ "$(overlay_expected_state)" = enabled ]; then
        overlay_capture_label="CAPTURE CAN"
        [ -f "$OVERLAY_CAN_PID_FILE" ] && overlay_capture_label="STOP CAN"
        /jci/tools/jci-dialog \
            --3-button-dialog \
            --title="CMU OVERLAY" \
            --text="The reversible overlay is enabled.\nCapture receive-only gateway traffic to this USB, or manage the overlay." \
            --ok-label="$overlay_capture_label" \
            --cancel-label="MANAGE" \
            --button3-label="CANCEL" >/dev/null 2>&1
        overlay_dialog_rc=$?
        case "$overlay_dialog_rc" in
            0) printf 'capture-can\n' ;;
            1)
                /jci/tools/jci-dialog \
                    --3-button-dialog \
                    --title="CMU OVERLAY" \
                    --text="Repair the installed overlay or restore stock files?" \
                    --ok-label="REPAIR" \
                    --cancel-label="DISABLE" \
                    --button3-label="CANCEL" >/dev/null 2>&1
                overlay_manage_rc=$?
                case "$overlay_manage_rc" in
                    0) printf 'repair\n' ;;
                    1) printf 'disable\n' ;;
                    2) printf 'cancel\n' ;;
                    *) return 1 ;;
                esac
                ;;
            2) printf 'cancel\n' ;;
            *) return 1 ;;
        esac
    else
        /jci/tools/jci-dialog \
            --confirm \
            --title="CMU OVERLAY" \
            --text="Install the pinned diagnostic overlay?" \
            --ok-label="INSTALL" \
            --cancel-label="CANCEL" >/dev/null 2>&1
        overlay_dialog_rc=$?
        case "$overlay_dialog_rc" in
            0) printf 'install\n' ;;
            1) printf 'cancel\n' ;;
            *) return 1 ;;
        esac
    fi
}

overlay_guard_acquire() {
    overlay_guard="${MZD_OVERLAY_GUARD_DIR:-/tmp/cmu-overlay-manager.guard}"
    if ! mkdir "$overlay_guard" 2>/dev/null; then
        overlay_guard_pid=$(cat "$overlay_guard/pid" 2>/dev/null || true)
        case "$overlay_guard_pid" in
            ''|*[!0-9]*) overlay_guard_pid=0 ;;
        esac
        if [ "$overlay_guard_pid" -gt 0 ] && kill -0 "$overlay_guard_pid" 2>/dev/null; then
            overlay_stderr "another overlay action is already running"
            return 1
        fi
        rm -f "$overlay_guard/pid" 2>/dev/null || return 1
        rmdir "$overlay_guard" 2>/dev/null || return 1
        mkdir "$overlay_guard" 2>/dev/null || return 1
    fi
    printf '%s\n' "$$" > "$overlay_guard/pid" || {
        rmdir "$overlay_guard" 2>/dev/null
        return 1
    }
    OVERLAY_GUARD_DIR=$overlay_guard
    return 0
}

overlay_guard_release() {
    if [ -n "${OVERLAY_GUARD_DIR:-}" ]; then
        rm -f "$OVERLAY_GUARD_DIR/pid" 2>/dev/null
        rmdir "$OVERLAY_GUARD_DIR" 2>/dev/null
    fi
    OVERLAY_GUARD_DIR=""
}

overlay_read_mount_state() {
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ]; then
        [ -r "${MZD_OVERLAY_MOUNT_STATE_FILE:-}" ] || return 1
        cat "$MZD_OVERLAY_MOUNT_STATE_FILE"
        return
    fi
    awk '$2 == "/" { split($4, flags, ","); for (i in flags) if (flags[i] == "rw") { print "rw"; exit } print "ro"; exit }' /proc/mounts
}

overlay_set_mount_state() {
    overlay_wanted=$1
    if overlay_fail_injected "remount-$overlay_wanted"; then
        return 1
    fi
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ]; then
        printf '%s\n' "$overlay_wanted" > "$MZD_OVERLAY_MOUNT_STATE_FILE" || return 1
    else
        mount -o "$overlay_wanted,remount" / || return 1
    fi
    [ "$(overlay_read_mount_state)" = "$overlay_wanted" ]
}

overlay_capture_safety_state() {
    OVERLAY_INITIAL_MOUNT=$(overlay_read_mount_state) || return 1
    case "$OVERLAY_INITIAL_MOUNT" in ro|rw) ;; *) return 1 ;; esac
    overlay_watchdog="${MZD_OVERLAY_WATCHDOG_PATH:-$OVERLAY_ROOT_PREFIX/sys/class/gpio/Watchdog Disable/value}"
    OVERLAY_WATCHDOG_PATH=$overlay_watchdog
    if [ -e "$overlay_watchdog" ]; then
        [ -r "$overlay_watchdog" ] && [ -w "$overlay_watchdog" ] || return 1
        OVERLAY_WATCHDOG_VALUE=$(cat "$overlay_watchdog") || return 1
    fi
    return 0
}

overlay_reset_safety_tracking() {
    OVERLAY_INITIAL_MOUNT=""
    OVERLAY_MOUNT_CHANGED=0
    OVERLAY_WATCHDOG_VALUE=""
    OVERLAY_WATCHDOG_CHANGED=0
    OVERLAY_MUTATION_STARTED=0
}

overlay_enter_mutation_state() {
    [ "$OVERLAY_MUTATION_STARTED" = "0" ] || return 0
    OVERLAY_MUTATION_STARTED=1
    if [ -n "$OVERLAY_WATCHDOG_VALUE" ]; then
        printf '1\n' > "$OVERLAY_WATCHDOG_PATH" || return 1
        [ "$(cat "$OVERLAY_WATCHDOG_PATH")" = "1" ] || return 1
        OVERLAY_WATCHDOG_CHANGED=1
        overlay_journal INFO "watchdog=disabled" || return 1
    fi
    if [ "$OVERLAY_INITIAL_MOUNT" != "rw" ]; then
        overlay_set_mount_state rw || return 1
        OVERLAY_MOUNT_CHANGED=1
        overlay_journal INFO "root_mount=rw" || return 1
    fi
    return 0
}

overlay_restore_safety_state() {
    overlay_cleanup_rc=0
    overlay_sync || overlay_cleanup_rc=1
    if [ "$OVERLAY_MOUNT_CHANGED" = "1" ]; then
        if overlay_set_mount_state "$OVERLAY_INITIAL_MOUNT"; then
            OVERLAY_MOUNT_CHANGED=0
            overlay_journal INFO "root_mount=$OVERLAY_INITIAL_MOUNT" || overlay_cleanup_rc=1
        else
            overlay_stderr "failed to restore root mount state to $OVERLAY_INITIAL_MOUNT"
            overlay_cleanup_rc=1
        fi
    fi
    if [ "$OVERLAY_WATCHDOG_CHANGED" = "1" ]; then
        if overlay_fail_injected watchdog-restore; then
            overlay_stderr "injected watchdog restoration failure"
            overlay_cleanup_rc=1
        elif printf '%s\n' "$OVERLAY_WATCHDOG_VALUE" > "$OVERLAY_WATCHDOG_PATH" &&
             [ "$(cat "$OVERLAY_WATCHDOG_PATH")" = "$OVERLAY_WATCHDOG_VALUE" ]; then
            OVERLAY_WATCHDOG_CHANGED=0
            overlay_journal INFO "watchdog=restored:$OVERLAY_WATCHDOG_VALUE" || overlay_cleanup_rc=1
        else
            overlay_stderr "failed to restore watchdog state"
            overlay_cleanup_rc=1
        fi
    fi
    overlay_sync || overlay_cleanup_rc=1
    return "$overlay_cleanup_rc"
}

overlay_parse_manifest() {
    [ -r "$OVERLAY_MANIFEST" ] || return 1
    overlay_manifest_actual=$(overlay_sha256 "$OVERLAY_MANIFEST") || return 1
    [ "$overlay_manifest_actual" = "$OVERLAY_MANIFEST_SHA256" ] || {
        overlay_journal ERROR "manifest_pin_mismatch expected=$OVERLAY_MANIFEST_SHA256 actual=$overlay_manifest_actual"
        return 1
    }

    : > "$OVERLAY_ENTRIES" || return 1
    : > "$OVERLAY_NVRAM_ENTRIES" || return 1
    OVERLAY_ID=""
    OVERLAY_FIRMWARE_FILE=""
    OVERLAY_FIRMWARE_SHA256=""
    OVERLAY_FIRMWARE_VERSION=""
    OVERLAY_FIRMWARE_PATCH=""
    OVERLAY_BOOT_LIMIT=""
    overlay_count=0
    overlay_nvram_count=0
    while IFS='|' read -r overlay_kind overlay_a overlay_b overlay_c overlay_d overlay_e overlay_f overlay_extra; do
        [ -n "$overlay_kind" ] || continue
        case "$overlay_kind" in
            manifest_version)
                [ "$overlay_a" = "$OVERLAY_FORMAT_VERSION" ] && [ -z "$overlay_b" ] || return 1
                ;;
            overlay_id)
                [ -n "$overlay_a" ] && [ -z "$overlay_b" ] || return 1
                OVERLAY_ID=$overlay_a
                ;;
            firmware_file)
                overlay_safe_absolute_path "$overlay_a" && [ -z "$overlay_b" ] || return 1
                OVERLAY_FIRMWARE_FILE=$overlay_a
                ;;
            firmware_sha256)
                overlay_is_hex_hash "$overlay_a" && [ -z "$overlay_b" ] || return 1
                OVERLAY_FIRMWARE_SHA256=$overlay_a
                ;;
            firmware_version)
                [ -n "$overlay_a" ] && [ -z "$overlay_b" ] || return 1
                OVERLAY_FIRMWARE_VERSION=$overlay_a
                ;;
            firmware_patch)
                [ -n "$overlay_a" ] && [ -z "$overlay_b" ] || return 1
                OVERLAY_FIRMWARE_PATCH=$overlay_a
                ;;
            boot_limit)
                case "$overlay_a" in ''|*[!0-9]*) return 1 ;; esac
                [ "$overlay_a" -gt 0 ] && [ -z "$overlay_b" ] || return 1
                OVERLAY_BOOT_LIMIT=$overlay_a
                ;;
            file)
                overlay_safe_absolute_path "$overlay_a" || return 1
                { [ "$overlay_b" = absent ] || overlay_is_hex_hash "$overlay_b"; } || return 1
                overlay_safe_payload_path "$overlay_c" || return 1
                overlay_is_hex_hash "$overlay_d" || return 1
                case "$overlay_e" in 0[0-7][0-7][0-7]) ;; *) return 1 ;; esac
                case "$overlay_f" in sh|js|data) ;; *) return 1 ;; esac
                [ -z "$overlay_extra" ] || return 1
                printf '%s|%s|%s|%s|%s|%s\n' "$overlay_a" "$overlay_b" "$overlay_c" "$overlay_d" "$overlay_e" "$overlay_f" >> "$OVERLAY_ENTRIES" || return 1
                overlay_count=$((overlay_count + 1))
                ;;
            nvram)
                case "$overlay_a" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
                overlay_is_hex_hash "$overlay_b" || return 1
                case "$overlay_c" in ''|*[!A-Za-z0-9_.:+/-]*) return 1 ;; esac
                overlay_is_hex_hash "$overlay_d" || return 1
                case "$overlay_e" in ''|*[!A-Za-z0-9_.:+/-]*) return 1 ;; esac
                [ -z "$overlay_f" ] && [ -z "$overlay_extra" ] || return 1
                [ "$(overlay_sha256_value "$overlay_c")" = "$overlay_b" ] || return 1
                [ "$(overlay_sha256_value "$overlay_e")" = "$overlay_d" ] || return 1
                printf '%s|%s|%s|%s|%s\n' "$overlay_a" "$overlay_b" "$overlay_c" "$overlay_d" "$overlay_e" >> "$OVERLAY_NVRAM_ENTRIES" || return 1
                overlay_nvram_count=$((overlay_nvram_count + 1))
                ;;
            *) return 1 ;;
        esac
    done < "$OVERLAY_MANIFEST"

    [ -n "$OVERLAY_ID" ] && [ -n "$OVERLAY_FIRMWARE_FILE" ] &&
        [ -n "$OVERLAY_FIRMWARE_SHA256" ] && [ -n "$OVERLAY_FIRMWARE_VERSION" ] &&
        [ -n "$OVERLAY_FIRMWARE_PATCH" ] && [ -n "$OVERLAY_BOOT_LIMIT" ] &&
        [ $((overlay_count + overlay_nvram_count)) -gt 0 ]
}

overlay_syntax_check() {
    overlay_type=$1
    overlay_file=$2
    case "$overlay_type" in
        data) return 0 ;;
        sh) sh -n "$overlay_file" ;;
        js)
            if [ -n "${MZD_OVERLAY_JS_CHECKER:-}" ]; then
                "$MZD_OVERLAY_JS_CHECKER" "$overlay_file"
            elif command -v node >/dev/null 2>&1; then
                node --check "$overlay_file" >/dev/null
            elif [ -x "$OVERLAY_DATA_DIR/bin/js-check" ]; then
                "$OVERLAY_DATA_DIR/bin/js-check" "$overlay_file"
            else
                overlay_stderr "no JavaScript syntax checker is installed; refusing $overlay_file"
                return 1
            fi
            ;;
    esac
}

overlay_check_firmware() {
    overlay_version_path=$(overlay_target_path "$OVERLAY_FIRMWARE_FILE")
    [ -f "$overlay_version_path" ] || return 1
    overlay_version_hash=$(overlay_sha256 "$overlay_version_path") || return 1
    [ "$overlay_version_hash" = "$OVERLAY_FIRMWARE_SHA256" ] || {
        overlay_journal ERROR "firmware_metadata_hash_mismatch actual=$overlay_version_hash"
        return 1
    }
    grep -F -q "JCI_SW_VER=\"$OVERLAY_FIRMWARE_VERSION\"" "$overlay_version_path" || return 1
    grep -F -q "JCI_SW_VER_PATCH=\"$OVERLAY_FIRMWARE_PATCH\"" "$overlay_version_path" || return 1
    return 0
}

overlay_can_process_state() {
    OVERLAY_CAN_PID=""
    [ ! -L "$OVERLAY_CAN_PID_FILE" ] || return 2
    [ -e "$OVERLAY_CAN_PID_FILE" ] || return 1
    [ -f "$OVERLAY_CAN_PID_FILE" ] || return 2
    OVERLAY_CAN_PID=$(cat "$OVERLAY_CAN_PID_FILE" 2>/dev/null || true)
    case "$OVERLAY_CAN_PID" in ''|*[!0-9]*) return 2 ;; esac
    kill -0 "$OVERLAY_CAN_PID" 2>/dev/null || return 1
    [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && return 0
    overlay_can_expected=$(readlink -f "$(overlay_target_path /jci/bin/cmu-can-listener)" 2>/dev/null || true)
    overlay_can_actual=$(readlink -f "/proc/$OVERLAY_CAN_PID/exe" 2>/dev/null || true)
    [ -n "$overlay_can_expected" ] && [ "$overlay_can_actual" = "$overlay_can_expected" ] || return 2
    return 0
}

overlay_stop_can_capture() {
    overlay_can_process_state
    overlay_can_state=$?
    if [ "$overlay_can_state" -eq 1 ]; then
        rm -f "$OVERLAY_CAN_PID_FILE" 2>/dev/null || return 1
        return 0
    fi
    [ "$overlay_can_state" -eq 0 ] || {
        overlay_journal ERROR "can_capture=pid_conflict" || true
        return 1
    }
    kill -TERM "$OVERLAY_CAN_PID" 2>/dev/null || return 1
    overlay_can_wait=0
    while kill -0 "$OVERLAY_CAN_PID" 2>/dev/null && [ "$overlay_can_wait" -lt 5 ]; do
        sleep 1
        overlay_can_wait=$((overlay_can_wait + 1))
    done
    kill -0 "$OVERLAY_CAN_PID" 2>/dev/null && {
        overlay_journal ERROR "can_capture=stop_timeout pid=$OVERLAY_CAN_PID" || true
        return 1
    }
    rm -f "$OVERLAY_CAN_PID_FILE" || return 1
    overlay_sync || return 1
    overlay_can_output=$(cat "$OVERLAY_CAN_OUTPUT_FILE" 2>/dev/null || printf 'unknown')
    OVERLAY_CAN_RESULT_MESSAGE="CAN capture stopped.\n\nLog: $overlay_can_output\nIt is now safe to remove the USB."
    overlay_journal INFO "can_capture=stopped pid=$OVERLAY_CAN_PID output=$overlay_can_output" || return 1
    return 0
}

overlay_validate_can_payload() {
    overlay_parse_manifest || return 1
    overlay_check_firmware || return 1
    overlay_can_found=0
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        [ "$overlay_target" = /jci/bin/cmu-can-listener ] || continue
        [ "$overlay_can_found" -eq 0 ] || return 1
        [ "$overlay_stock" = absent ] && [ "$overlay_mode" = 0755 ] && [ "$overlay_type" = data ] || return 1
        overlay_can_live=$(overlay_target_path "$overlay_target")
        [ -f "$overlay_can_live" ] && [ ! -L "$overlay_can_live" ] && [ -x "$overlay_can_live" ] || return 1
        [ "$(overlay_sha256 "$overlay_can_live")" = "$overlay_payload_hash" ] || return 1
        overlay_can_found=1
    done < "$OVERLAY_ENTRIES"
    [ "$overlay_can_found" -eq 1 ]
}

overlay_start_can_capture() {
    [ ! -e "$OVERLAY_ACTIVE_TRANSACTION" ] || {
        overlay_journal ERROR "can_capture=blocked reason=active_transaction" || true
        return 1
    }
    [ "$(overlay_expected_state)" = enabled ] || {
        overlay_journal ERROR "can_capture=blocked reason=overlay_not_enabled" || true
        return 1
    }
    overlay_validate_can_payload || {
        overlay_journal ERROR "can_capture=blocked reason=payload_validation" || true
        return 1
    }
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" != "1" ]; then
        case "$OVERLAY_USB_REAL" in
            "$OVERLAY_DATA_REAL"/runtime/*)
                overlay_journal ERROR "can_capture=blocked reason=runtime_bundle" || true
                return 1
                ;;
        esac
        overlay_usb_flags=$(awk -v path="$OVERLAY_USB_DIR" '$2 == path {print $4; exit}' /proc/mounts)
        case ",$overlay_usb_flags," in *,rw,*) ;; *) return 1 ;; esac
    fi
    overlay_can_stamp=$(date -u '+%Y%m%dT%H%M%SZ' 2>/dev/null || printf 'time-unavailable')
    overlay_can_output="$OVERLAY_USB_DIR/cmu-vim-can-$overlay_can_stamp.jsonl"
    overlay_can_errors="$OVERLAY_USB_DIR/cmu-vim-can-$overlay_can_stamp.stderr.log"
    [ ! -e "$overlay_can_output" ] && [ ! -e "$overlay_can_errors" ] || return 1
    : > "$overlay_can_output" || return 1
    : > "$overlay_can_errors" || return 1
    overlay_can_logger=$(overlay_target_path /jci/bin/cmu-can-listener)
    if [ "${MZD_OVERLAY_TEST_MODE:-0}" = "1" ] && [ -n "${MZD_OVERLAY_TEST_CAN_LOGGER:-}" ]; then
        overlay_can_logger=$MZD_OVERLAY_TEST_CAN_LOGGER
    fi
    [ -x "$overlay_can_logger" ] && [ ! -L "$overlay_can_logger" ] || return 1
    nohup "$overlay_can_logger" >> "$overlay_can_output" 2>> "$overlay_can_errors" </dev/null &
    overlay_can_pid=$!
    sleep 1
    if ! kill -0 "$overlay_can_pid" 2>/dev/null; then
        overlay_journal ERROR "can_capture=start_failed errors=$overlay_can_errors" || true
        return 1
    fi
    overlay_write_atomic "$OVERLAY_CAN_OUTPUT_FILE" "$overlay_can_output" || {
        kill -TERM "$overlay_can_pid" 2>/dev/null || true
        return 1
    }
    overlay_write_atomic "$OVERLAY_CAN_PID_FILE" "$overlay_can_pid" || {
        kill -TERM "$overlay_can_pid" 2>/dev/null || true
        return 1
    }
    overlay_sync || {
        kill -TERM "$overlay_can_pid" 2>/dev/null || true
        rm -f "$OVERLAY_CAN_PID_FILE" 2>/dev/null || true
        return 1
    }
    OVERLAY_CAN_RESULT_MESSAGE="Receive-only CAN capture started.\n\nLog: $overlay_can_output\nRun capture-can again to stop before removing the USB."
    overlay_journal INFO "can_capture=started pid=$overlay_can_pid output=$overlay_can_output errors=$overlay_can_errors" || {
        kill -TERM "$overlay_can_pid" 2>/dev/null || true
        rm -f "$OVERLAY_CAN_PID_FILE" 2>/dev/null || true
        return 1
    }
    return 0
}

overlay_action_capture_can() {
    overlay_can_process_state
    overlay_can_state=$?
    case "$overlay_can_state" in
        0) overlay_stop_can_capture ;;
        1)
            rm -f "$OVERLAY_CAN_PID_FILE" 2>/dev/null || return 1
            overlay_start_can_capture
            ;;
        *)
            overlay_journal ERROR "can_capture=blocked reason=pid_conflict" || true
            return 1
            ;;
    esac
}

overlay_check_space() {
    overlay_parent=$1
    overlay_needed=$2
    overlay_available=$(df -Pk "$overlay_parent" 2>/dev/null | awk 'NR == 2 {print $4}')
    case "$overlay_available" in ''|*[!0-9]*) return 1 ;; esac
    [ "$overlay_available" -ge "$overlay_needed" ]
}

overlay_backup_status() {
    overlay_target=$1
    overlay_stock=$2
    overlay_backup="$OVERLAY_BACKUP_DIR$overlay_target"
    overlay_backup_mode="$overlay_backup.mode"
    [ ! -L "$overlay_backup" ] && [ ! -L "$overlay_backup.absent" ] &&
        [ ! -L "$overlay_backup_mode" ] || return 1
    if [ "$overlay_stock" = absent ]; then
        [ ! -e "$overlay_backup" ] && [ ! -e "$overlay_backup_mode" ] || return 1
        if [ -f "$overlay_backup.absent" ]; then printf 'valid\n'; else printf 'missing\n'; fi
    else
        [ ! -e "$overlay_backup.absent" ] || return 1
        if [ -f "$overlay_backup" ]; then
            [ "$(overlay_sha256 "$overlay_backup")" = "$overlay_stock" ] || return 1
            [ -e "$overlay_backup_mode" ] || {
                printf 'incomplete\n'
                return 0
            }
            [ -f "$overlay_backup_mode" ] || return 1
            overlay_saved_mode=$(cat "$overlay_backup_mode") || return 1
            case "$overlay_saved_mode" in
                [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
                *) return 1 ;;
            esac
            printf 'valid\n'
        else
            if [ -e "$overlay_backup_mode" ]; then
                [ -f "$overlay_backup_mode" ] || return 1
                overlay_saved_mode=$(cat "$overlay_backup_mode") || return 1
                case "$overlay_saved_mode" in
                    [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
                    *) return 1 ;;
                esac
                printf 'incomplete\n'
            else
                printf 'missing\n'
            fi
        fi
    fi
}

overlay_nvram_backup_status() {
    overlay_key=$1
    overlay_stock_hash=$2
    overlay_backup="$OVERLAY_NVRAM_BACKUP_DIR/$overlay_key"
    [ ! -L "$overlay_backup" ] || return 1
    if [ -f "$overlay_backup" ]; then
        [ "$(overlay_sha256 "$overlay_backup")" = "$overlay_stock_hash" ] || return 1
        printf 'valid\n'
    else
        printf 'missing\n'
    fi
}

overlay_preflight() {
    overlay_parse_manifest || return 1
    overlay_check_firmware || {
        overlay_journal ERROR "firmware=unsupported"
        return 1
    }

    overlay_stock_count=0
    overlay_payload_count=0
    overlay_unknown_count=0
    overlay_required_bytes=65536
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        overlay_payload="$OVERLAY_USB_DIR/$overlay_payload_rel"
        [ -f "$overlay_payload" ] || return 1
        [ "$(overlay_sha256 "$overlay_payload")" = "$overlay_payload_hash" ] || return 1
        overlay_syntax_check "$overlay_type" "$overlay_payload" || return 1

        overlay_live=$(overlay_target_path "$overlay_target")
        overlay_parent=$(dirname "$overlay_live")
        [ -d "$overlay_parent" ] || return 1
        [ ! -L "$overlay_live" ] || return 1
        overlay_payload_bytes=$(wc -c < "$overlay_payload") || return 1
        overlay_required_bytes=$((overlay_required_bytes + overlay_payload_bytes))
        if [ -f "$overlay_live" ]; then
            overlay_live_bytes=$(wc -c < "$overlay_live") || return 1
            overlay_required_bytes=$((overlay_required_bytes + overlay_live_bytes * 2))
        fi
        overlay_current=$(overlay_hash_or_absent "$overlay_live")
        if [ "$overlay_current" = "$overlay_stock" ]; then
            overlay_stock_count=$((overlay_stock_count + 1))
        elif [ "$overlay_current" = "$overlay_payload_hash" ]; then
            overlay_payload_count=$((overlay_payload_count + 1))
        else
            overlay_unknown_count=$((overlay_unknown_count + 1))
        fi
        overlay_backup_state=$(overlay_backup_status "$overlay_target" "$overlay_stock") || return 1
        if [ "$overlay_current" = "$overlay_payload_hash" ] && [ "$overlay_backup_state" != valid ]; then
            return 1
        fi
        if [ "$overlay_backup_state" = incomplete ] && [ "$overlay_current" != "$overlay_stock" ]; then
            return 1
        fi
    done < "$OVERLAY_ENTRIES"

    overlay_required_kb=$((overlay_required_bytes / 1024 + 1))
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        overlay_live=$(overlay_target_path "$overlay_target")
        overlay_check_space "$(dirname "$overlay_live")" "$overlay_required_kb" || return 1
    done < "$OVERLAY_ENTRIES"

    OVERLAY_NVRAM_DIR="${MZD_OVERLAY_NVRAM_DIR:-$OVERLAY_ROOT_PREFIX/sys/class/nvram/nv-config}"
    while IFS='|' read -r overlay_key overlay_stock_hash overlay_stock_value overlay_payload_hash overlay_payload_value; do
        overlay_key_file="$OVERLAY_NVRAM_DIR/keys/$overlay_key"
        [ -f "$overlay_key_file" ] && [ ! -L "$overlay_key_file" ] || return 1
        [ -w "$OVERLAY_NVRAM_DIR/add" ] && [ -w "$OVERLAY_NVRAM_DIR/commit" ] || return 1
        overlay_current_value=$(cat "$overlay_key_file") || return 1
        overlay_current_hash=$(overlay_sha256_value "$overlay_current_value") || return 1
        if [ "$overlay_current_hash" = "$overlay_stock_hash" ] && [ "$overlay_current_value" = "$overlay_stock_value" ]; then
            overlay_stock_count=$((overlay_stock_count + 1))
        elif [ "$overlay_current_hash" = "$overlay_payload_hash" ] && [ "$overlay_current_value" = "$overlay_payload_value" ]; then
            overlay_payload_count=$((overlay_payload_count + 1))
        else
            overlay_unknown_count=$((overlay_unknown_count + 1))
        fi
        overlay_backup_state=$(overlay_nvram_backup_status "$overlay_key" "$overlay_stock_hash") || return 1
        if [ "$overlay_current_hash" = "$overlay_payload_hash" ] && [ "$overlay_backup_state" != valid ]; then
            return 1
        fi
    done < "$OVERLAY_NVRAM_ENTRIES"

    [ "$overlay_unknown_count" -eq 0 ] || {
        overlay_journal ERROR "preflight=unexpected_target count=$overlay_unknown_count"
        return 1
    }
    case "$OVERLAY_ACTION" in
        install)
            [ "$overlay_stock_count" -eq 0 ] || [ "$overlay_payload_count" -eq 0 ] || {
                overlay_journal ERROR "preflight=partial_overlay"
                return 1
            }
            ;;
        repair|disable|restore|safe-mode) ;;
        verify) ;;
    esac
    overlay_journal INFO "preflight=ok overlay=$OVERLAY_ID stock=$overlay_stock_count payload=$overlay_payload_count" || return 1
    return 0
}

overlay_create_backup() {
    overlay_target=$1
    overlay_stock=$2
    overlay_live=$(overlay_target_path "$overlay_target")
    overlay_backup="$OVERLAY_BACKUP_DIR$overlay_target"
    overlay_backup_state=$(overlay_backup_status "$overlay_target" "$overlay_stock") || return 1
    [ "$overlay_backup_state" = valid ] && return 0
    overlay_original_mode=absent
    mkdir -p "$(dirname "$overlay_backup")" || return 1
    if [ "$overlay_stock" = absent ]; then
        : > "$overlay_backup.absent" || return 1
        chmod 0444 "$overlay_backup.absent" || return 1
    else
        [ "$(overlay_hash_or_absent "$overlay_live")" = "$overlay_stock" ] || return 1
        if [ "$overlay_backup_state" = incomplete ]; then
            rm -f "$overlay_backup" "$overlay_backup.mode" || return 1
        fi
        overlay_backup_stage="$overlay_backup.$$.stage"
        overlay_backup_mode="$overlay_backup.mode"
        overlay_backup_mode_stage="$overlay_backup_mode.$$.stage"
        overlay_original_mode=$(stat -c '%a' "$overlay_live" 2>/dev/null) || return 1
        case "$overlay_original_mode" in
            [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
            *) return 1 ;;
        esac
        cp -p "$overlay_live" "$overlay_backup_stage" || return 1
        [ "$(overlay_sha256 "$overlay_backup_stage")" = "$overlay_stock" ] || return 1
        chmod a-w "$overlay_backup_stage" || return 1
        printf '%s\n' "$overlay_original_mode" > "$overlay_backup_mode_stage" || return 1
        chmod 0444 "$overlay_backup_mode_stage" || return 1
        mv "$overlay_backup_stage" "$overlay_backup" || return 1
        mv "$overlay_backup_mode_stage" "$overlay_backup_mode" || return 1
    fi
    overlay_journal INFO "backup=created target=$overlay_target stock=$overlay_stock mode=$overlay_original_mode" || return 1
}

overlay_create_nvram_backup() {
    overlay_key=$1
    overlay_stock_hash=$2
    overlay_stock_value=$3
    overlay_backup_state=$(overlay_nvram_backup_status "$overlay_key" "$overlay_stock_hash") || return 1
    [ "$overlay_backup_state" = valid ] && return 0
    overlay_key_file="$OVERLAY_NVRAM_DIR/keys/$overlay_key"
    overlay_current_value=$(cat "$overlay_key_file") || return 1
    [ "$overlay_current_value" = "$overlay_stock_value" ] || return 1
    mkdir -p "$OVERLAY_NVRAM_BACKUP_DIR" || return 1
    overlay_backup="$OVERLAY_NVRAM_BACKUP_DIR/$overlay_key"
    overlay_backup_stage="$overlay_backup.$$.stage"
    printf '%s\n' "$overlay_current_value" > "$overlay_backup_stage" || return 1
    [ "$(overlay_sha256 "$overlay_backup_stage")" = "$overlay_stock_hash" ] || return 1
    chmod 0444 "$overlay_backup_stage" || return 1
    mv "$overlay_backup_stage" "$overlay_backup" || return 1
    overlay_journal INFO "backup=created nvram=$overlay_key sha256=$overlay_stock_hash" || return 1
}

overlay_record_rollback() {
    overlay_target=$1
    overlay_live=$2
    OVERLAY_ROLLBACK_COUNT=$((OVERLAY_ROLLBACK_COUNT + 1))
    overlay_rollback="$OVERLAY_TXN_DIR/previous.$OVERLAY_ROLLBACK_COUNT"
    if [ -f "$overlay_live" ]; then
        cp -p "$overlay_live" "$overlay_rollback" || return 1
        overlay_previous_hash=$(overlay_sha256 "$overlay_rollback") || return 1
        overlay_previous_mode=$(stat -c '%a' "$overlay_live" 2>/dev/null) || return 1
        case "$overlay_previous_mode" in
            [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
            *) return 1 ;;
        esac
        chmod a-w "$overlay_rollback" || return 1
    else
        overlay_previous_hash=absent
        overlay_previous_mode=absent
    fi
    overlay_write_atomic "$OVERLAY_TXN_DIR/rollback.$OVERLAY_ROLLBACK_COUNT" \
        "file|$overlay_target|$overlay_previous_hash|$overlay_previous_mode" || return 1
    overlay_sync || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/rollback-count" "$OVERLAY_ROLLBACK_COUNT" || return 1
    overlay_sync || return 1
}

overlay_write_nvram() {
    overlay_key=$1
    overlay_value=$2
    overlay_expected_hash=$3
    overlay_key_file="$OVERLAY_NVRAM_DIR/keys/$overlay_key"
    overlay_previous_value=$(cat "$overlay_key_file") || return 1
    overlay_previous_hash=$(overlay_sha256_value "$overlay_previous_value") || return 1
    OVERLAY_ROLLBACK_COUNT=$((OVERLAY_ROLLBACK_COUNT + 1))
    overlay_write_atomic "$OVERLAY_TXN_DIR/rollback.$OVERLAY_ROLLBACK_COUNT" \
        "nvram|$overlay_key|$overlay_previous_hash|$overlay_previous_value" || return 1
    overlay_sync || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/rollback-count" "$OVERLAY_ROLLBACK_COUNT" || return 1
    overlay_sync || return 1
    overlay_fail_injected "nvram:$overlay_key" && return 1
    printf '%s=%s\n' "$overlay_key" "$overlay_value" > "$OVERLAY_NVRAM_DIR/add" || return 1
    printf '%s\n' "$overlay_value" > "$overlay_key_file" || return 1
    printf '\n' > "$OVERLAY_NVRAM_DIR/commit" || return 1
    overlay_actual_value=$(cat "$overlay_key_file") || return 1
    overlay_actual_hash=$(overlay_sha256_value "$overlay_actual_value") || return 1
    [ "$overlay_actual_value" = "$overlay_value" ] && [ "$overlay_actual_hash" = "$overlay_expected_hash" ] || return 1
    overlay_journal INFO "nvram=ok key=$overlay_key sha256=$overlay_expected_hash" || return 1
    overlay_crash_injected "mutation:$OVERLAY_ROLLBACK_COUNT"
}

overlay_replace_with_file() {
    overlay_target=$1
    overlay_source=$2
    overlay_expected=$3
    overlay_mode=$4
    overlay_type=$5
    overlay_live=$(overlay_target_path "$overlay_target")
    overlay_parent=$(dirname "$overlay_live")
    case "$overlay_type" in
        js) overlay_stage_suffix=.js ;;
        sh) overlay_stage_suffix=.sh ;;
        *) overlay_stage_suffix= ;;
    esac
    overlay_stage="$overlay_parent/.cmu-overlay.$$.stage.$((OVERLAY_ROLLBACK_COUNT + 1))$overlay_stage_suffix"
    cp -p "$overlay_source" "$overlay_stage" || return 1
    [ "$overlay_mode" = preserve ] || chmod "$overlay_mode" "$overlay_stage" || return 1
    [ "$(overlay_sha256 "$overlay_stage")" = "$overlay_expected" ] || return 1
    overlay_syntax_check "$overlay_type" "$overlay_stage" || return 1
    overlay_record_rollback "$overlay_target" "$overlay_live" || return 1
    mv -f "$overlay_stage" "$overlay_live" || return 1
    [ "$(overlay_sha256 "$overlay_live")" = "$overlay_expected" ] || return 1
    overlay_journal INFO "replace=ok target=$overlay_target sha256=$overlay_expected" || return 1
    overlay_crash_injected "mutation:$OVERLAY_ROLLBACK_COUNT"
    overlay_fail_injected "replace:$OVERLAY_ROLLBACK_COUNT" && return 1
    return 0
}

overlay_replace_with_absent() {
    overlay_target=$1
    overlay_live=$(overlay_target_path "$overlay_target")
    [ ! -e "$overlay_live" ] && return 0
    overlay_record_rollback "$overlay_target" "$overlay_live" || return 1
    overlay_removed="$(dirname "$overlay_live")/.cmu-overlay.$$.removed.$OVERLAY_ROLLBACK_COUNT"
    mv "$overlay_live" "$overlay_removed" || return 1
    rm -f "$overlay_removed" || return 1
    [ ! -e "$overlay_live" ] || return 1
    overlay_journal INFO "remove=ok target=$overlay_target" || return 1
    overlay_crash_injected "mutation:$OVERLAY_ROLLBACK_COUNT"
}

overlay_restore_target() {
    overlay_target=$1
    overlay_stock=$2
    overlay_mode=$3
    if [ "$overlay_stock" = absent ]; then
        overlay_replace_with_absent "$overlay_target"
    else
        overlay_backup="$OVERLAY_BACKUP_DIR$overlay_target"
        [ "$(overlay_sha256 "$overlay_backup")" = "$overlay_stock" ] || return 1
        overlay_backup_mode="$overlay_backup.mode"
        overlay_stock_mode=$(cat "$overlay_backup_mode") || return 1
        case "$overlay_stock_mode" in
            [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
            *) return 1 ;;
        esac
        overlay_replace_with_file "$overlay_target" "$overlay_backup" "$overlay_stock" "$overlay_stock_mode" data
    fi
}

overlay_manifest_accepts_file_state() {
    overlay_wanted_target=$1
    overlay_wanted_hash=$2
    while IFS='|' read -r overlay_entry_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        if [ "$overlay_entry_target" = "$overlay_wanted_target" ]; then
            [ "$overlay_wanted_hash" = "$overlay_stock" ] ||
                [ "$overlay_wanted_hash" = "$overlay_payload_hash" ]
            return
        fi
    done < "$OVERLAY_ENTRIES"
    return 1
}

overlay_manifest_accepts_nvram_state() {
    overlay_wanted_key=$1
    overlay_wanted_hash=$2
    overlay_wanted_value=$3
    while IFS='|' read -r overlay_entry_key overlay_stock_hash overlay_stock_value overlay_payload_hash overlay_payload_value; do
        if [ "$overlay_entry_key" = "$overlay_wanted_key" ]; then
            { [ "$overlay_wanted_hash" = "$overlay_stock_hash" ] &&
                [ "$overlay_wanted_value" = "$overlay_stock_value" ]; } ||
                { [ "$overlay_wanted_hash" = "$overlay_payload_hash" ] &&
                    [ "$overlay_wanted_value" = "$overlay_payload_value" ]; }
            return
        fi
    done < "$OVERLAY_NVRAM_ENTRIES"
    return 1
}

overlay_load_rollback_count() {
    [ -r "$OVERLAY_TXN_DIR/rollback-count" ] || return 1
    OVERLAY_ROLLBACK_COUNT=$(cat "$OVERLAY_TXN_DIR/rollback-count") || return 1
    case "$OVERLAY_ROLLBACK_COUNT" in ''|*[!0-9]*) return 1 ;; esac
    overlay_max_rollbacks=$(wc -l < "$OVERLAY_ENTRIES") || return 1
    overlay_max_nvram=$(wc -l < "$OVERLAY_NVRAM_ENTRIES") || return 1
    overlay_max_rollbacks=$((overlay_max_rollbacks + overlay_max_nvram))
    [ "$OVERLAY_ROLLBACK_COUNT" -le "$overlay_max_rollbacks" ]
}

overlay_rollback() {
    overlay_load_rollback_count || return 1
    overlay_journal ERROR "transaction=rollback count=$OVERLAY_ROLLBACK_COUNT" || true
    overlay_i=$OVERLAY_ROLLBACK_COUNT
    while [ "$overlay_i" -gt 0 ]; do
        IFS='|' read -r overlay_rollback_type overlay_target overlay_previous_hash overlay_previous_value overlay_extra < "$OVERLAY_TXN_DIR/rollback.$overlay_i" || return 1
        [ -z "$overlay_extra" ] || return 1
        case "$overlay_rollback_type" in
            file)
                overlay_safe_absolute_path "$overlay_target" || return 1
                overlay_manifest_accepts_file_state "$overlay_target" "$overlay_previous_hash" || return 1
                overlay_live=$(overlay_target_path "$overlay_target")
                if [ "$overlay_previous_hash" = absent ]; then
                    [ "$overlay_previous_value" = absent ] || return 1
                    rm -f "$overlay_live" || return 1
                    [ "$(overlay_hash_or_absent "$overlay_live")" = absent ] || return 1
                else
                    overlay_is_hex_hash "$overlay_previous_hash" || return 1
                    case "$overlay_previous_value" in
                        [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
                        *) return 1 ;;
                    esac
                    overlay_previous="$OVERLAY_TXN_DIR/previous.$overlay_i"
                    [ -f "$overlay_previous" ] && [ ! -L "$overlay_previous" ] || return 1
                    [ "$(overlay_sha256 "$overlay_previous")" = "$overlay_previous_hash" ] || return 1
                    overlay_parent=$(dirname "$overlay_live")
                    overlay_stage="$overlay_parent/.cmu-overlay.recovery.$$.stage"
                    cp -p "$overlay_previous" "$overlay_stage" || return 1
                    chmod "$overlay_previous_value" "$overlay_stage" || return 1
                    [ "$(overlay_sha256 "$overlay_stage")" = "$overlay_previous_hash" ] || return 1
                    mv -f "$overlay_stage" "$overlay_live" || return 1
                    [ "$(overlay_hash_or_absent "$overlay_live")" = "$overlay_previous_hash" ] || return 1
                    [ "$(stat -c '%a' "$overlay_live" 2>/dev/null)" = "$overlay_previous_value" ] || return 1
                fi
                overlay_journal INFO "rollback=target target=$overlay_target" || return 1
                ;;
            nvram)
                overlay_is_hex_hash "$overlay_previous_hash" || return 1
                [ "$(overlay_sha256_value "$overlay_previous_value")" = "$overlay_previous_hash" ] || return 1
                overlay_manifest_accepts_nvram_state "$overlay_target" "$overlay_previous_hash" "$overlay_previous_value" || return 1
                printf '%s=%s\n' "$overlay_target" "$overlay_previous_value" > "$OVERLAY_NVRAM_DIR/add" || return 1
                printf '%s\n' "$overlay_previous_value" > "$OVERLAY_NVRAM_DIR/keys/$overlay_target" || return 1
                printf '\n' > "$OVERLAY_NVRAM_DIR/commit" || return 1
                [ "$(cat "$OVERLAY_NVRAM_DIR/keys/$overlay_target")" = "$overlay_previous_value" ] || return 1
                overlay_journal INFO "rollback=nvram key=$overlay_target" || return 1
                ;;
            *) return 1 ;;
        esac
        overlay_crash_injected "rollback:$overlay_i"
        overlay_i=$((overlay_i - 1))
    done
    overlay_sync
}

overlay_discard_rollback() {
    overlay_load_rollback_count || return 1
    overlay_i=1
    while [ "$overlay_i" -le "$OVERLAY_ROLLBACK_COUNT" ]; do
        rm -f "$OVERLAY_TXN_DIR/previous.$overlay_i" \
            "$OVERLAY_TXN_DIR/rollback.$overlay_i" || return 1
        overlay_i=$((overlay_i + 1))
    done
    return 0
}

overlay_write_atomic() {
    overlay_atomic_destination=$1
    overlay_atomic_value=$2
    overlay_atomic_stage="$overlay_atomic_destination.$$.stage"
    printf '%s\n' "$overlay_atomic_value" > "$overlay_atomic_stage" || return 1
    mv -f "$overlay_atomic_stage" "$overlay_atomic_destination" || return 1
}

overlay_transaction_set_phase() {
    overlay_phase=$1
    case "$overlay_phase" in
        prepared|mutating|rolling-back|rolled-back|committed) ;;
        *) return 1 ;;
    esac
    overlay_write_atomic "$OVERLAY_TXN_DIR/phase" "$overlay_phase" || return 1
    overlay_sync
}

overlay_transaction_id_safe() {
    case "$1" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
    return 0
}

overlay_transaction_begin() {
    overlay_direction=$1
    [ ! -e "$OVERLAY_ACTIVE_TRANSACTION" ] && [ ! -L "$OVERLAY_ACTIVE_TRANSACTION" ] || return 1
    overlay_txn_base="$(date -u '+%Y%m%dT%H%M%SZ' 2>/dev/null || printf unknown)-$$"
    overlay_txn_suffix=0
    while :; do
        OVERLAY_TXN_ID="$overlay_txn_base-$overlay_txn_suffix"
        overlay_transaction_id_safe "$OVERLAY_TXN_ID" || return 1
        OVERLAY_TXN_DIR="$OVERLAY_DATA_DIR/transactions/$OVERLAY_TXN_ID"
        [ -e "$OVERLAY_TXN_DIR" ] || [ -L "$OVERLAY_TXN_DIR" ] || break
        overlay_txn_suffix=$((overlay_txn_suffix + 1))
        [ "$overlay_txn_suffix" -le 100 ] || return 1
    done
    mkdir -p "$OVERLAY_TXN_DIR" "$OVERLAY_BACKUP_DIR" "$OVERLAY_NVRAM_BACKUP_DIR" || return 1
    OVERLAY_ROLLBACK_COUNT=0
    overlay_snapshot_metadata || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/format" 1 || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/manifest-sha256" "$OVERLAY_MANIFEST_SHA256" || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/direction" "$overlay_direction" || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/initial-mount" "$OVERLAY_INITIAL_MOUNT" || return 1
    if [ -n "$OVERLAY_WATCHDOG_VALUE" ]; then
        overlay_saved_watchdog=$OVERLAY_WATCHDOG_VALUE
    else
        overlay_saved_watchdog=absent
    fi
    case "$overlay_saved_watchdog" in absent|0|1) ;; *) return 1 ;; esac
    overlay_write_atomic "$OVERLAY_TXN_DIR/watchdog-value" "$overlay_saved_watchdog" || return 1
    overlay_write_atomic "$OVERLAY_TXN_DIR/rollback-count" 0 || return 1
    overlay_transaction_set_phase prepared || return 1
    overlay_write_atomic "$OVERLAY_ACTIVE_TRANSACTION" "$OVERLAY_TXN_ID" || return 1
    overlay_sync || return 1
    overlay_journal INFO "transaction=prepared id=$OVERLAY_TXN_ID direction=$overlay_direction" || return 1
}

overlay_transaction_load() {
    [ -f "$OVERLAY_ACTIVE_TRANSACTION" ] && [ ! -L "$OVERLAY_ACTIVE_TRANSACTION" ] || return 1
    OVERLAY_TXN_ID=$(cat "$OVERLAY_ACTIVE_TRANSACTION") || return 1
    overlay_transaction_id_safe "$OVERLAY_TXN_ID" || return 1
    OVERLAY_TXN_DIR="$OVERLAY_DATA_DIR/transactions/$OVERLAY_TXN_ID"
    [ -d "$OVERLAY_TXN_DIR" ] && [ ! -L "$OVERLAY_TXN_DIR" ] || return 1
    [ "$(cat "$OVERLAY_TXN_DIR/format" 2>/dev/null)" = 1 ] || return 1
    [ "$(cat "$OVERLAY_TXN_DIR/manifest-sha256" 2>/dev/null)" = "$OVERLAY_MANIFEST_SHA256" ] || return 1
    overlay_txn_direction=$(cat "$OVERLAY_TXN_DIR/direction" 2>/dev/null) || return 1
    case "$overlay_txn_direction" in enabled|factory) ;; *) return 1 ;; esac
    overlay_txn_phase=$(cat "$OVERLAY_TXN_DIR/phase" 2>/dev/null) || return 1
    case "$overlay_txn_phase" in prepared|mutating|rolling-back|rolled-back|committed) ;; *) return 1 ;; esac
    overlay_saved_mount=$(cat "$OVERLAY_TXN_DIR/initial-mount" 2>/dev/null) || return 1
    case "$overlay_saved_mount" in ro|rw) ;; *) return 1 ;; esac
    overlay_saved_watchdog=$(cat "$OVERLAY_TXN_DIR/watchdog-value" 2>/dev/null) || return 1
    case "$overlay_saved_watchdog" in absent|0|1) ;; *) return 1 ;; esac
    overlay_load_rollback_count || return 1
    if [ -f "$OVERLAY_TXN_DIR/previous-state" ]; then
        [ ! -e "$OVERLAY_TXN_DIR/previous-state.absent" ] || return 1
    else
        [ -f "$OVERLAY_TXN_DIR/previous-state.absent" ] || return 1
    fi
    if [ -f "$OVERLAY_TXN_DIR/previous-attempts" ]; then
        [ ! -e "$OVERLAY_TXN_DIR/previous-attempts.absent" ] || return 1
    else
        [ -f "$OVERLAY_TXN_DIR/previous-attempts.absent" ] || return 1
    fi
}

overlay_transaction_restore_saved_safety() {
    OVERLAY_INITIAL_MOUNT=$overlay_saved_mount
    OVERLAY_MOUNT_CHANGED=0
    [ "$(overlay_read_mount_state)" = "$OVERLAY_INITIAL_MOUNT" ] || OVERLAY_MOUNT_CHANGED=1
    OVERLAY_WATCHDOG_CHANGED=0
    if [ "$overlay_saved_watchdog" = absent ]; then
        OVERLAY_WATCHDOG_VALUE=""
    else
        OVERLAY_WATCHDOG_VALUE=$overlay_saved_watchdog
        [ -e "$OVERLAY_WATCHDOG_PATH" ] || return 1
        [ "$(cat "$OVERLAY_WATCHDOG_PATH")" = "$OVERLAY_WATCHDOG_VALUE" ] || OVERLAY_WATCHDOG_CHANGED=1
    fi
    return 0
}

overlay_transaction_abort() {
    overlay_transaction_set_phase rolling-back || return 1
    overlay_rollback || return 1
    overlay_restore_metadata || return 1
    overlay_sync || return 1
    overlay_transaction_set_phase rolled-back
}

overlay_transaction_cleanup() {
    overlay_discard_rollback || return 1
    rm -f "$OVERLAY_TXN_DIR/format" "$OVERLAY_TXN_DIR/manifest-sha256" \
        "$OVERLAY_TXN_DIR/direction" "$OVERLAY_TXN_DIR/initial-mount" \
        "$OVERLAY_TXN_DIR/watchdog-value" "$OVERLAY_TXN_DIR/rollback-count" \
        "$OVERLAY_TXN_DIR/phase" "$OVERLAY_TXN_DIR/previous-state" \
        "$OVERLAY_TXN_DIR/previous-state.absent" \
        "$OVERLAY_TXN_DIR/previous-attempts" \
        "$OVERLAY_TXN_DIR/previous-attempts.absent" || return 1
    rmdir "$OVERLAY_TXN_DIR" 2>/dev/null || return 1
}

overlay_transaction_finalize() {
    [ -n "$OVERLAY_TXN_ID" ] && [ -n "$OVERLAY_TXN_DIR" ] || return 0
    overlay_phase=$(cat "$OVERLAY_TXN_DIR/phase" 2>/dev/null) || return 1
    case "$overlay_phase" in committed|rolled-back) ;; *) return 1 ;; esac
    [ "$(cat "$OVERLAY_ACTIVE_TRANSACTION" 2>/dev/null)" = "$OVERLAY_TXN_ID" ] || return 1
    rm -f "$OVERLAY_ACTIVE_TRANSACTION" || return 1
    overlay_sync || return 1
    overlay_transaction_cleanup || {
        overlay_journal ERROR "transaction=cleanup_failed id=$OVERLAY_TXN_ID" || true
        return 1
    }
    overlay_journal INFO "transaction=finalized id=$OVERLAY_TXN_ID phase=$overlay_phase" || return 1
    OVERLAY_TXN_ID=""
    OVERLAY_TXN_DIR=""
}

overlay_recover_interrupted_transaction() {
    [ -e "$OVERLAY_ACTIVE_TRANSACTION" ] || return 0
    overlay_parse_manifest || return 1
    overlay_check_firmware || return 1
    overlay_transaction_load || {
        overlay_journal ERROR "recovery=invalid_transaction_metadata" || true
        return 1
    }
    overlay_journal ERROR "recovery=detected id=$OVERLAY_TXN_ID phase=$overlay_txn_phase" || return 1
    overlay_transaction_restore_saved_safety || return 1
    case "$overlay_txn_phase" in
        prepared|mutating|rolling-back)
            overlay_enter_mutation_state || return 1
            overlay_transaction_abort || return 1
            overlay_journal INFO "recovery=rolled_back id=$OVERLAY_TXN_ID" || return 1
            ;;
        committed)
            overlay_journal INFO "recovery=commit_retained id=$OVERLAY_TXN_ID" || return 1
            ;;
        rolled-back)
            overlay_journal INFO "recovery=rollback_already_complete id=$OVERLAY_TXN_ID" || return 1
            ;;
    esac
    overlay_restore_safety_state || return 1
    overlay_transaction_finalize || return 1
    overlay_reset_safety_tracking
    overlay_capture_safety_state || return 1
    overlay_journal INFO "recovery=complete" || return 1
}

overlay_install_runtime() {
    overlay_runtime_root="$OVERLAY_DATA_DIR/runtime"
    overlay_runtime="$overlay_runtime_root/$OVERLAY_MANIFEST_SHA256"
    if [ -d "$overlay_runtime" ]; then
        [ "$(overlay_sha256 "$overlay_runtime/manifest.v1")" = "$OVERLAY_MANIFEST_SHA256" ] || return 1
        [ "$(overlay_sha256 "$overlay_runtime/install-patches.sh")" = "$(overlay_sha256 "$OVERLAY_USB_DIR/install-patches.sh")" ] || return 1
        [ "$(overlay_sha256 "$overlay_runtime/lib/overlay-manager.sh")" = "$(overlay_sha256 "$OVERLAY_USB_DIR/lib/overlay-manager.sh")" ] || return 1
    else
        mkdir -p "$overlay_runtime_root" || return 1
        overlay_runtime_stage="$overlay_runtime_root/.$OVERLAY_MANIFEST_SHA256.$$.stage"
        mkdir -p "$overlay_runtime_stage" || return 1
        cp -p "$OVERLAY_USB_DIR/install-patches.sh" "$overlay_runtime_stage/" || return 1
        cp -p "$OVERLAY_USB_DIR/manifest.v1" "$overlay_runtime_stage/" || return 1
        cp -R "$OVERLAY_USB_DIR/lib" "$overlay_runtime_stage/" || return 1
        cp -R "$OVERLAY_USB_DIR/payloads" "$overlay_runtime_stage/" || return 1
        [ "$(overlay_sha256 "$overlay_runtime_stage/manifest.v1")" = "$OVERLAY_MANIFEST_SHA256" ] || return 1
        chmod -R a-w "$overlay_runtime_stage" || return 1
        mv "$overlay_runtime_stage" "$overlay_runtime" || return 1
    fi
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        [ "$(overlay_sha256 "$overlay_runtime/$overlay_payload_rel")" = "$overlay_payload_hash" ] || return 1
    done < "$OVERLAY_ENTRIES"
    overlay_write_atomic "$OVERLAY_DATA_DIR/runtime-current" "$OVERLAY_MANIFEST_SHA256" || return 1
    overlay_journal INFO "runtime=ready path=$overlay_runtime" || return 1
}

overlay_snapshot_metadata() {
    if [ -f "$OVERLAY_STATE_FILE" ]; then
        cp -p "$OVERLAY_STATE_FILE" "$OVERLAY_TXN_DIR/previous-state" || return 1
    else
        : > "$OVERLAY_TXN_DIR/previous-state.absent" || return 1
    fi
    if [ -f "$OVERLAY_ATTEMPT_FILE" ]; then
        cp -p "$OVERLAY_ATTEMPT_FILE" "$OVERLAY_TXN_DIR/previous-attempts" || return 1
    else
        : > "$OVERLAY_TXN_DIR/previous-attempts.absent" || return 1
    fi
}

overlay_restore_metadata() {
    overlay_metadata_rc=0
    if [ -f "$OVERLAY_TXN_DIR/previous-state" ]; then
        cp -p "$OVERLAY_TXN_DIR/previous-state" "$OVERLAY_STATE_FILE.$$.recovery" || overlay_metadata_rc=1
        [ "$overlay_metadata_rc" -ne 0 ] || mv -f "$OVERLAY_STATE_FILE.$$.recovery" "$OVERLAY_STATE_FILE" || overlay_metadata_rc=1
    else
        rm -f "$OVERLAY_STATE_FILE" || overlay_metadata_rc=1
    fi
    if [ -f "$OVERLAY_TXN_DIR/previous-attempts" ]; then
        cp -p "$OVERLAY_TXN_DIR/previous-attempts" "$OVERLAY_ATTEMPT_FILE.$$.recovery" || overlay_metadata_rc=1
        [ "$overlay_metadata_rc" -ne 0 ] || mv -f "$OVERLAY_ATTEMPT_FILE.$$.recovery" "$OVERLAY_ATTEMPT_FILE" || overlay_metadata_rc=1
    else
        rm -f "$OVERLAY_ATTEMPT_FILE" || overlay_metadata_rc=1
    fi
    return "$overlay_metadata_rc"
}

overlay_expected_state() {
    if [ -r "$OVERLAY_STATE_FILE" ]; then cat "$OVERLAY_STATE_FILE"; else printf 'factory\n'; fi
}

overlay_verify_targets() {
    overlay_wanted=$1
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        overlay_live=$(overlay_target_path "$overlay_target")
        case "$overlay_wanted" in
            enabled) overlay_expected=$overlay_payload_hash ;;
            *) overlay_expected=$overlay_stock ;;
        esac
        [ "$(overlay_hash_or_absent "$overlay_live")" = "$overlay_expected" ] || return 1
        if [ "$overlay_wanted" = enabled ]; then
            [ "$(stat -c '%a' "$overlay_live" 2>/dev/null)" = "${overlay_mode#0}" ] || return 1
        elif [ "$overlay_stock" != absent ]; then
            overlay_backup_mode="$OVERLAY_BACKUP_DIR$overlay_target.mode"
            if [ -f "$overlay_backup_mode" ]; then
                overlay_stock_mode=$(cat "$overlay_backup_mode") || return 1
                [ "$(stat -c '%a' "$overlay_live" 2>/dev/null)" = "$overlay_stock_mode" ] || return 1
            fi
        fi
    done < "$OVERLAY_ENTRIES"
    while IFS='|' read -r overlay_key overlay_stock_hash overlay_stock_value overlay_payload_hash overlay_payload_value; do
        overlay_current_value=$(cat "$OVERLAY_NVRAM_DIR/keys/$overlay_key") || return 1
        case "$overlay_wanted" in
            enabled) overlay_expected_hash=$overlay_payload_hash; overlay_expected_value=$overlay_payload_value ;;
            *) overlay_expected_hash=$overlay_stock_hash; overlay_expected_value=$overlay_stock_value ;;
        esac
        overlay_current_hash=$(overlay_sha256_value "$overlay_current_value") || return 1
        [ "$overlay_current_value" = "$overlay_expected_value" ] && [ "$overlay_current_hash" = "$overlay_expected_hash" ] || return 1
    done < "$OVERLAY_NVRAM_ENTRIES"
    return 0
}

overlay_transaction() {
    overlay_direction=$1
    if [ "$overlay_direction" = factory ]; then
        overlay_stop_can_capture || return 1
    fi
    overlay_transaction_begin "$overlay_direction" || return 1
    overlay_enter_mutation_state || {
        overlay_transaction_abort
        return 1
    }
    overlay_transaction_set_phase mutating || {
        overlay_transaction_abort
        return 1
    }
    while IFS='|' read -r overlay_target overlay_stock overlay_payload_rel overlay_payload_hash overlay_mode overlay_type; do
        overlay_create_backup "$overlay_target" "$overlay_stock" || {
            overlay_transaction_abort
            return 1
        }
        if [ "$overlay_direction" = enabled ]; then
            overlay_replace_with_file "$overlay_target" "$OVERLAY_USB_DIR/$overlay_payload_rel" "$overlay_payload_hash" "$overlay_mode" "$overlay_type" || {
                overlay_transaction_abort
                return 1
            }
        else
            overlay_restore_target "$overlay_target" "$overlay_stock" "$overlay_mode" || {
                overlay_transaction_abort
                return 1
            }
        fi
        [ ! -e "$OVERLAY_TMP.interrupted" ] || {
            overlay_transaction_abort
            return 1
        }
    done < "$OVERLAY_ENTRIES"
    while IFS='|' read -r overlay_key overlay_stock_hash overlay_stock_value overlay_payload_hash overlay_payload_value; do
        overlay_create_nvram_backup "$overlay_key" "$overlay_stock_hash" "$overlay_stock_value" || {
            overlay_transaction_abort
            return 1
        }
        if [ "$overlay_direction" = enabled ]; then
            overlay_write_nvram "$overlay_key" "$overlay_payload_value" "$overlay_payload_hash" || {
                overlay_transaction_abort
                return 1
            }
        else
            overlay_backup="$OVERLAY_NVRAM_BACKUP_DIR/$overlay_key"
            [ "$(overlay_sha256 "$overlay_backup")" = "$overlay_stock_hash" ] || {
                overlay_transaction_abort
                return 1
            }
            overlay_stock_backup_value=$(cat "$overlay_backup") || {
                overlay_transaction_abort
                return 1
            }
            overlay_write_nvram "$overlay_key" "$overlay_stock_backup_value" "$overlay_stock_hash" || {
                overlay_transaction_abort
                return 1
            }
        fi
        [ ! -e "$OVERLAY_TMP.interrupted" ] || {
            overlay_transaction_abort
            return 1
        }
    done < "$OVERLAY_NVRAM_ENTRIES"

    [ ! -e "$OVERLAY_TMP.interrupted" ] || {
        overlay_transaction_abort
        return 1
    }
    overlay_sync || {
        overlay_transaction_abort
        return 1
    }
    overlay_fail_injected final-verify && {
        overlay_transaction_abort
        return 1
    }
    overlay_verify_targets "$overlay_direction" || {
        overlay_transaction_abort
        return 1
    }
    overlay_write_atomic "$OVERLAY_STATE_FILE" "$overlay_direction" || {
        overlay_transaction_abort
        return 1
    }
    overlay_write_atomic "$OVERLAY_ATTEMPT_FILE" 0 || {
        overlay_transaction_abort
        return 1
    }
    overlay_sync || {
        overlay_transaction_abort
        return 1
    }
    overlay_crash_injected metadata
    overlay_journal INFO "transaction=committed state=$overlay_direction" || {
        overlay_transaction_abort
        return 1
    }
    overlay_transaction_set_phase committed || {
        overlay_transaction_abort
        return 1
    }
    overlay_crash_injected committed
    return 0
}

overlay_action_verify() {
    overlay_state=$(overlay_expected_state)
    case "$overlay_state" in enabled) overlay_wanted=enabled ;; *) overlay_wanted=factory ;; esac
    overlay_verify_targets "$overlay_wanted" || return 1
    overlay_journal INFO "verify=ok state=$overlay_state"
}

overlay_action_boot_attempt() {
    overlay_state=$(overlay_expected_state)
    [ "$overlay_state" = enabled ] || {
        overlay_journal INFO "boot_attempt=ignored state=$overlay_state"
        return 0
    }
    if [ -r "$OVERLAY_ATTEMPT_FILE" ]; then overlay_attempts=$(cat "$OVERLAY_ATTEMPT_FILE"); else overlay_attempts=0; fi
    case "$overlay_attempts" in ''|*[!0-9]*) return 1 ;; esac
    overlay_attempts=$((overlay_attempts + 1))
    overlay_write_atomic "$OVERLAY_ATTEMPT_FILE" "$overlay_attempts" || return 1
    overlay_journal INFO "boot_attempt=$overlay_attempts limit=$OVERLAY_BOOT_LIMIT" || return 1
    if [ "$overlay_attempts" -ge "$OVERLAY_BOOT_LIMIT" ]; then
        OVERLAY_ACTION=safe-mode
        overlay_journal ERROR "safe_mode=triggered attempts=$overlay_attempts" || return 1
        overlay_transaction factory || return 1
        overlay_write_atomic "$OVERLAY_STATE_FILE" safe-mode || return 1
        overlay_journal INFO "safe_mode=restored" || return 1
    fi
}

overlay_action_boot_success() {
    overlay_write_atomic "$OVERLAY_ATTEMPT_FILE" 0 || return 1
    overlay_journal INFO "boot_attempt=reset"
}

overlay_cleanup_files() {
    rm -f "$OVERLAY_ENTRIES" "$OVERLAY_NVRAM_ENTRIES" "$OVERLAY_TMP.interrupted" 2>/dev/null
    overlay_guard_release
}

overlay_usage() {
    printf '%s\n' \
        "Usage: install-patches.sh {install|verify|repair|disable|restore|capture-can|boot-attempt|boot-success}" \
        "" \
        "install       apply a completely stock overlay set" \
        "verify        verify the state recorded under /data" \
        "repair        re-apply payloads from any known stock/payload mixture" \
        "disable       restore stock targets but retain backups" \
        "restore       restore stock targets and record restored state" \
        "capture-can   start or stop receive-only gateway capture to this USB" \
        "boot-attempt  increment the boot counter and roll back at its limit" \
        "boot-success  reset the boot counter after a healthy HMI startup"
}

overlay_main() {
    [ "$#" -le 1 ] || { overlay_usage >&2; return 2; }
    case "${1:-}" in -h|--help|help) overlay_usage; return 0 ;; esac
    overlay_select_hash_tool || {
        overlay_stderr "a working SHA-256 backend (sha256sum or openssl) is required"
        return 1
    }
    overlay_init_environment || return 1
    overlay_guard_acquire || return 1
    if [ "$#" -eq 0 ]; then
        OVERLAY_ACTION=$(overlay_choose_action) || {
            overlay_guard_release
            return 1
        }
        if [ "$OVERLAY_ACTION" = cancel ]; then
            overlay_guard_release
            return 0
        fi
    else
        OVERLAY_ACTION=$1
    fi
    case "$OVERLAY_ACTION" in
        install|verify|repair|disable|restore|capture-can|boot-attempt|boot-success) ;;
        *) overlay_usage >&2; overlay_guard_release; return 2 ;;
    esac
    trap 'overlay_stderr "interrupted"; : > "$OVERLAY_TMP.interrupted"' HUP INT TERM
    overlay_prepare_log_mount || {
        overlay_stderr "cannot remount the USB writable for its required journal"
        overlay_cleanup_files
        return 1
    }
    overlay_init_logging || {
        overlay_stderr "both USB and /data journals must be writable"
        overlay_cleanup_files
        return 1
    }
    overlay_journal INFO "action=start" || {
        overlay_cleanup_files
        return 1
    }
    if [ "$OVERLAY_ACTION" = capture-can ]; then
        overlay_action_capture_can
        overlay_rc=$?
        if [ "$overlay_rc" -eq 0 ]; then
            overlay_journal INFO "action=result status=ok" || overlay_rc=1
            [ "$overlay_rc" -ne 0 ] || overlay_popup "$OVERLAY_CAN_RESULT_MESSAGE"
        else
            overlay_journal ERROR "action=result status=failed" || true
            overlay_popup "CAN capture action failed.\n\nSee overlay-manager.log on the USB."
        fi
        overlay_cleanup_files
        trap - HUP INT TERM
        return "$overlay_rc"
    fi
    overlay_capture_safety_state || {
        overlay_journal ERROR "safety_state=capture_failed" || true
        overlay_cleanup_files
        return 1
    }
    overlay_recover_interrupted_transaction
    overlay_rc=$?
    if [ "$overlay_rc" -eq 0 ]; then
        overlay_preflight
        overlay_rc=$?
    fi
    [ ! -e "$OVERLAY_TMP.interrupted" ] || overlay_rc=1
    if [ "$overlay_rc" -eq 0 ]; then
        case "$OVERLAY_ACTION" in
            install|repair) overlay_install_runtime || overlay_rc=1 ;;
        esac
    fi
    if [ "$overlay_rc" -eq 0 ]; then
        case "$OVERLAY_ACTION" in
            install|repair|disable|restore) overlay_popup "Applying $OVERLAY_ACTION...\n\nDo not remove the USB or press any buttons." ;;
        esac
        case "$OVERLAY_ACTION" in
            install|repair) overlay_transaction enabled; overlay_rc=$? ;;
            disable) overlay_transaction factory; overlay_rc=$? ;;
            restore)
                overlay_transaction factory
                overlay_rc=$?
                [ "$overlay_rc" -ne 0 ] || overlay_write_atomic "$OVERLAY_STATE_FILE" restored || overlay_rc=1
                ;;
            verify) overlay_action_verify; overlay_rc=$? ;;
            boot-attempt) overlay_action_boot_attempt; overlay_rc=$? ;;
            boot-success) overlay_action_boot_success; overlay_rc=$? ;;
        esac
    fi
    [ ! -e "$OVERLAY_TMP.interrupted" ] || overlay_rc=1
    overlay_safety_rc=0
    overlay_restore_safety_state || {
        overlay_safety_rc=1
        overlay_rc=1
    }
    if [ "$overlay_safety_rc" -eq 0 ] && [ -n "$OVERLAY_TXN_ID" ]; then
        overlay_transaction_finalize || overlay_rc=1
    fi
    if [ "$overlay_rc" -eq 0 ]; then
        overlay_journal INFO "action=result status=ok" || overlay_rc=1
        [ "$overlay_rc" -ne 0 ] || overlay_popup "$OVERLAY_ACTION completed successfully."
    else
        overlay_journal ERROR "action=result status=failed" || true
        overlay_popup "$OVERLAY_ACTION failed.\n\nSee overlay-manager.log on the USB."
    fi
    overlay_cleanup_files
    trap - HUP INT TERM
    return "$overlay_rc"
}
