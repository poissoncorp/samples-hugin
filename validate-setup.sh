#!/bin/bash
# Hugin Setup Validation Script
# Tests all critical components of the captive portal appliance

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Validation log file
VALIDATION_LOG="/var/log/hugin-validation.log"

echo -e "${BLUE}=== Hugin Setup Validation - $(date) ===${NC}"
echo "=== Hugin Setup Validation - $(date) ===" > $VALIDATION_LOG

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
CRITICAL_FAILURES=0
WARNINGS=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_code="$3"
    local is_critical="$4"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -e "${BLUE}Testing $test_name...${NC}"
    
    local actual_code=$(eval "$test_command" || echo "000")
    echo "$test_name: $actual_code" >> $VALIDATION_LOG
    
    if [ "$actual_code" = "$expected_code" ]; then
        echo -e "${GREEN}✓ $test_name working${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        if [ "$is_critical" = "true" ]; then
            echo -e "${RED}✗ $test_name failed (expected $expected_code, got $actual_code)${NC}"
            echo "ERROR: $test_name failed" >> $VALIDATION_LOG
            CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
        else
            echo -e "${YELLOW}⚠ $test_name issue (expected $expected_code, got $actual_code)${NC}"
            echo "WARNING: $test_name issue" >> $VALIDATION_LOG
            WARNINGS=$((WARNINGS + 1))
        fi
        return 1
    fi
}

# Test 1: RavenDB is running
run_test "RavenDB" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/" "200" "true"

# Test 2: Hugin backend is running
run_test "Hugin Backend" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3030/api/communities" "200" "true"

# Test 3: Captive portal auto-accept mechanism
echo -e "${BLUE}Testing captive portal auto-accept...${NC}"
echo "Captive portal auto-accept test:" >> $VALIDATION_LOG

# First request should be 302 (redirect)
FIRST_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://connectivitycheck.gstatic.com/generate_204)
echo "First request (should be 302): $FIRST_CODE" >> $VALIDATION_LOG

# Second request should be 204 (accepted)
SECOND_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://connectivitycheck.gstatic.com/generate_204)
echo "Second request (should be 204): $SECOND_CODE" >> $VALIDATION_LOG

if [ "$FIRST_CODE" = "302" ] && [ "$SECOND_CODE" = "204" ]; then
    echo -e "${GREEN}✓ Captive portal auto-accept working correctly${NC}"
    echo "SUCCESS: Captive portal auto-accept working" >> $VALIDATION_LOG
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}✗ Captive portal issue: first=$FIRST_CODE, second=$SECOND_CODE${NC}"
    echo "ERROR: Captive portal not working correctly" >> $VALIDATION_LOG
    CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# Test 4: Apple connectivity probe
run_test "Apple Probe" "curl -s -o /dev/null -w '%{http_code}' http://captive.apple.com/hotspot-detect.html" "200" "false"

# Test 5: Windows connectivity probe
run_test "Windows Probe" "curl -s -o /dev/null -w '%{http_code}' http://www.msftconnecttest.com/connecttest.txt" "200" "false"

# Test 6: Portal access
run_test "Portal Access" "curl -s -o /dev/null -w '%{http_code}' http://start.ravendb/" "200" "true"

# Test 7: Database access
run_test "Database Access" "curl -s -o /dev/null -w '%{http_code}' http://database.ravendb/" "200" "true"

# Test 8: HTTPS (should not refuse connection)
HTTPS_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" https://start.ravendb/ || echo "000")
echo "HTTPS access: $HTTPS_CODE" >> $VALIDATION_LOG

if [ "$HTTPS_CODE" != "000" ]; then
    echo -e "${GREEN}✓ HTTPS responding (self-signed cert warning expected)${NC}"
    echo "SUCCESS: HTTPS responding" >> $VALIDATION_LOG
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠ HTTPS connection refused${NC}"
    echo "WARNING: HTTPS not responding" >> $VALIDATION_LOG
    WARNINGS=$((WARNINGS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# Test 9: DNS resolution
echo -e "${BLUE}Testing DNS resolution...${NC}"
DNS_RESULT=$(nslookup connectivitycheck.gstatic.com 127.0.0.1 2>/dev/null | grep -c "10.1.1.1" || echo "0")
echo "DNS resolution test: $DNS_RESULT" >> $VALIDATION_LOG

if [ "$DNS_RESULT" -gt 0 ]; then
    echo -e "${GREEN}✓ DNS resolution working${NC}"
    echo "SUCCESS: DNS resolution working" >> $VALIDATION_LOG
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠ DNS resolution issue${NC}"
    echo "WARNING: DNS resolution issue" >> $VALIDATION_LOG
    WARNINGS=$((WARNINGS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# Test 10: Services status
echo -e "${BLUE}Checking service status...${NC}"
SERVICES=("ravendb" "nginx" "dnsmasq" "hugin")
for service in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$service"; then
        echo -e "${GREEN}✓ $service service running${NC}"
        echo "SUCCESS: $service service running" >> $VALIDATION_LOG
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗ $service service not running${NC}"
        echo "ERROR: $service service not running" >> $VALIDATION_LOG
        CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
    fi
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
done

# Summary
echo "" >> $VALIDATION_LOG
echo "=== Validation Summary ===" >> $VALIDATION_LOG
echo "Total Tests: $TOTAL_TESTS" >> $VALIDATION_LOG
echo "Passed: $PASSED_TESTS" >> $VALIDATION_LOG
echo "Critical Failures: $CRITICAL_FAILURES" >> $VALIDATION_LOG
echo "Warnings: $WARNINGS" >> $VALIDATION_LOG

echo ""
echo -e "${BLUE}=== Validation Summary ===${NC}"
echo -e "Total Tests: ${TOTAL_TESTS}"
echo -e "Passed: ${GREEN}${PASSED_TESTS}${NC}"
echo -e "Critical Failures: ${RED}${CRITICAL_FAILURES}${NC}"
echo -e "Warnings: ${YELLOW}${WARNINGS}${NC}"

if [ $CRITICAL_FAILURES -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 All critical tests passed!${NC}"
    echo -e "${GREEN}✓ Captive portal auto-accept is functional${NC}"
    echo -e "${GREEN}✓ Portal and database are accessible${NC}"
    echo -e "${GREEN}✓ All services are running${NC}"
    echo ""
    echo -e "${BLUE}Validation log: $VALIDATION_LOG${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}⚠️  $CRITICAL_FAILURES critical issues found${NC}"
    echo -e "${YELLOW}Check the validation log: $VALIDATION_LOG${NC}"
    echo -e "${YELLOW}You may need to troubleshoot the failing services${NC}"
    exit 1
fi
