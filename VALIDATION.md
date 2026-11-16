# BPS 0.4.7 validation

## Automated checks

| Check | Result |
| --- | --- |
| Windows x64 bridge build | Pass, version 0.4.7 / protocol 3, legacy 2 accepted |
| Go tests | Pass |
| go vet ./... | Pass |
| Node integration tests | 130 pass, 1 Bun-only proxy skip |
| Magpie bundled Bun 1.4.2 | 131 pass across the 19 root test files |
| Native sandbox plugin load and diagnostics | Pass, matching bridge |
| Native host agent tools | Zero; provider-only |

Synthetic tests use the real compiled protocol adapter. They cover OAuth,
identity-bound refresh, models/reasoning metadata, proxy behavior, streaming,
tool histories, attachments, compaction, continuation cache and read-only quota.
Stream-progress regressions reproduce the formerly unbounded
wait and verify explicit terminal errors without automatic request replay.

## Version 0.4.7 optional relay

- Off by default. No server address or relay token is packaged; users must enter
  both and enable the option. Disabled settings make no relay connection.
- The separate WSS relay preserves request body bytes, per-request identity,
  upstream HTTP status and streamed response data. Active requests fail on
  disconnect; later calls can reconnect without replaying submitted requests.
- Client tests cover configuration, channel reuse, multiple IDs, cancellation,
  disconnect/backoff, errors without direct fallback and flow-control credits.
- Real Bun-to-Go integration sent a 65 MiB request and received a 130 MiB
  response over one channel, then cancelled one request and reused that channel.
  This verifies relay transport capacity, not the existing provider 64 MiB cap.
- Remote TLS/WSS connection and unsigned BPS access probes passed. Three requests
  used one WSS connection; first request was about 1.91 seconds, follow-ups about
  0.29 seconds. The expected unsigned status was 401 and was preserved.
- Two simultaneous remote clients using the same fresh saved account independently
  fetched an allowed seven-model catalog. Different-account isolation was tested
  synthetically. No new real inference was sent after the previously observed
  upstream usage-policy refusal. A successful model list is not inference proof.
- Service has no request/client/account count limit, aggregate body-size limit,
  or inference-duration timeout. Local Magpie concurrency remains four. Frame,
  header, in-flight credit, handshake and disconnected-peer bounds still apply.
- WSS connects directly to the manually entered relay; it does not inherit the
  provider/global HTTP proxy. Host-level VPN/TUN can still affect routing.
- Go relay unit tests and vet pass. The race detector could not run on this
  Windows machine because the C compiler is unavailable; no race-pass claim.

## Earlier version 0.4.6 experiments and limits

- Selected-tool catalog presentation: 20 paired function requests per version
  and three paired raw-code requests. All 46 requests completed with correct
  arguments. Function input fell from 36,200 to 23,852 tokens; medians were
  4.69/4.34 seconds. This is a modest, noisy latency benefit, not a general SLA.
- Repeated valid PNG requests: baseline uploaded three times, candidate once.
  All six inferences completed. Cache isolation, TTL, limits, independent
  cancellation, late completion and rejection invalidation pass offline tests.
- Explicit prompt key without session headers: candidate reused one routing key
  and obtained 5/5 warm follow-up cache hits; baseline used six keys and had no
  hits. Task IDs remained distinct and previous_response_id remained rejected
  without session identity. Total latency did not improve reliably.
- Native echo filtering reduced a minimal response from approximately 289 KB
  to 6.2 KB at the client; upstream bytes and input tokens were unchanged.
- Exact 7,808-byte synthetic artifacts in one/two/four complete operations showed
  faster first delivery but greater total time when split. Five of six tasks
  completed exactly; one two-part task encountered a network error. No automatic
  splitting policy is added.
- New process preparation measured about 15 ms for minimal input and 54 ms for
  1 MiB history. In-process preparation was about 10-12 microseconds. Burst SSE
  merging saved tens of milliseconds. No process pool or delayed buffer is added.
- Four paired direct/explicit-proxy requests completed. The existing proxy was
  not faster; no proxy setting was changed. Application direct mode can still
  traverse a machine VPN/TUN, so it is not proof of the physical route.
