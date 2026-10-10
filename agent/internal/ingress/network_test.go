package ingress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Opt in on a Linux test host with iproute2, nftables, Python and permission to
// create network namespaces. Every packet and rule remains in a fresh namespace.
func TestIngressNetworkNamespaces(t *testing.T) {
	if os.Getenv("INCUDAL_INGRESS_NETNS_TEST") != "1" || runtime.GOOS != "linux" {
		t.Skip("set INCUDAL_INGRESS_NETNS_TEST=1 on a Linux network test host")
	}
	directory := t.TempDir()
	tcpRules, err := Rules("tcp", []string{"incusbr0"}, ProxyListener{Address: "fd42:1::1", Ports: "9000"})
	if err != nil {
		t.Fatal(err)
	}
	bothRules, err := Rules("tcp_udp", nil)
	if err != nil {
		t.Fatal(err)
	}
	tcpPath, bothPath := filepath.Join(directory, "tcp.nft"), filepath.Join(directory, "both.nft")
	if err := os.WriteFile(tcpPath, []byte(tcpRules), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bothPath, []byte(bothRules), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "unshare", "--net", "python3", "../../../scripts/test-ingress-network.py", tcpPath, bothPath)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated ingress probe failed: %v\n%s", err, output)
	}
	t.Log(string(output))
}
