package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCompactRequestPreservesNumbersAndDisablesNewTools(t *testing.T) {
	raw := []byte("{\"model\":\"test\",\"input\":[{\"type\":\"function_call\",\"name\":\"test\",\"arguments\":{\"n\":9007199254740993}}],\"tool_choice\":\"auto\"}")
	out, err := compactRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"9007199254740993", "\"tool_choice\":\"none\"", "\"compaction_trigger\""} {
		if !bytes.Contains(out, []byte(want)) {
			t.Fatalf("missing %s in %s", want, out)
		}
	}
	again, err := compactRequest(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(again), "compaction_trigger") != 1 {
		t.Fatal("duplicate trigger")
	}
}

func TestCompactRequestRejectsMissingAndTrailingInput(t *testing.T) {
	for _, raw := range []string{"{}", "null", "{\"input\":[]}", "{\"input\":1}", "{\"input\":\"x\"} {}"} {
		if _, err := compactRequest([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
