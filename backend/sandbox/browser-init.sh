#!/bin/sh
set -eu
umask 077
export DISPLAY=:0 XAUTHORITY=/work/Xauthority HOME=/profile
mkdir -p /tmp/.X11-unix /work/downloads
xauth -f "$XAUTHORITY" add :0 . "$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" &
for n in $(seq 1 100); do test -S /tmp/.X11-unix/X0 && break; sleep .05; done
openbox --config-file /etc/xdg/openbox/rc.xml >/work/openbox.log 2>&1 &
# Only the isolated loopback has TCP. Host transport is Unix sockets.
socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/control/egress.sock &
x11vnc -display :0 -auth "$XAUTHORITY" -localhost -rfbport 5900 -forever -shared -nopw -noxdamage -nosel -quiet >/work/vnc.log 2>&1 &
x11vnc -display :0 -auth "$XAUTHORITY" -localhost -rfbport 5901 -viewonly -forever -shared -nopw -noxdamage -nosel -quiet >/work/observe.log 2>&1 &
socat UNIX-LISTEN:/control/control.sock,fork,mode=0600 TCP:127.0.0.1:5900 &
socat UNIX-LISTEN:/control/observe.sock,fork,mode=0600 TCP:127.0.0.1:5901 &
# CDP never gets a host TCP listener; port 9222 exists only in the network namespace.
socat UNIX-LISTEN:/control/cdp.sock,fork,mode=0600 TCP:127.0.0.1:9222 &
python3 /usr/local/bin/hyper-browser-files.py &
exec /usr/bin/chromium --user-data-dir=/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
 --proxy-server=http://127.0.0.1:3128 '--proxy-bypass-list=<-loopback>' --disable-quic \
 --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-dev-shm-usage --no-first-run \
 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --password-store=basic --disable-features=WebRtcHideLocalIpsWithMdns --window-size=1280,800 about:blank
