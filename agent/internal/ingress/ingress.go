// Package ingress controls public UDP ingress without blocking UDP replies,
// host DNS/DHCP, or the host management connection.
package ingress

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const statePath = "/var/lib/incudal-agent/port-protocol.nft"
const table = "incudal_ingress_protocol"

var interfacePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`)

type Instruction struct {
	Mode     string `json:"mode"`
	Revision int    `json:"revision"`
}

type Status struct {
	Mode     string `json:"mode"`
	Revision int    `json:"revision"`
	Applied  bool   `json:"applied"`
	Error    string `json:"error,omitempty"`
}

type ProxyListener struct {
	Address string
	Ports   string
}

func parseProxyListener(listen string) (ProxyListener, error) {
	address, ports, err := net.SplitHostPort(strings.TrimPrefix(listen, "udp:"))
	if err != nil || net.ParseIP(address) == nil {
		return ProxyListener{}, fmt.Errorf("invalid UDP proxy listen address")
	}
	var normalized []string
	for _, part := range strings.Split(ports, ",") {
		rangeParts := strings.Split(part, "-")
		if len(rangeParts) > 2 {
			return ProxyListener{}, fmt.Errorf("invalid UDP proxy port range")
		}
		start, err := strconv.Atoi(rangeParts[0])
		if err != nil || start < 1 || start > 65535 {
			return ProxyListener{}, fmt.Errorf("invalid UDP proxy port")
		}
		end := start
		if len(rangeParts) == 2 {
			end, err = strconv.Atoi(rangeParts[1])
			if err != nil || end < start || end > 65535 {
				return ProxyListener{}, fmt.Errorf("invalid UDP proxy port range")
			}
		}
		value := strconv.Itoa(start)
		if end != start {
			value += "-" + strconv.Itoa(end)
		}
		normalized = append(normalized, value)
	}
	return ProxyListener{Address: net.ParseIP(address).String(), Ports: strings.Join(normalized, ", ")}, nil
}

func Rules(mode string, bridges []string, listeners ...ProxyListener) (string, error) {
	if mode != "tcp" && mode != "tcp_udp" {
		return "", fmt.Errorf("invalid ingress protocol")
	}
	if mode == "tcp" && len(bridges) == 0 {
		return "", fmt.Errorf("no managed Incus bridge found")
	}
	lines := []string{"table inet " + table + " {", " chain forward { type filter hook forward priority -20; policy accept;"}
	seen := map[string]bool{}
	sort.Strings(bridges)
	for _, bridge := range bridges {
		if !interfacePattern.MatchString(bridge) {
			return "", fmt.Errorf("invalid bridge interface")
		}
		if mode == "tcp" && !seen[bridge] {
			// ct direction, rather than ct state, also closes previously established
			// inbound UDP flows while allowing replies to guest-initiated UDP.
			lines = append(lines, fmt.Sprintf(" iifname != %q oifname %q meta l4proto udp ct direction original counter drop", bridge, bridge))
		}
		seen[bridge] = true
	}
	lines = append(lines, " }")
	if mode == "tcp" && len(listeners) > 0 {
		lines = append(lines, " chain proxy_input { type filter hook input priority -20; policy accept;")
		for _, bridge := range append([]string{"lo", "incudal-mgmt"}, bridges...) {
			lines = append(lines, fmt.Sprintf(" iifname %q return", bridge))
		}
		for _, listener := range listeners {
			// Revalidate before interpolating nft input, including callers other
			// than discovery. Only the proxy's actual UDP listener is affected.
			validated, err := parseProxyListener("udp:" + net.JoinHostPort(listener.Address, strings.ReplaceAll(listener.Ports, " ", "")))
			if err != nil {
				return "", err
			}
			family := "ip6"
			if net.ParseIP(validated.Address).To4() != nil {
				family = "ip"
			}
			address := family + " daddr " + validated.Address + " "
			if net.ParseIP(validated.Address).IsUnspecified() {
				address = "meta nfproto " + map[string]string{"ip": "ipv4", "ip6": "ipv6"}[family] + " "
			}
			lines = append(lines, " "+address+"udp dport { "+validated.Ports+" } ct direction original counter drop")
		}
		lines = append(lines, " }")
	}
	return strings.Join(append(lines, "}"), "\n") + "\n", nil
}

func udpProxyListeners(ctx context.Context) ([]ProxyListener, error) {
	output, err := exec.CommandContext(ctx, "incus", "list", "--all-projects", "--format=json").Output()
	if err != nil {
		return nil, fmt.Errorf("inspect Incus UDP proxies: %w", err)
	}
	var instances []struct {
		ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
	}
	if err := json.Unmarshal(output, &instances); err != nil {
		return nil, err
	}
	var listeners []ProxyListener
	for _, instance := range instances {
		for _, device := range instance.ExpandedDevices {
			if device["type"] != "proxy" || device["nat"] == "true" || !strings.HasPrefix(device["listen"], "udp:") {
				continue
			}
			listener, err := parseProxyListener(device["listen"])
			if err != nil {
				return nil, err
			}
			listeners = append(listeners, listener)
		}
	}
	return listeners, nil
}

func managedBridges(ctx context.Context) ([]string, error) {
	output, err := exec.CommandContext(ctx, "incus", "network", "list", "--format=json").Output()
	if err != nil {
		return nil, fmt.Errorf("inspect managed Incus networks: %w", err)
	}
	var networks []struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Managed bool   `json:"managed"`
	}
	if err := json.Unmarshal(output, &networks); err != nil {
		return nil, err
	}
	var bridges []string
	for _, network := range networks {
		if network.Managed && network.Type == "bridge" {
			bridges = append(bridges, network.Name)
		}
	}
	return bridges, nil
}

func replace(ctx context.Context, rules string) error {
	if exec.CommandContext(ctx, "nft", "list", "table", "inet", table).Run() == nil {
		rules = "delete table inet " + table + "\n" + rules
	}
	cmd := exec.CommandContext(ctx, "nft", "-f", "-")
	cmd.Stdin = strings.NewReader(rules)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("apply ingress policy: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func Apply(ctx context.Context, instruction Instruction) Status {
	status := Status{Mode: instruction.Mode, Revision: instruction.Revision}
	if err := apply(ctx, instruction); err != nil {
		status.Error = err.Error()
		return status
	}
	status.Applied = true
	return status
}

func apply(ctx context.Context, instruction Instruction) error {
	if instruction.Revision < 1 {
		return fmt.Errorf("invalid ingress revision")
	}
	var bridges []string
	var listeners []ProxyListener
	if instruction.Mode == "tcp" {
		var err error
		bridges, err = managedBridges(ctx)
		if err != nil {
			return err
		}
		listeners, err = udpProxyListeners(ctx)
		if err != nil {
			return err
		}
	}
	rules, err := Rules(instruction.Mode, bridges, listeners...)
	if err != nil {
		return err
	}
	if err := ensureRestoreService(ctx); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(statePath), ".port-protocol-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.WriteString(rules); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := replace(ctx, rules); err != nil {
		return err
	}
	return os.Rename(file.Name(), statePath)
}

// Restore runs before networking/Incus starts; nft accepts interface names
// before those interfaces exist. A panel outage cannot remove the saved rule.
func Restore(ctx context.Context) error {
	rules, err := os.ReadFile(statePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return replace(ctx, string(rules))
}
