# Hugin Raspberry Pi Appliance - Technical Context
*Last Updated: 2025-09-16 18:30 BST*

## 🎯 Project Overview

The Hugin Raspberry Pi Appliance is an offline knowledge base system that creates a captive portal WiFi network. When users connect to the "Hugin (ravendb)" WiFi network, they are automatically redirected to the Hugin web application without requiring manual captive portal acceptance.

## 🏗️ Architecture Components

### Core Services Stack
```
User Device → WiFi AP → Captive Portal → Hugin Web App → RavenDB
                ↓
            [nginx] → [dnsmasq] → [hugin backend] → [ravendb]
```

### Component Details

**RavenDB 7.1.2**
- NoSQL database backend
- Runs on port 8080
- Stores knowledge base data
- Management UI at `http://database.ravendb`

**Node.js Backend** (`/usr/lib/hugin/backend/`)
- Express.js API server on port 3030
- Handles API requests from frontend
- Communicates with RavenDB

**React Frontend** (`/usr/lib/hugin/dist/`)
- Built static files served by nginx
- Main application interface
- Accessible at `http://start.ravendb`

**Nginx**
- Web server and reverse proxy
- Handles captive portal logic
- Routes traffic between components
- SSL termination

**DNSmasq**
- DHCP server (10.1.1.2-10.1.1.254)
- DNS resolver (wildcards to 10.1.1.1)
- Essential for captive portal functionality

## 🌐 Network Configuration

**WiFi Access Point**
- SSID: `Hugin (ravendb)`
- Pi IP: `10.1.1.1`
- DHCP Range: `10.1.1.2-10.1.1.254`

**DNS Resolution**
- All domains resolve to `10.1.1.1`
- Enables captive portal detection

**Key URLs**
- `http://start.ravendb` - Main application
- `http://database.ravendb` - RavenDB Studio
- `http://10.1.1.1` - Direct IP access

## 🔄 Captive Portal Flow

1. **Device connects** to "Hugin (ravendb)" WiFi
2. **OS probes** connectivity (Android: `/generate_204`, Apple: `/hotspot-detect.html`, Windows: `/connecttest.txt`)
3. **Nginx returns 302** redirect to `http://start.ravendb`
4. **User visits** start.ravendb, gets `captive_released=1` cookie
5. **Subsequent probes** return 204/200 (success)
6. **OS marks network** as "online" - no manual acceptance needed

## 📁 File Structure

```
/usr/lib/hugin/
├── backend/           # Node.js API server
├── dist/             # React frontend build
/var/lib/ravendb/
├── data/Databases/Hugin/  # Database files
/etc/ravendb/
├── settings.json     # RavenDB configuration
├── license.json      # RavenDB license
/etc/nginx/
├── sites-available/default  # Nginx captive portal config
/etc/
├── dnsmasq.conf      # DHCP/DNS configuration
├── wpa_supplicant/wpa_supplicant.conf  # WiFi AP config
```

## ⚠️ Known Issues & Solutions

### CRITICAL: WiFi Connectivity Loss
**Problem**: Script breaks existing WiFi (wlan0) connectivity
**Cause**: Interfering with wpa_supplicant service
**Solution**: Script now preserves wpa_supplicant and skips wpa_cli reconfigure

### File Restoration Logic
**Problem**: Complex directory moves could fail restoration
**Solution**: Enhanced track_move() with directory type tracking

### Service Dependencies
**Problem**: Services starting before dependencies ready
**Solution**: Added proper error handling and dependency checks

## 🔧 Setup Script Breakdown

### Phase 1: Validation (Lines 100-152)
- Checks required files exist
- Validates dependencies
- Warns about optional components

### Phase 2: System Setup (Lines 157-187)
- WiFi country setup
- Swap file creation
- Package installation (Node.js, nginx, dnsmasq)

### Phase 3: RavenDB Setup (Lines 192-240)
- Install RavenDB .deb package
- Move database files
- Configure settings and license
- Create Hugin database

### Phase 4: Backend Setup (Lines 245-279)
- Create users and groups
- Install Node.js dependencies
- Move backend to /usr/lib/hugin
- Setup systemd service

