package protocol

import (
	"testing"

	"incudal-agent/internal/ingress"
)

func TestCanonicalJSONSortsProtocolAcknowledgementFields(t *testing.T) {
	for _, fixture := range []struct {
		status ingress.Status
		want   string
	}{
		{ingress.Status{Mode: "tcp_udp", Revision: 2, Applied: true}, `{"portProtocolStatus":{"applied":true,"mode":"tcp_udp","revision":2}}`},
		{ingress.Status{Mode: "tcp", Revision: 3, Error: "<rule> & failed"}, `{"portProtocolStatus":{"applied":false,"error":"<rule> & failed","mode":"tcp","revision":3}}`},
	} {
		body, err := CanonicalJSON(map[string]any{"portProtocolStatus": fixture.status})
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != fixture.want {
			t.Fatalf("heartbeat acknowledgement differs from server canonical JSON: got %s, want %s", body, fixture.want)
		}
	}
}

func TestCanonicalJSONPreservesIntegerPrecisionDuringNormalization(t *testing.T) {
	body, err := CanonicalJSON(map[string]any{"counter": uint64(18446744073709551615)})
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"counter":18446744073709551615}` {
		t.Fatalf("normalization changed the integer: %s", body)
	}
}

func TestCanonicalJSONIsStableForMapOrder(t *testing.T) {
	bodyA := map[string]any{
		"version": "0.1.0",
		"resources": map[string]any{
			"memory": 1024,
			"cpu":    8,
		},
		"capabilities": []any{"heartbeat", "report"},
	}
	bodyB := map[string]any{
		"capabilities": []any{"heartbeat", "report"},
		"resources": map[string]any{
			"cpu":    8,
			"memory": 1024,
		},
		"version": "0.1.0",
	}

	jsonA, err := CanonicalJSON(bodyA)
	if err != nil {
		t.Fatalf("canonical json A: %v", err)
	}
	jsonB, err := CanonicalJSON(bodyB)
	if err != nil {
		t.Fatalf("canonical json B: %v", err)
	}

	if string(jsonA) != string(jsonB) {
		t.Fatalf("canonical json mismatch:\nA=%s\nB=%s", jsonA, jsonB)
	}
	if BodySHA256(jsonA) != BodySHA256(jsonB) {
		t.Fatalf("body hash mismatch")
	}
}

func TestSignatureChangesWithPath(t *testing.T) {
	secret := "ias_test_secret"
	bodyHash := BodySHA256([]byte(`{"ok":true}`))
	payloadA := SigningPayload("POST", "/api/agent/heartbeat", "1777380000000", "nonce-123456", bodyHash)
	payloadB := SigningPayload("POST", "/api/agent/report", "1777380000000", "nonce-123456", bodyHash)

	if Signature(secret, payloadA) == Signature(secret, payloadB) {
		t.Fatalf("signature should change when request path changes")
	}
}
