# BPS 0.4.5 validation

## Automated checks

| Check | Result |
| --- | --- |
| Windows x64 bridge build | Pass, version 0.4.5 / protocol 3, legacy 2 accepted |
| Go tests | Pass |
| go vet ./... | Pass |
| Node integration tests | 124 pass, 1 Bun-only proxy skip |
| Magpie bundled Bun 1.4.2 | 125 pass across the 14 root test files |
| Native sandbox plugin load and diagnostics | Pass, matching bridge |
| Eight management/diagnostic tools | Registered |

Synthetic tests use the real compiled protocol adapter. They cover OAuth,
identity-bound refresh, models/reasoning metadata, proxy behavior, streaming,
tool histories, attachments, compaction, continuation cache, quota and manual
reset receipts. Stream-progress regressions reproduce the formerly unbounded
wait and verify explicit terminal errors without automatic request replay.

## Version 0.4.5 checks

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

This proves the repaired local path currently completes. Historical failed
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
