#!/bin/sh

# Mazda CMU reversible overlay manager USB entry point.  The unusual v74 USB
# launcher used by TouchTune invokes this conventional filename.

OVERLAY_USB_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
OVERLAY_MANIFEST_SHA256="d77480ef65a088ba098e93ac683ffd834c884559e0a97974e2403b9b12b0dde8"

. "$OVERLAY_USB_DIR/lib/overlay-manager.sh" || exit 1
overlay_main "$@"
