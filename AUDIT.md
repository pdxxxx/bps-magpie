# BPS integration audit

Version 0.4.8.

## Optional WSS transport

The relay is opt-in with a manually entered URL and access token. No deployment
address is compiled into the plugin. Disabled settings preserve the existing
fetch path; enabled settings use a direct WSS connection to the trusted relay.
The relay code is maintained in a separate repository. It does not manage user
accounts, rewrite requests, replay interrupted inference or expose MCP tools.
The client waits for a validated protocol handshake, multiplexes IDs and uses
credit-based streaming. Disconnects fail active requests; reconnect is only for
later callers. Existing local provider limits remain independent of relay limits.

## Provider-only and bounded performance changes

The plugin exports no tool hook and registers zero MCP tools with the agent.
Account listing, reset actions and receipt-management callbacks were removed.
Magpie retains OAuth, model discovery, inference and read-only quota/credit display.
Existing receipt files are not touched.

Selected-tool presentation narrows only prompt material, retaining the complete
internal validation/history catalog. Attachment IDs are cached in the host by
account/workspace and content hash, bounded by capacity, TTL and in-flight work.
Waiter cancellation and cache invalidation do not cancel unrelated active callers.
Explicit prompt routing keys are independent of history identity. Native tool
and instruction echoes are omitted without removing response state or usage.

Concurrency remains four. Process pooling, delayed stream buffering, automatic
artifact splitting and experimental parallel batching are not enabled. The
live experiment ended on an explicit upstream usage-policy refusal affecting
both baseline and candidate, despite a permitted model catalog. See VALIDATION.md.

## Native tool schema and invocation hints

The strict upstream run_officejs schema requires a nonempty references array.
The adapter previously instructed references=[] and generated empty examples.
Captured requests stalled while producing whitespace at that field. Instructions,
examples, raw-code/raw-command wrappers and reconstructed history now use the
client tool name as a reference label. Client execution arguments are unchanged.

Automatic tool use no longer ends with an unconditional instruction to invoke
a tool. Required/selected-tool rules and complete terminal validation remain.
Optional per-request metrics record numeric phases and counts without payloads
or identity. Parallel batching experiments are not included in this release.
See VALIDATION.md for the bounded real-account comparisons and current checks.

## Tool transport correction

The native protocol adapter already had bounded, operation-preserving correction,
but the plugin called Stream without a repair callback. A complete native call
whose raw code lacked its required marker therefore failed immediately. Protocol
3 now separates upstream data, correction requests and stream boundaries, and
connects StreamWithToolRepair to the same authenticated/proxied fetch path.
Protocol 2 remains accepted for hosts already loaded during a local upgrade.

At most two formatting continuations run. Pending tools stay withheld until the
entire batch validates. Existing target names cannot change; original raw code
is restored byte-for-byte; valid operations in a mixed batch remain unchanged.
Correction text is hidden and only the original response's withheld tool slots
are replaced. Usage is summed, including failed correction attempts. Unknown
targets, invalid argument schemas, disabled tools, structured output and incomplete
generations are not eligible. HTTP/network failure is never replayed here.

Real-account acceptance injected one malformed command wrapper into the local
pipeline, then used the real BPS endpoint for correction. One correction completed
in about 5.7 seconds, returned the declared tool, and retained the original command.
The command was inspected, not executed. Eleven regressions cover stream closure,
large patches, mixed boundaries, cancellation, timeouts and rejection paths.

## Output-limit handling

An output-limited response retains response.incomplete, incomplete_details and
reasoning usage. Pending tool items are removed and the response is not cached as
a completed continuation. Tests cover streaming and buffered modes. No guessed
model limit is advertised. The protocol instructs bounded, complete operations
for large artifacts instead of one oversized payload.

An authenticated A/B probe of the same prepared BPS request completed without
max_output_tokens and returned HTTP 422 when max_output_tokens=1024 was added.
There is no verified mechanism here to override BPS's output ceiling. A screenshot
from a different computer cannot establish that computer's token budget or exact
upstream behavior; no claim is made that arbitrary-size single responses now work.

## Confirmed stream lifecycle defects

The plugin previously waited for upstream EOF or its 30-minute total timeout
when the upstream returned HTTP 200 and then stopped making data progress.
The existing adapter's progress guard was not connected to the network stream.
A mid-stream read failure also escaped as an exception without a Responses
failure terminal. Both defects are reproduced with controlled streams.

The raw upstream reader now has a fixed 120-second progress budget. SSE
comments and blank lines do not renew it; fragmented non-comment data does.
Only upstream read wait time is charged, not local processing or backpressure.
Cancellation does not wait for an unresponsive upstream cancel callback.
Streaming failures produce one explicit response.failed terminal; buffered idle
timeouts return HTTP 504. Accepted requests are never automatically replayed.
A terminal already delivered is not followed by a duplicate failure terminal.

Seven regression cases cover silence, comment-only keepalives, fragmented
progress, terminal cleanup, truncated streams, total timeout, downstream pauses
and an unresponsive cancellation callback.

## Default compatibility

Known unsupported hosted-tool declarations are omitted and the model receives
a capability notice. Client function/custom tools remain available. Forced
unsupported tools fail explicitly; tool_choice=none disables tools. Historical
message and tool-result ciphertext is replaced with an omission notice before
caching, image processing or compaction. Current encrypted tasks still fail.
Both behaviors are unconditional and have no settings-page switches.

Eight integration regressions cover these policies, continuation, cache
sanitization, compaction, opaque-state preservation and image reprepare.

## Other retained contracts

- Independent OAuth, PKCE/state validation, identity-bound refresh persistence.
- Automatic allowed-model catalog and normalized reasoning capabilities.
- One proxy policy for authorization, models, inference, attachments and quota.
- Scoped, bounded in-memory continuation and tool-catalog cache.
- Read-only quota/reset-credit display through the provider usage hook.
- Complete terminal validation before dispatching any client tool call.

## Verification boundary

Version 0.4.7: Node 130 pass and one Bun-only skip; bundled Bun 1.4.2
131 pass across the 19 root test files.
Go tests, vet, build and native sandbox host loading pass.
Earlier real signed-in text and tool-result requests completed. The reported local
conversation completed in about 65 seconds after reload, through three BPS
rounds and two tool calls, with a final answer of 21.

The earlier unsuccessful attempts lasted about 13 minutes and 8 minutes.
Their raw upstream traffic was not retained, so the specific remote trigger
cannot be reconstructed conclusively. The fixed local failure mechanism is
verified; a successful retry does not establish the cause of those old remote
stalls. Diagnostic capture was removed after verification. No reset credits
were consumed, and private captures are excluded from distributed artifacts.