### Phase 5: System Configuration (Lines 284-320)
- Copy configuration files
- Generate SSL certificates
- Configure services

### Phase 6: Service Startup (Lines 325-378)
- Start services in dependency order
- **PRESERVES existing WiFi connectivity**
- Validates service health

## 🧪 Testing Commands

See the separate testing commands section below.

## 🔄 **LATEST UPDATES (2025-09-16)**

### **✅ CRITICAL FIXES IMPLEMENTED:**

#### **1. WiFi Connectivity Issue - RESOLVED**
**Problem**: Script was breaking wlan0 connectivity by interfering with wpa_supplicant
**Root Cause**:
- NetworkManager conflicts with wpa_supplicant/dhcpcd
- Incorrect wpa_supplicant service startup method
- `wpa_cli -i wlan0 reconfigure` was disrupting existing connections

**Solution Applied**:
- ✅ **Automatic NetworkManager detection and disabling**
- ✅ **Manual wpa_supplicant startup**: `sudo wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf`
- ✅ **Removed all wpa_supplicant interference** from setup script
- ✅ **Preserved existing WiFi connectivity** throughout setup

#### **2. Bulletproof Setup Script Created**
**New File**: `setup-bulletproof.sh`
**Key Features**:
- ✅ **Smart backup system** with timestamped backups
- ✅ **Automatic restoration** on failure via trap mechanism
- ✅ **Comprehensive validation** at each step
- ✅ **NetworkManager conflict prevention**
- ✅ **Proper service dependency management**
- ✅ **Safe re-run capability** with `--cleanup` option

#### **3. Architecture Insights Gained**
**WiFi AP Method**: Following Ayende's approach using wpa_supplicant in AP mode (mode=2) **without hostapd**
**Network Stack**: Traditional Raspberry Pi method (wpa_supplicant + dhcpcd) vs NetworkManager
**Service Dependencies**: RavenDB → Backend → Nginx → dnsmasq (proper startup order)

### **🛠️ CURRENT WORKING METHOD:**

#### **WiFi AP Setup (Proven Working)**:
```bash
# Disable NetworkManager (prevents conflicts)
sudo systemctl stop NetworkManager
sudo systemctl disable NetworkManager
sudo systemctl mask NetworkManager

# Start wpa_supplicant in AP mode
sudo wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# Configure interface
sudo ip link set wlan0 up
sudo ip addr add 10.1.1.1/24 dev wlan0

# Start services
sudo systemctl restart dhcpcd dnsmasq nginx
```

#### **Service Validation (All Must Be Active)**:
- `ravendb.service` - Database backend
- `nginx.service` - Web server and captive portal
- `dnsmasq.service` - DHCP/DNS for captive portal
- `hugin.service` - Node.js API backend

### **📋 FILES CREATED/UPDATED:**

1. **`setup-bulletproof.sh`** - Main setup script with all fixes
2. **`setup-simple.sh`** - Streamlined alternative version
3. **`testing-commands.md`** - Comprehensive debugging guide
4. **`QUICK-TEST.md`** - Emergency reference card
5. **`context.md`** - This technical documentation (updated)

### **🚨 LESSONS LEARNED:**

1. **NetworkManager is the enemy** - Always disable it for Pi appliances
2. **wpa_supplicant systemd service** doesn't work reliably for AP mode
3. **Manual wpa_supplicant startup** is the reliable method
4. **Captive portal works through nginx/dnsmasq** - no need to touch wpa_supplicant
5. **Backup and restore** is essential for smooth development iteration

### **🎯 NEXT STEPS:**

1. **Test the bulletproof setup script** on clean Pi
2. **Validate captive portal flow** end-to-end
3. **Document any remaining edge cases**
4. **Create production deployment guide**

### **🔧 CURRENT STATUS:**
- ✅ **WiFi AP**: Working (Hugin ravendb network broadcasting)
- ✅ **Services**: All running (ravendb, nginx, dnsmasq, hugin)
- ✅ **Frontend**: Working (React app loads, search functional)
- ✅ **Backend**: Working (API responding, database connected)
- ⚠️ **Captive Portal**: Partially working (redirects to Microsoft instead of Hugin)
- 🔄 **Setup Script**: Needs update with working method

