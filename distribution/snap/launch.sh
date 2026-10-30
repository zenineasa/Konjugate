#!/bin/sh
# Copyright © 2026 Zenin Easa Panthakkalakath
#
# Starts Konjugate inside the snap. A classic snap cannot make Electron's chrome-sandbox helper
# setuid, so Chromium's sandbox relies on unprivileged user namespaces. Some kernels block those:
# Ubuntu 24.04 and later restrict them with AppArmor, and Debian can switch them off with a sysctl.
# On such a system Electron would refuse to start, so the sandbox is turned off there and only there;
# everywhere else it stays on.

restrictedByAppArmor="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)"
disabledBySysctl="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)"

if [ "$restrictedByAppArmor" = "1" ] || [ "$disabledBySysctl" = "0" ]; then
    set -- --no-sandbox "$@"
fi

exec "$SNAP/usr/lib/konjugate/Konjugate" "$@"
