# BPS integration audit

Version 0.4.3.

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
- Quota/reset-credit display and account-bound manual reset receipts.
- Complete terminal validation before dispatching any client tool call.

## Verification boundary

Node: 105 pass and one Bun-only skip. Bundled Bun 1.4.2: 106 pass.
Go tests, vet, build and native sandbox host loading pass.
Real signed-in text and tool-result requests complete. The reported local
conversation completed in about 65 seconds after reload, through three BPS
rounds and two tool calls, with a final answer of 21.

The earlier unsuccessful attempts lasted about 13 minutes and 8 minutes.
Their raw upstream traffic was not retained, so the specific remote trigger
cannot be reconstructed conclusively. The fixed local failure mechanism is
verified; a successful retry does not establish the cause of those old remote
stalls. Diagnostic capture was removed after verification. No reset credits
were consumed, and private captures are excluded from distributed artifacts.