## 🎯 **BREAKTHROUGH SESSION (2025-09-16 19:00)**

### **✅ SUCCESSFUL RESOLUTION SEQUENCE:**

#### **Step 1: WiFi AP Setup (WORKING METHOD)**
```bash
# Disable NetworkManager (critical!)
sudo systemctl stop NetworkManager
sudo systemctl disable NetworkManager
sudo systemctl mask NetworkManager

# Start wpa_supplicant manually (the method that actually works)
sudo wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# Configure interface manually
sudo ip link set wlan0 up
sudo ip addr add 10.1.1.1/24 dev wlan0

# Start supporting services
sudo systemctl restart dhcpcd dnsmasq nginx
```

#### **Step 2: Frontend Resolution**
**Problem**: Frontend files were in wrong location (`backend/dist` instead of `frontend/dist`)
**Solution**:
```bash
# Move frontend files to correct location
sudo mv backend/dist ./frontend/dist

# Copy to nginx serving directory
sudo cp -r ./frontend/dist/* /usr/lib/hugin/dist/

# Fix permissions (critical for asset loading)
sudo chmod -R 755 /usr/lib/hugin/dist/
sudo find /usr/lib/hugin/dist/ -type f -exec chmod 644 {} \;
```

#### **Step 3: Backend Resolution**
**Problem**: Backend files missing from `/usr/lib/hugin/`
**Solution**:
```bash
# Copy all backend files
sudo cp -r /home/rdb/hugin-newest/backend/* /usr/lib/hugin/

# Set proper ownership
sudo chown -R hugin:node-apps /usr/lib/hugin/

# Start the service
sudo systemctl start hugin
```

### **🔍 TECHNICAL INSIGHTS GAINED:**

#### **WiFi AP Architecture (What Actually Works)**
- **wpa_supplicant in AP mode** (mode=2) without hostapd
- **Manual interface configuration** more reliable than systemd service
- **NetworkManager is poison** - must be completely disabled
- **dhcpcd + dnsmasq** handle DHCP/DNS after interface is up

#### **File Structure Requirements**
```
/usr/lib/hugin/
├── dist/           # Frontend React build (from backend/dist originally!)
│   ├── assets/     # JS/CSS files (need 644 permissions)
│   ├── fonts/
│   ├── img/
│   └── index.html
├── app.js          # Backend Express app
├── server.js       # Backend entry point
├── package.json
└── node_modules/   # Backend dependencies
```

#### **Service Dependencies (Critical Order)**
1. **RavenDB** must start first (`http://127.0.0.1:8080`)
2. **Hugin backend** connects to RavenDB (`port 3030`)
3. **Nginx** proxies frontend and API (`port 80/443`)
4. **dnsmasq** provides DHCP/DNS for captive portal

### **🚨 CAPTIVE PORTAL DEEP DIVE ANALYSIS:**

#### **How It's SUPPOSED to Work (The Theory):**
1. **Device connects** to "Hugin (ravendb)" WiFi
2. **OS probes connectivity** using specific URLs:
   - **Android/Chrome**: `connectivitycheck.gstatic.com/generate_204`
   - **Apple**: `captive.apple.com/hotspot-detect.html`
   - **Windows**: `msftconnecttest.com/connecttest.txt`
3. **dnsmasq resolves ALL domains** to `10.1.1.1` (wildcard DNS)
4. **nginx intercepts probes** and returns `302` redirect to `http://start.ravendb`
5. **User visits start.ravendb**, nginx sets `captive_released=1` cookie
6. **Subsequent probes** see cookie and return `204/200` (success)
7. **OS marks network as "online"** - captive portal dismissed

#### **Current Behavior (What's Actually Happening):**
- Device connects to "Hugin (ravendb)" WiFi ✅
- OS detects captive portal ✅
- **BUT**: Shows `http://www.msftconnecttest.com/redirect` instead of Hugin ❌
- **SHOULD**: Auto-redirect to `http://start.ravendb` ✅

#### **The Captive Portal Architecture (From Code Analysis):**

