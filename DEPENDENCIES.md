# Hugin Appliance Dependencies

## Required Files (Script fails if missing)
- `settings.json` - RavenDB configuration
- `license.json` - RavenDB license
- `ravendb.deb` - RavenDB package
- `hugin.service` - Systemd service file
- `service-utils.sh` - Service polling utilities

## Required Directories (Script fails if missing)
- `backend/` - Node.js backend application

## Optional Files/Directories (Script continues if missing)
- `Hugin/` - RavenDB database directory
- `dist/` - Frontend build output
- `frontend/dist/` - Alternative frontend build location
- `etc.wpa_supplicant.wpa_supplicant.conf` - WiFi configuration
- `etc.nginx.sites-available.default` - Nginx configuration
- `etc.dhcpcd.conf` - DHCP client configuration
- `etc.dnsmasq.conf` - DNS/DHCP server configuration
- `validate-setup.sh` - Validation script

## File Operations
- **Copied (preserved)**: `settings.json`, `license.json`, `hugin.service`, config files
- **Moved (tracked for restoration)**: `ravendb.deb`, `backend/`, `dist/`, `Hugin/`

## Restoration
The script tracks all moved files and automatically restores them if the script fails at any point.

