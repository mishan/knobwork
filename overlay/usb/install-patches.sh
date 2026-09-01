#!/bin/sh

# Mazda CMU reversible overlay manager USB entry point.  The unusual v74 USB
# launcher used by TouchTune invokes this conventional filename.

OVERLAY_USB_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
OVERLAY_MANIFEST_SHA256="00cefeb07207b7227c3af9f9b0af0f0ec8b2e117b8011d870985682ba0a6022f"

. "$OVERLAY_USB_DIR/lib/overlay-manager.sh" || exit 1
overlay_main "$@"
