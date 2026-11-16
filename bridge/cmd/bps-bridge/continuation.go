package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
)

func objectFrom(raw []byte) (map[string]any, error) {
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, errors.New("invalid continuation JSON")
	}
	var more any
	if err := decoder.Decode(&more); err != io.EOF {
		return nil, errors.New("invalid continuation JSON")
	}
	return value, nil
}
func inputs(value any, optional bool) ([]any, error) {
	switch value := value.(type) {
	case string:
		return []any{map[string]any{"type": "message", "role": "user", "content": value}}, nil
	case []any:
		return value, nil
	case nil:
		if optional {
			return []any{}, nil
		}
	}
	return nil, errors.New("continuation input must be text or an item array")
}
func expandContinuation(raw, previous, terminal []byte) ([]byte, error) {
	source, err := objectFrom(raw)
	if err != nil {
		return nil, err
	}
	id, _ := source["previous_response_id"].(string)
	if id == "" {
		if len(previous) != 0 || len(terminal) != 0 {
			return nil, errors.New("unexpected prior response state")
		}
		return raw, nil
	}
	if len(previous) == 0 || len(terminal) == 0 {
		return nil, errors.New("previous response is unavailable; send complete history")
	}
	before, err := objectFrom(previous)
	if err != nil {
		return nil, err
	}
	event, err := objectFrom(terminal)
	if err != nil {
		return nil, err
	}
	response, _ := event["response"].(map[string]any)
	if event["type"] != "response.completed" || response["status"] != "completed" || response["id"] != id || before["model"] != source["model"] {
		return nil, errors.New("prior response identity or completion mismatch")
	}
	history, err := inputs(before["input"], false)
	if err != nil {
		return nil, err
	}
	output, ok := response["output"].([]any)
	if !ok {
		return nil, errors.New("prior response has no complete output")
	}
	next, err := inputs(source["input"], true)
	if err != nil {
		return nil, err
	}
	source["input"] = append(append(history, output...), next...)
	// Previous request instructions and generation settings are not inherited.
	delete(source, "previous_response_id")
	encoded, err := json.Marshal(source)
	if len(encoded) > 64<<20 {
		return nil, errors.New("expanded continuation exceeds 64 MiB; compact or send a shorter full history")
	}
	return encoded, err
}
func contextSnapshot(raw []byte, compact bool) ([]byte, error) {
	source, err := objectFrom(raw)
	if err != nil {
		return nil, err
	}
	history, err := inputs(source["input"], false)
	if err != nil {
		return nil, err
	}
	// Catalog-control items have already been published through CatalogCache.
	// Replaying them as old history would resurrect tools after explicit [].
	kept := make([]any, 0, len(history))
	for _, item := range history {
		value, _ := item.(map[string]any)
		if value["type"] == "additional_tools" || value["type"] == "tool_search_output" {
			continue
		}
		kept = append(kept, item)
	}
	history = kept
	if compact {
		history = []any{}
	}
	return json.Marshal(map[string]any{"model": source["model"], "input": history})
}

// Reuse the imported adapter's catalog merge/schema rules without a disk or
// network store. The JS caller serializes only preparation for this scope.
type requestCatalog struct {
	scope   string
	raw     []byte
	version uint64
}

func (s *requestCatalog) LoadBPSState(ctx context.Context, scope, key string) ([]byte, uint64, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	if scope != s.scope || key != "catalog" {
		return nil, 0, errors.New("invalid catalog scope")
	}
	return append([]byte(nil), s.raw...), s.version, nil
}
func (s *requestCatalog) SaveBPSState(ctx context.Context, scope, key string, expected *uint64, raw []byte) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if scope != s.scope || key != "catalog" || len(raw) > 1<<20 {
		return false, errors.New("invalid catalog state")
	}
	if expected != nil && *expected != s.version {
		return false, nil
	}
	s.raw = append([]byte(nil), raw...)
	s.version++
	return true, nil
}
