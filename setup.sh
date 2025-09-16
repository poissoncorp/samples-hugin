#!/bin/bash
set -x
set -e

# Error handling function
handle_error() {
    echo "ERROR: Script failed at line $1"
    echo "Restoring Hugin database if it was moved..."
    if [ -d "/var/lib/ravendb/data/Databases/Hugin" ]; then
        sudo mv /var/lib/ravendb/data/Databases/Hugin . || true
    fi
    exit 1
}

# Source service utilities
if [ -f "./service-utils.sh" ]; then
    source ./service-utils.sh
else
    echo "ERROR: service-utils.sh not found"
    exit 1
fi

# Parse command line arguments (supports multiple flags)
OFFLINE_MODE=false
NO_SWAP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline|-o)
      OFFLINE_MODE=true
      echo "Running in OFFLINE mode - skipping package installation"
      shift
      ;;
    --no-swap)
      NO_SWAP=true
      echo "Skipping swap setup per --no-swap"
      shift
      ;;
    --cleanup)
      shift
      if [ -f "./cleanup.sh" ]; then
        chmod +x ./cleanup.sh
        ./cleanup.sh "$@"
        exit $?
      else
        echo "ERROR: cleanup.sh not found in $(pwd)"
        exit 1
      fi
      ;;
    *)
      echo "Unknown option: $1" || true
      shift
      ;;
  esac
done

# we assume that we have a Raspbian system running
# with a user named rdb 

# Set up error trap
trap 'handle_error $LINENO' ERR

# setup wifi properly
sudo raspi-config nonint do_wifi_country IL
sudo rfkill unblock wifi

# Swap setup (can be skipped with --no-swap)
if [ "$NO_SWAP" != true ]; then
  sudo swapoff -a || true
  sudo rm -f /var/swap
  sudo dd if=/dev/zero of=/var/swap count=8 bs=128M
  sudo chmod 0600 /var/swap
  sudo mkswap /var/swap
  sudo swapon /var/swap
fi

# install packages only if not in offline mode
if [ "$OFFLINE_MODE" = false ]; then
    echo "Installing packages from internet..."
    # install node.js from nodesource (raspbian has only node 12)
    curl -fsSL https://deb.nodesource.com/setup_21.x | sudo -E bash - && sudo apt-get install -y nodejs
    
    # install nginx and dnsmasq
    sudo apt-get install -y nginx dnsmasq dhcpcd
else
    echo "Skipping package installation (offline mode)"
    # Check if required packages are installed
    command -v node >/dev/null 2>&1 || { echo "ERROR: node.js not found. Install manually or run without --offline flag."; exit 1; }
    command -v nginx >/dev/null 2>&1 || { echo "ERROR: nginx not found. Install manually or run without --offline flag."; exit 1; }
    command -v dnsmasq >/dev/null 2>&1 || { echo "ERROR: dnsmasq not found. Install manually or run without --offline flag."; exit 1; }
    command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl not found. Install manually or run without --offline flag."; exit 1; }
    command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found. Install manually or run without --offline flag."; exit 1; }
fi

# install RavenDB (local package)
sudo apt install -y ./ravendb.deb || { sudo apt --fix-broken install -y && sudo apt install -y ./ravendb.deb; }
# rm -f ravendb.deb || true

sudo mkdir -p /var/lib/ravendb/data/Databases

# Check for required configuration files first
if [ ! -f "settings.json" ]; then
    echo "ERROR: settings.json not found in $(pwd)"
    echo "Please ensure settings.json is in the working directory"
    exit 1
fi

if [ ! -f "license.json" ]; then
    echo "ERROR: license.json not found in $(pwd)"
    echo "Please ensure license.json is in the working directory"
    exit 1
fi

# Handle Hugin database directory with proper structure checking
if [ -d "Hugin" ] && [ -f "Hugin/Configuration" ]; then
    echo "Moving Hugin database (will restore if script fails)..."
    sudo mv Hugin /var/lib/ravendb/data/Databases
    # Set trap only after successful move
    trap 'echo "Script failed, restoring Hugin database..."; sudo mv /var/lib/ravendb/data/Databases/Hugin . || true' EXIT
