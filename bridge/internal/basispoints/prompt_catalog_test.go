package basispoints

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func catalogPrompt(t *testing.T, wire object) string {
	t.Helper()
	var out strings.Builder
	for _, raw := range wire["input"].([]any) {
		item := raw.(object)
		if item["role"] != "developer" {
			continue
		}
		for _, part := range item["content"].([]any) {
			out.WriteString(text(part.(object)["text"]))
		}
	}
	return out.String()
}

func TestPromptCatalogSelectionPreservesFullContracts(t *testing.T) {
	for _, choice := range []any{"auto", "required", object{"type": "function", "name": "lookup"}, object{"type": "custom", "name": "execute", "namespace": "client"}} {
		source := testSource()
		source["tools"], source["tool_choice"] = choiceTools(), choice
		wire, b := mustPrepare(t, source, "catalog", nil)
		require.Len(t, b.tools, 3)
		prompt := catalogPrompt(t, wire)
		if b.selectedTool == nil {
			require.Equal(t, 3, strings.Count(prompt, "Client tool \""))
		} else {
			require.Equal(t, 1, strings.Count(prompt, "Client tool \""))
			require.Contains(t, prompt, "Client tool "+quoted(b.selectedCatalogName()))
			require.Error(t, b.translateResponse(repairResponse("resp", 1, 1, nativeCall(object{"name": "other", "arguments": object{}}))))
		}
	}
}

func TestPromptSelectionRetainsOtherToolHistory(t *testing.T) {
	source := testSource()
	source["tools"], source["tool_choice"] = choiceTools(), object{"type": "function", "name": "lookup"}
	source["input"] = []any{message("user", "Earlier lookup"), object{"type": "function_call", "call_id": "old", "name": "other", "arguments": "{}"}, object{"type": "function_call_output", "call_id": "old", "output": "old result"}, message("user", "Now call lookup")}
	wire, b := mustPrepare(t, source, "catalog", nil)
	require.Len(t, b.tools, 3)
	require.NotContains(t, catalogPrompt(t, wire), "Client tool \"other\"")
	encoded, _ := json.Marshal(wire["input"])
	require.Contains(t, string(encoded), "old result")
	require.Contains(t, string(encoded), "Replay a previously requested client tool")
	require.NoError(t, b.translateResponse(repairResponse("resp", 1, 1, nativeCall(object{"name": "lookup", "arguments": object{"key": "new"}}))))
}

func TestUnselectedToolsAreStillValidatedAndExamplesAreScoped(t *testing.T) {
	source := testSource()
	source["tools"] = []any{exampleFunction("exec", "code"), exampleFunction("exec_command", "cmd")}
	source["tool_choice"] = object{"type": "function", "name": "exec"}
	wire, b := mustPrepare(t, source, "catalog", nil)
	prompt := catalogPrompt(t, wire)
	require.Len(t, b.tools, 2)
	require.Equal(t, 1, strings.Count(prompt, "Example native run_officejs arguments:"))
	require.NotContains(t, prompt, "codex2api.function_cmd/exec_command")
	source["tools"] = []any{exampleFunction("exec", "code"), object{"type": "function", "name": "other", "parameters": object{"$ref": "https://invalid.example/schema"}}}
	raw, _ := json.Marshal(source)
	_, _, err := Prepare(raw, "catalog", nil)
	require.Error(t, err)
}
