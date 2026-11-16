# BPS 0.4.3 validation

## Automated checks

| Check | Result |
| --- | --- |
| Windows x64 bridge build | Pass, version 0.4.3 / protocol 2 |
| Go tests | Pass |
| go vet ./... | Pass |
| Node integration tests | 105 pass, 1 Bun-only proxy skip |
| Magpie bundled Bun 1.4.2 | 106 pass |
| Native sandbox plugin load and diagnostics | Pass, matching bridge |
| Eight management/diagnostic tools | Registered |

Synthetic tests use the real compiled protocol adapter. They cover OAuth,
identity-bound refresh, models/reasoning metadata, proxy behavior, streaming,
tool histories, attachments, compaction, continuation cache, quota and manual
reset receipts. Stream-progress regressions reproduce the formerly unbounded
wait and verify explicit terminal errors without automatic request replay.

## Real account and local host

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