elif [ -d "Hugin/Hugin" ]; then
    echo "Fixing nested Hugin directory structure..."
    sudo mv Hugin/Hugin/* Hugin/ 2>/dev/null || true
    sudo rmdir Hugin/Hugin 2>/dev/null || true
    sudo mv Hugin /var/lib/ravendb/data/Databases
    trap 'echo "Script failed, restoring Hugin database..."; sudo mv /var/lib/ravendb/data/Databases/Hugin . || true' EXIT
else
    echo "ERROR: Hugin directory not found or invalid structure in $(pwd)"
    echo "Available files:"
    ls -la
    exit 1
fi

sudo chown --recursive ravendb:ravendb /var/lib/ravendb/data/Databases

# Copy config files (they're small, so cp is fine)
sudo cp settings.json /etc/ravendb/settings.json
sudo cp license.json /etc/ravendb/license.json
sudo chown root:ravendb /etc/ravendb/settings.json
sudo systemctl restart ravendb

# Clear the database restore trap after successful config operations
trap - EXIT

# Wait for RavenDB to be ready with proper polling
wait_for_http "RavenDB" "http://127.0.0.1:8080/databases" "200" 60

# setup the web app users
getent group node-apps || sudo groupadd node-apps
NODE_GID=$(getent group node-apps | cut -d ':' -f 3)
getent passwd hugin || sudo adduser --disabled-login --disabled-password --system \
  --home /var/lib/hugin --no-create-home --quiet --gid "$NODE_GID" hugin

# Fix permissions before npm install
sudo chown -R rdb:rdb /home/rdb/backend
cd /home/rdb/backend
npm install --omit=dev || true
cd /home/rdb
sudo mv ./backend /usr/lib/hugin
sudo mv ./dist /usr/lib/hugin/dist
sudo chown --recursive root:node-apps /usr/lib/hugin
sudo mv hugin.service /etc/systemd/system/hugin.service
sudo systemctl enable hugin

# create database
echo "Creating Hugin database..."
curl 'http://127.0.0.1:8080/admin/databases?name=Hugin&replicationFactor=1' \
  -X 'PUT' --data-raw '{"DatabaseName":"Hugin"}' --retry 5 --retry-max-time 120 \
  || true # we ignore this error, as it might be that the database already exists

# configuration of the system
echo "Configuring system services..."
sudo mv etc.wpa_supplicant.wpa_supplicant.conf /etc/wpa_supplicant/wpa_supplicant.conf
sudo mv etc.nginx.sites-available.default /etc/nginx/sites-available/default
sudo mv etc.dhcpcd.conf /etc/dhcpcd.conf
sudo mv etc.dnsmasq.conf /etc/dnsmasq.conf

sudo sed -i 's/#DNSMASQ_EXCEPT="lo"/DNSMASQ_EXCEPT="lo"/g' /etc/default/dnsmasq
# ensure ipv4 forward sysctl is enabled (handle variant syntaxes)
sudo sed -i 's/#net.ipv4.ip_forward=1/net.ipv4.ip_forward=1/g' /etc/sysctl.conf || true

# generate self-signed cert for TLS to avoid HTTPS refused
echo "Generating SSL certificate..."
sudo mkdir -p /etc/nginx/certs
if [ ! -s /etc/nginx/certs/start.ravendb.crt ]; then
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/certs/start.ravendb.key \
    -out    /etc/nginx/certs/start.ravendb.crt \
    -subj "/CN=start.ravendb" \
    -addext "subjectAltName=DNS:start.ravendb,DNS:database.ravendb,IP:10.1.1.1"
fi
# Ensure key/cert permissions (avoid nginx permission denied)
sudo chown root:root /etc/nginx/certs/start.ravendb.key /etc/nginx/certs/start.ravendb.crt || true
sudo chmod 640 /etc/nginx/certs/start.ravendb.key || true
sudo chmod 644 /etc/nginx/certs/start.ravendb.crt || true

# restart services and prepare...
echo "Starting services..."
sudo systemctl stop wpa_supplicant
sudo systemctl mask wpa_supplicant

sudo systemctl enable dnsmasq
sudo systemctl restart dnsmasq
sudo service dhcpcd restart
sudo wpa_cli -i wlan0 reconfigure
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl start hugin

# Wait for all services to be ready with proper polling
echo "Waiting for all services to be ready..."
wait_for_services_parallel "ravendb" "nginx" "dnsmasq" "hugin"

# Test captive portal auto-accept
wait_for_captive_accept "Captive Portal Auto-Accept"

# Run validation tests
echo "Running validation tests..."
if [ -f "./validate-setup.sh" ]; then
    chmod +x ./validate-setup.sh
    ./validate-setup.sh
    VALIDATION_EXIT_CODE=$?
    
    if [ $VALIDATION_EXIT_CODE -eq 0 ]; then
        # Clear the trap since setup was successful
        trap - EXIT
        echo ""
        echo "🎉 Setup completed successfully!"
        echo "All critical services are working correctly."
    else
        echo ""
        echo "⚠️  Setup completed with issues."
        echo "Check the validation log for details."
        exit 1
    fi
else
    # Clear the trap since setup was successful (validation skipped)
    trap - EXIT
    echo "WARNING: validate-setup.sh not found, skipping validation"
    echo "You can run validation manually: ./validate-setup.sh"
fi

# cleanup
rm ./* -rf  # cleanup directory

echo "Ready ..."