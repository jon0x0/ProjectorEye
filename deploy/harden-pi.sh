#!/bin/sh
# Make a Pi easier to diagnose and quicker to recover after a hang:
#   1. persistent journal (logs survive reboots; capped at 200 MB)
#   2. Wi-Fi power saving off (a common cause of Pis dropping off Wi-Fi)
#   3. hardware watchdog (reboots by itself if the system hangs)
# Safe to run again. Run as the pi user: sh deploy/harden-pi.sh
set -e

echo "== 1. persistent journal"
sudo mkdir -p /var/log/journal /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' | sudo tee /etc/systemd/journald.conf.d/eye-persistent.conf >/dev/null
sudo systemd-tmpfiles --create --prefix /var/log/journal
sudo systemctl restart systemd-journald
sudo journalctl --flush
echo "journal: $(du -sh /var/log/journal | cut -f1) in /var/log/journal"

echo "== 2. Wi-Fi power saving off"
# NetworkManager (Bookworm): 2 = disable, for every Wi-Fi connection from now on.
sudo mkdir -p /etc/NetworkManager/conf.d
printf '[connection]\nwifi.powersave = 2\n' | sudo tee /etc/NetworkManager/conf.d/eye-wifi-powersave-off.conf >/dev/null
# Saved connections too, without reconnecting now (that would drop this session).
nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2 == "802-11-wireless" {print $1}' | while read -r c; do
  sudo nmcli connection modify "$c" 802-11-wireless.powersave 2 && echo "connection '$c': powersave off"
done
# And the running interface, immediately.
# (iw / iwconfig live in /sbin, which is not on the pi user's PATH.)
if [ -x /usr/sbin/iw ] || [ -x /sbin/iw ]; then
  sudo iw dev wlan0 set power_save off
  echo "wlan0: $(sudo iw dev wlan0 get power_save)"
else
  sudo iwconfig wlan0 power off
  echo "wlan0: $(sudo iwconfig wlan0 | grep -o 'Power Management:[a-z]*')"
fi

echo "== 3. hardware watchdog"
# The Pi's watchdog allows at most ~15 s; systemd pets it, and the board
# resets if the system stops responding for that long.
sudo mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=14s\nRebootWatchdogSec=2min\n' | sudo tee /etc/systemd/system.conf.d/eye-watchdog.conf >/dev/null
sudo systemctl daemon-reexec
sleep 1
echo "watchdog device: $(ls /dev/watchdog* 2>/dev/null | tr '\n' ' ')"
systemctl show -p RuntimeWatchdogUSec -p RebootWatchdogUSec | tr '\n' ' '
echo
dmesg 2>/dev/null | grep -i watchdog | tail -2 || true
echo "== done"
