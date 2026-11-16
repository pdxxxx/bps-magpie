package basispoints

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInvocationHintsRespectToolChoice(t *testing.T) {
	for _, choice := range []any{"auto", "none", "required", object{"type": "function", "name": "lookup"}} {
		source := testSource()
		source["tools"], source["tool_choice"] = choiceTools(), choice
		wire, b := mustPrepare(t, source, "hints", nil)
		encoded, _ := json.Marshal(wire)
		prompt := string(encoded)
		require.NotContains(t, prompt, "Invoke native run_officejs once.")
		if choice == "auto" {
			require.Contains(t, prompt, "only when a client tool is necessary")
			require.NoError(t, b.translateResponse(repairResponse("resp", 1, 1)))
		} else if choice == "none" {
			require.NotContains(t, prompt, "Client tool catalog")
		} else {
			require.NotContains(t, prompt, "otherwise answer directly")
			require.ErrorContains(t, b.translateResponse(repairResponse("resp", 1, 1)), "missing_call")
		}
	}
}

func TestNativeTransportReferencesMeetStrictUpstreamContract(t *testing.T) {
	// The live native schema requires at least one string even though its
	// human description calls this field optional.
	source := testSource()
	source["tools"] = []any{exampleFunction("exec", "code"), exampleFunction("exec_command", "cmd"), exampleFunction("lookup", "key"), object{"type": "custom", "name": "apply_patch"}}
	wire, b := mustPrepare(t, source, "references", nil)
	encoded, _ := json.Marshal(wire)
	require.NotContains(t, string(encoded), "references=[]")
	require.Contains(t, string(encoded), "requires at least one string")
	for _, item := range []object{
		{"type": "function_call", "call_id": "plain", "name": "lookup", "arguments": `{"key":"x"}`},
		{"type": "function_call", "call_id": "code", "name": "exec", "arguments": `{"code":"text(1)"}`},
		{"type": "function_call", "call_id": "cmd", "name": "exec_command", "arguments": `{"cmd":"echo probe"}`},
		{"type": "custom_tool_call", "call_id": "custom", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
	} {
		native, err := b.rebuildNativeHistoryCall(item)
		require.NoError(t, err)
		var args object
		require.NoError(t, decode([]byte(text(native["arguments"])), &args))
		require.Equal(t, []any{item["name"]}, args["references"])
	}
}