- Concurrency stays at four. A second four-request wave received 403 for all
  requests and testing stopped. Later single-request baseline and candidate
  probes both returned an explicit upstream usage-policy block. Model access
  still returned allowed=true. No alternate model/account/route was tried to
  evade it, and final online inference acceptance is blocked by that upstream
  response. The release preserves 403 with a fixed, non-sensitive error code.
- Provider-only native host loading registers zero tools. OAuth, model discovery,
  request forwarding, quota and reset-credit display remain. Manual MCP reset
  endpoints were removed; existing local receipts are not deleted.
- Installed Magpie native host and bundled Bun were exercised against a local
  authenticated HTTP CONNECT proxy and a trusted test TLS origin. Provider proxy
  selection overrode global proxy; special-character userinfo, model/usage calls,
  image upload and two inference calls passed. The second image request reused
  its upload ID. Proxy-Authorization never reached the origin. A wrong password
  failed without a direct fallback or password disclosure. No real credentials
  or external network were used for this transport test.

These observations use one account, gpt-6-astra/xhigh and synthetic tasks. They
do not establish p95, all-model behavior, or a guarantee against future refusals.

## Earlier version 0.4.5 checks

- The live strict native tool schema requires references to contain at least
  one string. Empty references instructions conflicted with that contract;
  captured failed requests kept generating whitespace in that field without
  a completed native response. Prompts, examples and reconstructed history now
  name the client tool in references.
- In an isolated same-model xhigh comparison, the empty-reference candidate
  completed 8/12 selected-tool requests within 30 seconds; the corrected
  candidate completed 12/12. These are bounded synthetic probes, not a general
  failure-rate or latency guarantee.
- Conditional automatic-tool instructions completed 20/20 direct-answer probes
  with a 64-tool catalog, as did the baseline. Median latency was 3.25 versus
  6.92 seconds. Required and explicitly selected tools remain validated.
- Optional request metrics export only timings/counts and fixed outcomes.
  Tests cover cancellation, callback failure, correction usage, upload timing
  and scope queue timing. No production logging or new user setting is enabled.
- The installed local Magpie reports plugin and bridge 0.4.5, protocol 3.
  A real xhigh tool-generation request and simulated-result continuation both
  completed through its gateway in approximately 4.3 and 5.3 seconds. The
  returned tool was not executed.
- Experimental parallel batching is excluded from this release.

## Earlier real account and local host checks (0.4.4)

- One malformed raw-command fixture was corrected through the real authenticated
  BPS endpoint, preserving its operation. No returned command was executed.
- The installed Magpie gateway completed a real tool-generation request through
  protocol 3 in about 5 seconds, preserving the requested command. Native local
  diagnostics report matching plugin and bridge version 0.4.4.
- An A/B probe verified that adding max_output_tokens=1024 to a valid prepared
  request changes successful completion into HTTP 422. The adapter preserves
  output-limit errors and does not claim to override the remote output ceiling.

- Authenticated model discovery returned seven permitted models with reasoning
  metadata and low/medium/high/xhigh options. Existing selections were retained.
- Real text inference, a function call and its result continuation completed.
- Reconstructed conversation requests completed both directly and through the
  local gateway. A raw-wire replay completed without the local converter.
- The originally reported local conversation was explicitly continued once
  with the user's approval. It completed in 65.4 seconds across three upstream
  requests (about 7.4, 33.1 and 24.0 seconds) and returned a final answer of 21.
- Temporary native tracing observed a completed upstream terminal in each
  round. It recorded no authorization headers and was removed from runtime
  code after investigation. Private evidence is outside the repository.

These earlier checks demonstrate completion at their observation times. Historical failed
streams were not captured, so their specific upstream trigger remains
unproven. See AUDIT.md for the confirmed plugin defects and remaining evidence
boundary. No quota reset or reset-credit consumption was performed.

## Packaging

The Windows x64 release includes the built bridge, JavaScript integration,
settings UI, full source, tests, source provenance and license texts. Package
files explicitly enumerate supported binary names, excluding stale executable
backups. Credentials, runtime state, traces and reference downloads are not
part of the repository or release. Source references use stable repository-ID
links and commit identifiers while retaining author attribution.
