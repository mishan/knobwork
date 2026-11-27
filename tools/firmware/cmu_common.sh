#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Adapted from checksummaster/mzd-packing-scripts.

# The package password is not distributed with these scripts. Supply it in
# CMU_UP_PASSWORD or in the file named by CMU_UP_PASSWORD_FILE.
PASSWORD_FILE="${CMU_UP_PASSWORD_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/cmu-firmware/up-password}"
if [[ -n "${CMU_UP_PASSWORD:-}" ]]; then
    PASSWORD="$CMU_UP_PASSWORD"
elif [[ -r "$PASSWORD_FILE" ]]; then
    IFS= read -r PASSWORD < "$PASSWORD_FILE"
else
    echo "Set CMU_UP_PASSWORD or put the package password in $PASSWORD_FILE" >&2
    exit 2
fi
