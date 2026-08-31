#!/bin/sh

# Earliest Service Manager dependency gate. Overlay bookkeeping is deliberately
# fail-open: a broken counter must never prevent the stock service graph.
if [ -x /jci/scripts/cmu-overlay-boot-hook.sh ]; then
    /jci/scripts/cmu-overlay-boot-hook.sh attempt || true
fi

exit 0

