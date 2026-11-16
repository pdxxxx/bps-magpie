package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// The same trigger/tool-choice contract as the upstream gateway forwardExcelBPS. Decode
// numbers losslessly: historical tool values must never pass through float64.
func compactRequest(raw []byte) ([]byte, error) {
	var request map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&request); err != nil || request == nil {
		return nil, errors.New("invalid compact request")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("invalid compact request")
	}
	var input []any
	switch value := request["input"].(type) {
	case string:
		input = []any{map[string]any{"role": "user", "content": value}}
	case []any:
		input = value
	default:
		return nil, errors.New("compact requires complete input history")
	}
	if len(input) == 0 {
		return nil, errors.New("compact requires nonempty input")
	}
	last, _ := input[len(input)-1].(map[string]any)
	if last["type"] != "compaction_trigger" {
		input = append(input, map[string]any{"type": "compaction_trigger"})
	}
	request["input"] = input
	request["tool_choice"] = "none"
	request["stream"] = false
	return json.Marshal(request)
}
