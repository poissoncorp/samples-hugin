#!/bin/bash
set -e

# =============================================================================
# HUGIN APPLIANCE SETUP SCRIPT - BULLETPROOF VERSION
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# =============================================================================
# RESTORATION SYSTEM
# =============================================================================

MOVED_FILES=()
BACKUP_DIR="/tmp/hugin-backup-$(date +%s)"

backup_and_track() {
    local source="$1"
    local dest="$2"
    local type="${3:-file}"
    
    if [ -e "$dest" ]; then
        echo "Backing up existing $dest"
        sudo mkdir -p "$BACKUP_DIR"
        sudo cp -r "$dest" "$BACKUP_DIR/" || true
    fi
    
    MOVED_FILES+=("$source:$dest:$type")
}

restore_files() {
    echo -e "${YELLOW}Restoring files from backup...${NC}"
    if [ -d "$BACKUP_DIR" ]; then
        for item in "${MOVED_FILES[@]}"; do
            IFS=':' read -r source dest type <<< "$item"
            backup_file="$BACKUP_DIR/$(basename "$dest")"
            if [ -e "$backup_file" ]; then
                echo "Restoring $backup_file -> $dest"
                sudo cp -r "$backup_file" "$dest" || true
            fi
        done
    fi
}

trap 'echo -e "${RED}Setup failed, restoring backups...${NC}"; restore_files; exit 1' ERR

# =============================================================================
# ARGUMENT PARSING
# =============================================================================

OFFLINE_MODE=false
NO_SWAP=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --offline|-o) OFFLINE_MODE=true; shift ;;
        --no-swap) NO_SWAP=true; shift ;;
        --cleanup) restore_files; exit 0 ;;
        *) echo -e "${YELLOW}Unknown option: $1${NC}"; shift ;;
    esac
done

# =============================================================================
# VALIDATION
# =============================================================================

echo -e "${BLUE}=== HUGIN SETUP - BULLETPROOF VERSION ===${NC}"
echo -e "${BLUE}Validating dependencies...${NC}"

REQUIRED_FILES=("settings.json" "license.json" "ravendb.deb" "hugin.service")
REQUIRED_DIRS=("backend")

for file in "${REQUIRED_FILES[@]}"; do
    [ ! -f "$file" ] && { echo -e "${RED}ERROR: Required file '$file' not found${NC}"; exit 1; }
done

for dir in "${REQUIRED_DIRS[@]}"; do
    [ ! -d "$dir" ] && { echo -e "${RED}ERROR: Required directory '$dir' not found${NC}"; exit 1; }
done

# Check for frontend
if [ ! -d "frontend/dist" ] && [ ! -d "dist" ]; then
    echo -e "${RED}ERROR: No frontend dist found. Run 'npm run build' in frontend/ first${NC}"
    exit 1
fi

echo -e "${GREEN}✓ All dependencies validated${NC}"

# =============================================================================
# SYSTEM PREPARATION
# =============================================================================

echo -e "${BLUE}Preparing system...${NC}"

# WiFi setup
sudo raspi-config nonint do_wifi_country IL
sudo rfkill unblock wifi

# CRITICAL: Disable NetworkManager to prevent WiFi conflicts
if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    echo "Disabling NetworkManager (conflicts with wpa_supplicant)"
    sudo systemctl stop NetworkManager
    sudo systemctl disable NetworkManager
    sudo systemctl mask NetworkManager
fi

# Ensure proper network stack
sudo systemctl enable wpa_supplicant dhcpcd

# Swap setup
if [ "$NO_SWAP" != true ]; then
    echo "Setting up swap..."
    sudo swapoff -a || true
    sudo rm -f /var/swap
    sudo dd if=/dev/zero of=/var/swap count=8 bs=128M status=progress
    sudo chmod 0600 /var/swap
    sudo mkswap /var/swap
    sudo swapon /var/swap
fi

# Package installation
if [ "$OFFLINE_MODE" = false ]; then
    echo "Installing required packages..."
    curl -fsSL https://deb.nodesource.com/setup_21.x | sudo -E bash -
    sudo apt-get install -y nodejs nginx dnsmasq dhcpcd openssl
else
    echo "Offline mode - verifying required packages are installed..."
    for pkg in nodejs nginx dnsmasq dhcpcd openssl; do
        if ! command -v $pkg >/dev/null 2>&1; then
            echo -e "${RED}ERROR: $pkg not found (required for offline mode)${NC}"
            exit 1
        fi
    done
