#!/bin/sh

# Mazda CMU reversible overlay manager USB entry point.  The unusual v74 USB
# launcher used by TouchTune invokes this conventional filename.

OVERLAY_USB_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
OVERLAY_MANIFEST_SHA256="87b51eb741b0925168ea1a3c70a943086fec9b1e706ac26c0fe79f86616a1cc6"

. "$OVERLAY_USB_DIR/lib/overlay-manager.sh" || exit 1
overlay_main "$@"
