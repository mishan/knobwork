#!/bin/sh

# Mazda CMU reversible overlay manager USB entry point.  The unusual v74 USB
# launcher used by TouchTune invokes this conventional filename.

OVERLAY_USB_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
OVERLAY_MANIFEST_SHA256="751cea69aab0cff09d49c933d63b578d3d903e819f9a4341df96b3c6a7ad4a08"

. "$OVERLAY_USB_DIR/lib/overlay-manager.sh" || exit 1
overlay_main "$@"
