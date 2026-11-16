package main

import (
	"bytes"
	"context"
	"testing"
)

func TestContinuationPreservesLargeNumbersAndOnlyHistory(t *testing.T) {
	before := []byte("{\"model\":\"m\",\"input\":[{\"role\":\"user\",\"n\":9007199254740993}],\"instructions\":\"old\"}")
	terminal := []byte("{\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[{\"role\":\"assistant\",\"n\":9007199254740995}]}}")
	out, err := expandContinuation([]byte("{\"model\":\"m\",\"previous_response_id\":\"r\",\"input\":\"next\"}"), before, terminal)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"9007199254740993", "9007199254740995", "next"} {
		if !bytes.Contains(out, []byte(value)) {
			t.Fatal(string(out))
		}
	}
	if bytes.Contains(out, []byte("old")) || bytes.Contains(out, []byte("previous_response_id")) {
		t.Fatal(string(out))
	}
	if _, err = expandContinuation([]byte("{\"model\":\"other\",\"previous_response_id\":\"r\"}"), before, terminal); err == nil {
		t.Fatal("cross-model history accepted")
	}
}
func TestCatalogStoreEnforcesScopeAndRevision(t *testing.T) {
	s := &requestCatalog{scope: "a"}
	ctx := context.Background()
	v := uint64(0)
	if ok, err := s.SaveBPSState(ctx, "a", "catalog", &v, []byte("[]")); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := s.SaveBPSState(ctx, "a", "catalog", &v, []byte("[]")); ok {
		t.Fatal("stale update accepted")
	}
	if _, _, err := s.LoadBPSState(ctx, "b", "catalog"); err == nil {
		t.Fatal("wrong scope accepted")
	}
}
