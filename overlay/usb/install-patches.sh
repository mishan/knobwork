#!/bin/sh

# Mazda CMU reversible overlay manager USB entry point.  The unusual v74 USB
# launcher used by TouchTune invokes this conventional filename.

OVERLAY_USB_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
OVERLAY_MANIFEST_SHA256="05f75ec6e0efca1ea46727e09f2321e6e91039d9de3710c37ee54ce47c699daa"

. "$OVERLAY_USB_DIR/lib/overlay-manager.sh" || exit 1
overlay_main "$@"
