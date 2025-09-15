#!/bin/bash
# Service readiness polling utilities
# Source this file in other scripts: source ./service-utils.sh

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Service readiness polling function
wait_for_service() {
    local service_name="$1"
    local check_command="$2"
    local timeout="${3:-60}"
    local interval=2
    
    echo -e "${BLUE}Waiting for $service_name to be ready (timeout: ${timeout}s)...${NC}"
    
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        if eval "$check_command" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ $service_name is ready (took ${elapsed}s)${NC}"
            return 0
        fi
        
        echo -n "."
        sleep $interval
        elapsed=$((elapsed + interval))
    done
    
    echo ""
    echo -e "${RED}✗ $service_name failed to become ready within ${timeout}s${NC}"
    echo -e "${YELLOW}Last check command: $check_command${NC}"
    return 1
}

# Wait for HTTP service to respond with specific status code
wait_for_http() {
    local service_name="$1"
    local url="$2"
    local expected_code="${3:-200}"
    local timeout="${4:-60}"
    
    local check_cmd="curl -s -o /dev/null -w '%{http_code}' '$url' | grep -q '$expected_code'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for DNS resolution to work
wait_for_dns() {
    local service_name="$1"
    local hostname="$2"
    local expected_ip="${3:-10.1.1.1}"
    local timeout="${4:-30}"
    
    local check_cmd="nslookup '$hostname' 127.0.0.1 | grep -q '$expected_ip'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for systemd service to be active
wait_for_systemd_service() {
    local service_name="$1"
    local timeout="${2:-30}"
    
    local check_cmd="systemctl is-active --quiet '$service_name'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for port to be listening
wait_for_port() {
    local service_name="$1"
    local port="$2"
    local timeout="${3:-30}"
    
    local check_cmd="netstat -tln | grep -q ':$port '"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for file to exist
wait_for_file() {
    local service_name="$1"
    local file_path="$2"
    local timeout="${3:-30}"
    
    local check_cmd="test -f '$file_path'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for captive portal to be working (302 redirect)
wait_for_captive_portal() {
    local service_name="$1"
    local test_url="${2:-http://connectivitycheck.gstatic.com/generate_204}"
    local timeout="${3:-30}"
    
    local check_cmd="curl -s -o /dev/null -w '%{http_code}' '$test_url' | grep -q '302'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for captive portal auto-accept to work (204 after 302)
wait_for_captive_accept() {
    local service_name="$1"
    local test_url="${2:-http://connectivitycheck.gstatic.com/generate_204}"
    local timeout="${3:-30}"
    
    echo -e "${BLUE}Testing captive portal auto-accept...${NC}"
    
    # First request should be 302
    local first_code=$(curl -s -o /dev/null -w "%{http_code}" "$test_url")
    if [ "$first_code" != "302" ]; then
        echo -e "${RED}✗ First request should be 302, got $first_code${NC}"
        return 1
    fi
    
    # Second request should be 204 (accepted)
    local check_cmd="curl -s -o /dev/null -w '%{http_code}' '$test_url' | grep -q '204'"
    wait_for_service "$service_name" "$check_cmd" "$timeout"
}

# Wait for multiple services in parallel
wait_for_services_parallel() {
    local services=("$@")
    local pids=()
    local results=()
    
    echo -e "${BLUE}Starting parallel service checks...${NC}"
    
    # Start all service checks in background
    for service in "${services[@]}"; do
        (
            case "$service" in
                "ravendb")
                    wait_for_http "RavenDB" "http://127.0.0.1:8080/databases" "200" 60
                    ;;
                "nginx")
                    wait_for_http "Nginx" "http://127.0.0.1/" "302" 30
                    ;;
                "dnsmasq")
                    wait_for_dns "Dnsmasq" "connectivitycheck.gstatic.com" "10.1.1.1" 30
                    ;;
                "hugin")
                    wait_for_http "Hugin Backend" "http://127.0.0.1:3030/api/communities" "200" 30
                    ;;
                *)
                    echo -e "${YELLOW}Unknown service: $service${NC}"
                    ;;
            esac
        ) &
        pids+=($!)
    done
    
    # Wait for all background processes
    local success=0
    for i in "${!pids[@]}"; do
        wait "${pids[$i]}"
        if [ $? -eq 0 ]; then
            results+=("✓")
        else
            results+=("✗")
            success=1
        fi
    done
    
    # Print results
    echo ""
    for i in "${!services[@]}"; do
        echo -e "${results[$i]} ${services[$i]}"
    done
    
    return $success
}

# Health check function
check_service_health() {
    local service_name="$1"
    local check_command="$2"
    
    if eval "$check_command" >/dev/null 2>&1; then
        echo -e "${GREEN}✓ $service_name is healthy${NC}"
        return 0
    else
        echo -e "${RED}✗ $service_name is unhealthy${NC}"
        return 1
    fi
}
