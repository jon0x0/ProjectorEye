#!/bin/sh
# Create a key-only "pi" user like Raspberry Pi OS's default one: hardware
# groups, passwordless sudo, and the invoking user's authorized SSH keys.
# Run as an existing sudo user:  sh deploy/create-pi-user.sh
set -e
NEW=pi
if ! id "$NEW" >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash "$NEW"
fi
for g in adm dialout cdrom sudo audio video plugdev games users input render netdev gpio i2c spi; do
  getent group "$g" >/dev/null && sudo usermod -aG "$g" "$NEW"
done
# "*" = no password but not locked, so SSH key logins work.
sudo usermod -p '*' "$NEW"
echo "$NEW ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/010_pi-nopasswd >/dev/null
sudo chmod 440 /etc/sudoers.d/010_pi-nopasswd
sudo install -d -m 700 -o "$NEW" -g "$NEW" "/home/$NEW/.ssh"
sudo touch "/home/$NEW/.ssh/authorized_keys"
cat "$HOME/.ssh/authorized_keys" | while read -r key; do
  [ -n "$key" ] && ! sudo grep -qxF "$key" "/home/$NEW/.ssh/authorized_keys" && echo "$key" | sudo tee -a "/home/$NEW/.ssh/authorized_keys" >/dev/null
done
sudo chown "$NEW:$NEW" "/home/$NEW/.ssh/authorized_keys"
sudo chmod 600 "/home/$NEW/.ssh/authorized_keys"
id "$NEW"