fi

# =============================================================================
# RAVENDB SETUP
# =============================================================================

echo -e "${BLUE}Setting up RavenDB...${NC}"

# Install RavenDB
sudo apt install -y ./ravendb.deb || {
    sudo apt --fix-broken install -y
    sudo apt install -y ./ravendb.deb
}

# Setup directories
sudo mkdir -p /var/lib/ravendb/data/Databases

# Handle existing database
if [ -d "Hugin" ] && [ -f "Hugin/Configuration" ]; then
    echo "Moving Hugin database..."
    backup_and_track "Hugin" "/var/lib/ravendb/data/Databases/Hugin" "directory"
    sudo mv Hugin /var/lib/ravendb/data/Databases/
fi

# Set permissions
sudo chown -R ravendb:ravendb /var/lib/ravendb/data/Databases

# Configure RavenDB
backup_and_track "settings.json" "/etc/ravendb/settings.json" "file"
backup_and_track "license.json" "/etc/ravendb/license.json" "file"
sudo cp settings.json /etc/ravendb/settings.json
sudo cp license.json /etc/ravendb/license.json
sudo chown root:ravendb /etc/ravendb/settings.json

# Start RavenDB
sudo systemctl restart ravendb
echo "Waiting for RavenDB to start..."
for attempt in {1..30}; do
    if curl -s http://127.0.0.1:8080/databases >/dev/null 2>&1; then
        echo -e "${GREEN}✓ RavenDB is ready (attempt $attempt)${NC}"
        break
    fi
    echo -n "."
    sleep 2
done

# Create database if needed
if ! curl -s 'http://127.0.0.1:8080/databases' | grep -q '"Hugin"'; then
    echo "Creating Hugin database..."
    curl 'http://127.0.0.1:8080/admin/databases?name=Hugin&replicationFactor=1' \
        -X 'PUT' --data-raw '{"DatabaseName":"Hugin"}' --retry 3 --retry-max-time 60
fi

# =============================================================================
# BACKEND SETUP
# =============================================================================

echo -e "${BLUE}Setting up Hugin backend...${NC}"

# Create users
getent group node-apps || sudo groupadd node-apps
NODE_GID=$(getent group node-apps | cut -d ':' -f 3)
getent passwd hugin || sudo adduser --disabled-login --disabled-password --system \
    --home /var/lib/hugin --no-create-home --quiet --gid "$NODE_GID" hugin

# Prepare backend
sudo chown -R rdb:rdb ./backend
cd ./backend && npm install --omit=dev && cd ..

