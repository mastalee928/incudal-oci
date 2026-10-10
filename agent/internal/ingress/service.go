package ingress

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
)

var serviceMutex sync.Mutex
var serviceReady bool
var executablePattern = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)

// Binary-only Agent upgrades also install the boot restoration unit. Otherwise
// existing hosts would only regain their UDP restriction after Agent startup.
func ensureRestoreService(ctx context.Context) error {
	serviceMutex.Lock()
	defer serviceMutex.Unlock()
	if serviceReady {
		return nil
	}
	binary, err := os.Executable()
	if err != nil || !executablePattern.MatchString(binary) {
		return fmt.Errorf("invalid agent executable path for restore service")
	}
	var path, content string
	var mode os.FileMode
	openRC := false
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		path = "/etc/systemd/system/incudal-port-protocol.service"
		mode = 0644
		content = "[Unit]\nDescription=Restore Incudal public ingress protocol\nDefaultDependencies=no\nAfter=local-fs.target nftables.service\nBefore=network-pre.target incus.service incus.socket\nWants=network-pre.target\n\n[Service]\nType=oneshot\nExecStart=" + binary + " -restore-port-protocol\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n"
	} else if _, err := exec.LookPath("rc-update"); err == nil {
		openRC = true
		path = "/etc/init.d/incudal-port-protocol"
		mode = 0755
		content = "#!/sbin/openrc-run\ndescription=\"Restore Incudal public ingress protocol\"\ndepend() {\n  need localmount\n  after firewall nftables\n  before incus incusd incudal-agent\n}\nstart() {\n  ebegin \"Restoring Incudal ingress protocol\"\n  " + binary + " -restore-port-protocol\n  eend $?\n}\n"
	} else {
		return fmt.Errorf("ingress restoration requires systemd or OpenRC")
	}
	current, readErr := os.ReadFile(path)
	changed := readErr != nil || string(current) != content
	if changed {
		file, err := os.CreateTemp(filepath.Dir(path), ".incudal-port-protocol-")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err := file.WriteString(content); err != nil {
			file.Close()
			return err
		}
		if err := file.Chmod(mode); err != nil {
			file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		if err := os.Rename(file.Name(), path); err != nil {
			return err
		}
	}
	if openRC {
		err = exec.CommandContext(ctx, "rc-update", "add", "incudal-port-protocol", "boot").Run()
	} else {
		if changed {
			if err := exec.CommandContext(ctx, "systemctl", "daemon-reload").Run(); err != nil {
				return fmt.Errorf("reload ingress restore service: %w", err)
			}
		}
		err = exec.CommandContext(ctx, "systemctl", "enable", "incudal-port-protocol.service").Run()
	}
	if err != nil {
		return fmt.Errorf("enable ingress restore service: %w", err)
	}
	serviceReady = true
	return nil
}
