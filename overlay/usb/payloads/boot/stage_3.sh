#!/bin/sh

# Service Manager releases stage_3 only after jciMMUI has started. This is the
# native-service health acknowledgement; browser/HomeScreen health remains a
# separate future gate.
if [ -x /jci/scripts/cmu-overlay-boot-hook.sh ]; then
    /jci/scripts/cmu-overlay-boot-hook.sh success || true
fi

exit 0