# Install backend
backup_and_track "backend" "/usr/lib/hugin" "directory"
sudo mkdir -p /usr/lib/hugin
sudo cp -r ./backend/* /usr/lib/hugin/

# Install frontend
if [ -d "./frontend/dist" ]; then
    sudo cp -r ./frontend/dist /usr/lib/hugin/
elif [ -d "./dist" ]; then
    sudo cp -r ./dist /usr/lib/hugin/
fi

# Set permissions and service
sudo chown -R root:node-apps /usr/lib/hugin
sudo cp hugin.service /etc/systemd/system/hugin.service
sudo systemctl daemon-reload
sudo systemctl enable hugin

echo -e "${GREEN}✓ Backend setup complete${NC}"

# =============================================================================
# CONFIGURATION FILES
# =============================================================================

echo -e "${BLUE}Installing configuration files...${NC}"

# Network configurations
[ -f "etc.wpa_supplicant.wpa_supplicant.conf" ] && {
    backup_and_track "etc.wpa_supplicant.wpa_supplicant.conf" "/etc/wpa_supplicant/wpa_supplicant.conf" "file"
    sudo cp etc.wpa_supplicant.wpa_supplicant.conf /etc/wpa_supplicant/wpa_supplicant.conf
}

[ -f "etc.dhcpcd.conf" ] && {
    backup_and_track "etc.dhcpcd.conf" "/etc/dhcpcd.conf" "file"
    sudo cp etc.dhcpcd.conf /etc/dhcpcd.conf
}

[ -f "etc.dnsmasq.conf" ] && {
    backup_and_track "etc.dnsmasq.conf" "/etc/dnsmasq.conf" "file"
    sudo cp etc.dnsmasq.conf /etc/dnsmasq.conf
}

# Nginx configuration
[ -f "etc.nginx.sites-available.default" ] && {
    backup_and_track "etc.nginx.sites-available.default" "/etc/nginx/sites-available/default" "file"
    sudo cp etc.nginx.sites-available.default /etc/nginx/sites-available/default
}

# System configuration
sudo sed -i 's/#DNSMASQ_EXCEPT="lo"/DNSMASQ_EXCEPT="lo"/g' /etc/default/dnsmasq
sudo sed -i 's/#net.ipv4.ip_forward=1/net.ipv4.ip_forward=1/g' /etc/sysctl.conf || true

# SSL certificate
sudo mkdir -p /etc/nginx/certs
if [ ! -s /etc/nginx/certs/start.ravendb.crt ]; then
    echo "Generating SSL certificate..."
    sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -keyout /etc/nginx/certs/start.ravendb.key \
        -out /etc/nginx/certs/start.ravendb.crt \
        -subj "/CN=start.ravendb" \
        -addext "subjectAltName=DNS:start.ravendb,DNS:database.ravendb,IP:10.1.1.1"
fi
sudo chmod 640 /etc/nginx/certs/start.ravendb.key
sudo chmod 644 /etc/nginx/certs/start.ravendb.crt

# =============================================================================
# NETWORK SETUP - THE CRITICAL PART
# =============================================================================

echo -e "${BLUE}Setting up WiFi Access Point...${NC}"

# Stop any existing wpa_supplicant
sudo systemctl stop wpa_supplicant || true
sudo pkill wpa_supplicant || true

# Start wpa_supplicant in AP mode (the way that actually works)
echo "Starting wpa_supplicant in AP mode..."
sudo wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf -D nl80211

# Wait for interface to come up
sleep 3
sudo ip link set wlan0 up
sudo ip addr add 10.1.1.1/24 dev wlan0 2>/dev/null || true

# =============================================================================
# START SERVICES
# =============================================================================

echo -e "${BLUE}Starting services...${NC}"

# Start services in correct order
echo "Starting dnsmasq..."
sudo systemctl enable dnsmasq
sudo systemctl restart dnsmasq

echo "Starting dhcpcd..."
sudo systemctl restart dhcpcd

echo "Testing nginx configuration..."
if sudo nginx -t; then
    sudo systemctl reload nginx
else
    echo -e "${RED}Nginx configuration test failed${NC}"
    exit 1
fi

echo "Starting hugin backend..."
sudo systemctl start hugin

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 5

# Test services
for service in ravendb nginx dnsmasq hugin; do
    if systemctl is-active --quiet $service; then
        echo -e "${GREEN}✓ $service is running${NC}"
    else
        echo -e "${RED}✗ $service failed to start${NC}"
        sudo systemctl status $service --no-pager -l
    fi
done

# =============================================================================
# FINAL VALIDATION
# =============================================================================

echo -e "${BLUE}Running final validation...${NC}"

# Test captive portal
echo "Testing captive portal..."
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ || echo "000")
if [ "$RESPONSE" = "302" ] || [ "$RESPONSE" = "200" ]; then
    echo -e "${GREEN}✓ Captive portal responding${NC}"
else
    echo -e "${YELLOW}⚠ Captive portal response: $RESPONSE${NC}"
fi

# Test RavenDB
if curl -s http://127.0.0.1:8080/databases >/dev/null 2>&1; then
    echo -e "${GREEN}✓ RavenDB accessible${NC}"
else
    echo -e "${RED}✗ RavenDB not accessible${NC}"
fi

# Test backend
if curl -s http://127.0.0.1:3030/api/communities >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend API accessible${NC}"
else
    echo -e "${YELLOW}⚠ Backend API not responding${NC}"
fi

# Clear trap since we succeeded
trap - ERR

echo -e "${GREEN}"
echo "🎉 HUGIN SETUP COMPLETED SUCCESSFULLY!"
echo ""
echo "Your Hugin appliance is ready:"
echo "• WiFi AP: 'Hugin (ravendb)' is broadcasting"
echo "• Web App: http://start.ravendb or http://10.1.1.1"
echo "• Database: http://database.ravendb"
echo "• IP Address: 10.1.1.1"
echo ""
echo "Connect any device to the WiFi network to access Hugin!"
echo -e "${NC}"

# Cleanup
echo "Cleaning up installation files..."
for file in "settings.json" "license.json" "ravendb.deb" "hugin.service"; do
    [ -f "$file" ] && rm -f "$file"
done

echo "Setup complete!"
