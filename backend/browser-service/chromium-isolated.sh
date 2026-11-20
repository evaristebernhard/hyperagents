#!/bin/sh
set -eu
# Chromium sees only its own profile, download directory and authenticated display.
# Do not expose /data, /app, other profiles, application environment or host devices.
case "$BROWSER_PROFILE" in /profiles/????????-????-????-????-????????????) ;; *) exit 1;; esac
case "$BROWSER_WORK" in /tmp/browser-session-*) ;; *) exit 1;; esac
exec bwrap --unshare-user --unshare-pid --unshare-uts --unshare-ipc --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /home --tmpfs /tmp \
  --bind "$BROWSER_PROFILE" "$BROWSER_PROFILE" --bind "$BROWSER_WORK" "$BROWSER_WORK" \
  --ro-bind "/tmp/.X11-unix/X${DISPLAY#:}" "/tmp/.X11-unix/X${DISPLAY#:}" \
  --clearenv --setenv DISPLAY "$DISPLAY" --setenv XAUTHORITY "$XAUTHORITY" \
  --setenv HOME "$BROWSER_PROFILE" --setenv PATH /usr/bin:/bin \
  /usr/bin/chromium "$@"
