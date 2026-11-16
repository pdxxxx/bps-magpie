# Attribution

The Go protocol adapter and URL validation helpers are copied from
https://api.github.com/repositories/1135073661, production commit
b9feadf7dd6228a4117e360821d9994b7cc54897 (v2.21.5, 2026-11-16).
The original project LICENSE and adapter attribution are retained; project-specific wording uses neutral terms and stable repository-ID links.
The GPL-3.0 text incorporated by LGPL-3.0 is supplied in licenses/GPL-3.0.txt.
The source hashes and local changes are recorded in provenance.json.

The adapter's original notice attributes its initial implementation to
hloolx/codex2api (MIT), with subsequent upstream work distributed under the
upstream LGPL-3.0 license. Retain the full adapter notice, including the
original authors, commits and interoperability references.

The Magpie entry point, OAuth lifecycle, management tools and subprocess
transport are new integration code distributed under LGPL-3.0-only.
OAuth, quota, reset-credit and request-header contracts follow the the upstream gateway
source files recorded in provenance.json. No database, production account,
CPA plugin binary, server settings or old working-tree history is included.

Magpie hooks follow its official provider plugin guide at
https://usemagpie.ai/docs/plugins (read 2026-11-16), with local host loading
verification. No Magpie implementation source is included in this package.
Go dependencies are pinned in bridge/go.mod and bridge/go.sum; their
license texts are supplied under licenses/.

This project builds independently and never imports another checkout.