**nginx Configuration Logic**:
```nginx
# Cookie detection
map $http_cookie $is_released {
    default 0;
    "~*captive_released=1" 1;
}

# Windows probes (THE ISSUE!)
server {
    server_name msftconnecttest.com www.msftconnecttest.com;
    location = /connecttest.txt {
        if ($is_released = 1) { return 200 "Microsoft Connect Test"; }
        return 302 http://start.ravendb;  # ← This should redirect!
    }
}

# Default catch-all (sets the cookie)
server {
    server_name _;
    location / {
        if ($is_released = 1) { return 204; }
        add_header Set-Cookie "captive_released=1; Path=/; Max-Age=86400; SameSite=Lax" always;
        return 302 http://start.ravendb;  # ← This should redirect!
    }
}
```

**dnsmasq DNS Wildcarding**:
```
address=/#/10.1.1.1  # ALL domains → 10.1.1.1
address=/msftconnecttest.com/10.1.1.1  # Explicit Windows domains
```

#### **Root Cause Analysis:**
1. **DNS Resolution Working**: dnsmasq correctly resolves domains to `10.1.1.1`
2. **nginx Logic Correct**: Configuration should redirect Windows probes
3. **Cookie Mechanism Sound**: Sets `captive_released=1` on first visit
4. **BUT**: Something is bypassing the nginx redirect logic

#### **Suspected Issues:**
1. **DNS Resolution Timing**: `database.ravendb` returns `000` (connection timeout)
2. **nginx Server Block Priority**: Default server might not be catching requests
3. **Cookie Domain/Path Issues**: Cookie might not be set correctly
4. **Windows Probe Behavior**: Microsoft might be doing something unexpected

#### **The "1 Second Better UX" Problem:**
- **Goal**: Auto-open Hugin page when connecting to WiFi (no manual intervention)
- **Reality**: Captive portal is **THE ONLY WAY** to achieve this on modern devices
- **Frustration Level**: Maximum (but worth it for seamless UX!)

#### **No Alternative Methods Found:**
- ✅ **Captive Portal**: Only reliable cross-platform method
- ❌ **mDNS/Bonjour**: Requires user to manually navigate
- ❌ **DHCP Options**: Limited browser support
- ❌ **Custom Apps**: Defeats the purpose of "plug & play"

### **🎯 SUCCESS METRICS ACHIEVED:**
- ✅ **WiFi AP broadcasting** and accepting connections
- ✅ **Frontend loads** with all assets (JS/CSS working)
- ✅ **Backend API responding** (`/api/communities` returns data)
- ✅ **Search functionality** working in React app
- ✅ **RavenDB accessible** at `10.1.1.1:8080`
- ✅ **No more "undefined" alerts**
- ⚠️ **Captive portal UX** needs final debugging

## 🔍 **NEXT DEBUGGING STEPS FOR CAPTIVE PORTAL:**

### **Immediate Diagnostics Needed:**
```bash
# 1. Check nginx probe logs (the smoking gun!)
sudo tail -f /var/log/nginx/probe.access.log

# 2. Test Windows probe directly
curl -v http://msftconnecttest.com/connecttest.txt

# 3. Check DNS resolution timing
time nslookup msftconnecttest.com 127.0.0.1

# 4. Test cookie mechanism
curl -v http://10.1.1.1/ 2>&1 | grep -i cookie
curl -v -H "Cookie: captive_released=1" http://msftconnecttest.com/connecttest.txt

# 5. Check nginx server block matching
curl -H "Host: msftconnecttest.com" http://10.1.1.1/connecttest.txt
```

### **Expected vs Actual Behavior:**
- **Expected**: `curl http://msftconnecttest.com/connecttest.txt` → `302` redirect to `start.ravendb`
- **Actual**: Device shows `www.msftconnecttest.com/redirect` page
- **Root Cause**: nginx redirect not working OR DNS not resolving properly

### **The Ultimate Test:**
Once fixed, the complete flow should be:
1. Connect to "Hugin (ravendb)" WiFi
2. Windows shows captive portal notification
3. **Automatically opens** `http://start.ravendb` (Hugin app)
4. User sees Hugin immediately - **ZERO manual steps!**

This is the "1 second better UX" we're fighting for! 🚀
