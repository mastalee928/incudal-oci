package ingress

import (
	"strings"
	"testing"
)

func TestTCPOnlyKeepsRepliesAndHostTraffic(t *testing.T) {
	rules, err := Rules("tcp", []string{"incusbr0", "incusbr0", "tenant1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(rules, "counter drop") != 2 {
		t.Fatal(rules)
	}
	if !strings.Contains(rules, `iifname != "incusbr0" oifname "incusbr0" meta l4proto udp ct direction original`) {
		t.Fatal(rules)
	}
	for _, forbidden := range []string{"hook input", "hook output", "ct state established", "flush ruleset"} {
		if strings.Contains(rules, forbidden) {
			t.Fatalf("unexpected %s", forbidden)
		}
	}
}

func TestEnableUDPRemovesOnlyManagedRestriction(t *testing.T) {
	rules, err := Rules("tcp_udp", nil)
	if err != nil || strings.Contains(rules, "drop") || !strings.Contains(rules, table) {
		t.Fatalf("%s: %v", rules, err)
	}
}

func TestRejectInvalidAndUnenforceablePolicy(t *testing.T) {
	for _, tc := range []struct {
		mode    string
		bridges []string
	}{
		{"tcp", nil}, {"udp", []string{"incusbr0"}}, {"tcp", []string{"bad\"; flush ruleset"}},
	} {
		if _, err := Rules(tc.mode, tc.bridges); err == nil {
			t.Fatalf("accepted %+v", tc)
		}
	}
}

func TestUserspaceIPv6UDPProxyIsRestrictedWithoutBlockingHostServices(t *testing.T) {
	listener, err := parseProxyListener("udp:[2001:db8::1]:8080-8082,9090")
	if err != nil {
		t.Fatal(err)
	}
	rules, err := Rules("tcp", []string{"incusbr0"}, listener)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{`ip6 daddr 2001:db8::1 udp dport { 8080-8082, 9090 } ct direction original counter drop`, `iifname "lo" return`, `iifname "incudal-mgmt" return`, `iifname "incusbr0" return`} {
		if !strings.Contains(rules, required) {
			t.Fatalf("missing %q", required)
		}
	}
	for _, invalid := range []string{"udp:[::]:65536", "udp:[::]:90-80", "udp:[::]:80;flush ruleset", "udp:example.test:80"} {
		if _, err := parseProxyListener(invalid); err == nil {
			t.Fatalf("accepted invalid proxy listener %q", invalid)
		}
	}
}
