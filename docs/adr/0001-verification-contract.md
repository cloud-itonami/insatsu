# ADR-0001 — What "verified" means for this repo while its install path is broken

- **Status**: accepted
- **Date**: 2026-08-14
- **Supersedes**: nothing
- **Context repos**: `cloud-itonami/insatsu`, `cloud-itonami/insatsu-actor`,
  `kotoba-lang/sdk`, `kotoba-lang/checkpointer`, `kotoba-lang/ipfs`,
  `kotoba-lang/kotodama-host`

## Context

This app was extracted verbatim from `etzhayyim/root` and has never been built
from a clean clone. Measured on 2026-08-14 (tip `94f880e`), it cannot be:

- `npm install` in `kotoba/` aborts with `EALLOWSCRIPTS` on npm 11.16.0 before
  reaching any dependency;
- `pnpm install` gets further and stops at
  `ERR_PNPM_MISSING_PACKAGE_NAME` — `@etzhayyim/checkpointer@63586c4` depends
  on `kotoba-lang/ipfs#main`, a **branch**, whose `package.json` has no `name`.
  Its sibling floating ref `pqh#main` has no `package.json` at all;
- `npm install` in `appview/` fails differently, on `workspace:*` for
  `@etzhayyim/kotodama-host-sdk`, which is not in this repo, is 404 on npm, and
  whose namesake in this workspace has had its TypeScript surface deliberately
  removed;
- `did:web:insatsu.etzhayyim.com` is NXDOMAIN, so nothing can resolve the actor
  this code belongs to.

Meanwhile the source reads as healthy and both vitest suites pass. That
combination is the hazard: **a reader who runs the tests concludes the repo is
fine, and a reader who reads the source cannot see otherwise.** Neither the
green suites nor the source are wrong; they simply do not measure the part that
is broken.

## Decision

**1. The verification contract for this repo is `nbb docs/check-declared.cljk`
plus the two vitest suites, run per `docs/operator-quickstart.md`.** Neither
alone is sufficient. The suites pin behaviour (money as decimal strings, the
cross-layer foreign key from sealed job to plaintext partner, read-capability
scoping); the check script measures whether anything the repo declares can be
obtained at all.

**2. The check script is three-valued and never reports a pass it did not
earn.** Exit `0` all-obtainable, `1` something is not, `3` could-not-measure —
a dead control host, unreachable HTTPS, or a scan that found no declarations
must not be reachable from the same exit code as a clean measurement. Every
arm has been shown to flip on its own, and exit `0` has been reached on a
doctored copy, so the pass path is not dead code.

**3. The dependency arm walks the graph transitively.** The break is two hops
out; a one-hop check would report all-clear on this repo today. It follows git
specs by fetching each package's `package.json`, so a moved or renamed
dependency is still followed and a new one comes under the check by itself.

**4. We do not repair the dependency chain from here.** The fix belongs in
`kotoba-lang/checkpointer` (pin its two floating refs) or `kotoba-lang/ipfs`
(give its `package.json` a `name`); repairing it inside this repo would mean
vendoring or overriding another repo's declarations, and would leave every
other dependent of `@etzhayyim/sdk` broken. The appview's host SDK is not a
repair at all — the TypeScript surface it imports was retired on purpose, so
that worker needs rewriting against the CLJC contract.

**5. `MIGRATION-TODO.md` is re-measured, not trusted.** Its five remediations
are all still open; rather than let that file's date rot, the check script
re-runs the substrate scan on each invocation. Kysely is still present in the
appview.

## Consequences

- An operator can establish this repo's real state in about twenty seconds
  without installing anything, and can get the invariant tests running in about
  two minutes with a documented workaround.
- The README's status table is falsifiable. When someone pins the floating
  refs or stands up the hosts, the script says so and the README becomes the
  stale artifact — which is the intended pressure.
- The workaround in the quickstart (build the dependency set out of band and
  copy it in) is deliberately ugly. It should stop working the day the real
  install path is fixed, and its ugliness is the reminder that it has not been.
- This repo stays measurable but unbuildable. It is not deployable and this ADR
  does not make it so.
