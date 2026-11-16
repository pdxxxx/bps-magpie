package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestLegacyHostCanFinishDuringProtocolUpgrade(t *testing.T) {
	first, _ := json.Marshal(map[string]any{"raw": []byte(`{"model":"gpt-6-astra","input":"hello"}`)})
	input := append(first, []byte("\n"+`event: response.completed
data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}

`)...)
	var output bytes.Buffer
	if err := run(bufio.NewReader(bytes.NewReader(input)), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"protocol":2`) || !strings.Contains(output.String(), "event: response.completed") {
		t.Fatal("legacy framing changed during update")
	}
}

func TestFramedInputStopsExactlyAtEachUpstreamBoundary(t *testing.T) {
	var buffer bytes.Buffer
	enc := json.NewEncoder(&buffer)
	for _, frame := range []any{map[string]any{"data": []byte("first")}, map[string]any{"end": true}, map[string]any{"data": []byte("second")}, map[string]any{"end": true}} {
		if err := enc.Encode(frame); err != nil {
			t.Fatal(err)
		}
	}
	in := bufio.NewReader(&buffer)
	for _, want := range []string{"first", "second"} {
		got, err := io.ReadAll(&framedInput{in: in})
		if err != nil || string(got) != want {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
	}
}
