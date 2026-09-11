# Operator quickstart

**`npm install` does not work in either unit of this repo, and it is not your
setup.** Everything below is a way to get useful work out of it anyway, in
about five minutes, rather than losing an afternoon to a dependency graph that
cannot be resolved.

Read [the README](../README.md) for what the repo contains. This is the
procedure. Every command here was run, in this order, from a clean checkout on
2026-08-14 (macOS, node 26.3.0, npm 11.16.0), and the outputs quoted are what
came back.

## 1. Re-take the measurement (~20 seconds)

From the repo root:

```bash
kbb --backend sci docs/check-declared.cljk
```

You need [nbb](https://github.com/babashka/nbb) (`npm i -g nbb`), DNS, and
HTTPS to `raw.githubusercontent.com` and `registry.npmjs.org`. Nothing else —
no install, no build, no credentials.

It walks the dependency graph, resolves the declared hosts, and re-runs the
`MIGRATION-TODO.md` scan, then exits:

| exit | meaning |
|---|---|
| `0` | everything the repo declares can be obtained |
| `1` | at least one declared thing cannot be — **the state on 2026-08-14** |
| `3` | could not answer; see below |

Expected output today ends with:

```
2 dependency ref(s) float on a branch; 1 package(s) cannot be named;
1 workspace dependency is unsatisfiable; 2 of 2 declared hosts do not exist;
1 licence document(s) were not shipped; 1 forbidden substrate(s) remain.
```

**Exit 3 is not a failure of the repo, it is a refusal to answer.** You get it
when the control host does not resolve (then an NXDOMAIN here would prove
nothing about the repo), when `registry.npmjs.org` is unreachable (then a
dependency we could not fetch proves nothing about the dependency), when `git`
cannot describe the tree, or when scanning finds no declarations at all —
usually because you ran it from the wrong directory.

## 2. Run the quote engine — no install at all (~10 seconds)

`print-network.ts` has no imports, so node's own type stripping is enough
(node ≥ 22.6). This is the repo's actual routing logic, over its six seeded
partners:

```bash
cd appview/insatsu-ins4tup1
node --input-type=module -e "
const m = await import('./src/print-network.ts');
console.log(JSON.stringify(m.quotePrintMailJob({destinationCountry:'JPN', pageCount:4, quantity:1}), null, 1));
"
```

```json
{
 "partnerDid": "did:web:insatsu.etzhayyim.com:partner:tokyo-printpost",
 "partnerDisplayName": "Tokyo PrintPost Center",
 "routeType": "postal-handoff",
 "downstreamActorDid": "did:web:yuubin.etzhayyim.com",
 "estimatedProductionDays": 1,
 "estimatedDeliveryDays": 2,
 "estimatedTotalDays": 3,
 "estimatedCostUsd": 6.14,
 "currency": "USD"
}
```

Try `'DEU'`, `'USA'`, `serviceLevel: 'express'`, `mailClass: 'hybrid-mail'`.
`listSeedPartners()` and `findSeedPartner(slug)` are exported too. Note that
the DID it routes to is **NXDOMAIN** — the arithmetic is real, the destination
is not.

`kotoba/src/types.ts` runs the same way (`partnerDidFor`, `isDecimalString`,
`jobRkey`). `registry.ts` does **not**: it imports `./types.js` meaning
`types.ts`, which is a TypeScript convention node does not implement. For that
you need step 3.

## 3. Run both test suites (~2 minutes)

14 tests, and they are the only executable statement of the repo's invariants.
Getting them to run takes a workaround, because `npm install` fails in both
units for two different reasons (step 4).

The workaround is to build the dependency set **out of band**, in a directory
with no package.json of its own, and copy it in — npm's failure is triggered by
reading *this* repo's dependency specs, so a scratch project never sees it:

```bash
mkdir -p /tmp/insatsu-testdeps && cd /tmp/insatsu-testdeps
npm init -y >/dev/null
npm install --no-audit --no-fund vitest@^4.1.0 typescript@^5.6.0   # 45 packages
```

**The appview suite** needs only that — `app.test.ts` replaces the host SDK and
Kysely with `vi.mock` factories, so the packages it cannot install are never
loaded:

```bash
cd <repo>/appview/insatsu-ins4tup1
mkdir -p node_modules && cp -R /tmp/insatsu-testdeps/node_modules/. node_modules/
./node_modules/.bin/vitest run
#  Test Files  1 passed (1)
#       Tests  8 passed (8)
```

**The kotoba suite** also needs the mock SDK, at the commit `package.json`
pins. Note the owner: both SDK repos moved from `etzhayyim/com-etzhayyim-*` to
`kotoba-lang/*`, and only GitHub's rename redirect keeps the declared URLs
working.

```bash
cd <repo>/kotoba
mkdir -p node_modules && cp -R /tmp/insatsu-testdeps/node_modules/. node_modules/
git clone -q https://github.com/kotoba-lang/sdk-mock.git node_modules/@etzhayyim/sdk-mock
git -C node_modules/@etzhayyim/sdk-mock checkout -q c857ff9be5310bf433bfe1e8d3c0f677e213d667
./node_modules/.bin/vitest run
#  Test Files  1 passed (1)
#       Tests  6 passed (6)
```

`@etzhayyim/sdk` itself is **not** needed to run them: `registry.ts` imports
only a type from it, and a type import is erased before anything executes. It
*is* needed to typecheck — see step 4.

These suites discriminate; that has been exercised rather than assumed.
Replacing the cross-layer foreign-key guard in `recordJob` with `if (false)`
turns exactly one test red — *"enforces cross-layer FK: job for an unknown
partner is rejected", expected 'recorded' to be 'rejected'* — and restoring it
returns 6 passed.

Clean up with `rm -rf node_modules` in each unit; `.gitignore` covers them
meanwhile.

## 4. What fails, and the exact reason

| you might try | what happens |
|---|---|
| `npm install` in `kotoba/` | `npm error code EALLOWSCRIPTS` — *"--allow-scripts is not allowed in project-scoped installs"*, raised while preparing the first git dependency. npm 11.16.0 passing an illegal flag to itself. `--ignore-scripts` does not avoid it, and neither does `npm install --no-save <anything>`, because a project-scoped install still reads the declared git deps first |
| `pnpm install --ignore-scripts` in `kotoba/` | gets past that, resolves 111 packages, then `ERR_PNPM_MISSING_PACKAGE_NAME  Can't install git+https://github.com/kotoba-lang/ipfs.git#main: Missing package name`. `@etzhayyim/checkpointer@63586c4` floats on that branch, and `package.json` there has no `name`. Its other floating ref, `pqh#main`, has no `package.json` at all |
| `npm install` in `appview/insatsu-ins4tup1/` | different failure: `EUNSUPPORTEDPROTOCOL — Unsupported URL Type "workspace:": workspace:*`. There is no `pnpm-workspace.yaml` or lockfile in this repo, and `@etzhayyim/kotodama-host-sdk` is 404 on the registry. The repo of that name in this workspace has had its TypeScript surface removed |
| `npm test` in `appview/insatsu-ins4tup1/` | its `package.json` declares **no scripts and no devDependencies** — yet ships `vitest.config.ts` and a test file. Use the explicit binary as in step 3 |
| `npm run typecheck` in `kotoba/` | 4 errors: `src/registry.ts(18,32): error TS2307: Cannot find module '@etzhayyim/sdk'`, then three `TS7006` implicit-`any` downstream of it. It cannot pass until the SDK installs |
| `tsc` in `appview/insatsu-ins4tup1/` | there is no `tsconfig.json` |
| deploy the worker | there is no `wrangler.toml`/`wrangler.jsonc`, and `app.ts` needs a host SDK that does not exist |
| resolve the actor | `insatsu.etzhayyim.com` is NXDOMAIN, so `did:web:insatsu.etzhayyim.com` cannot be resolved. The DID and manifest live in `cloud-itonami/insatsu-actor`, not here |
| read the licence rider you accepted by using this | `CHARTER-RIDER.md` is referenced by `NOTICE` and is not in the repo |

## 5. If you change anything

`docs/check-declared.cljk` is the regression check for the README, and nothing
in it is hardcoded: add a dependency, a `workspace:` sibling, or an
`*.etzhayyim.com` host and it comes under the check by itself.

- Editing or deleting an extracted file flips the extraction line to `CHANGED`.
  It compares the first commit against the **working tree**, so an uncommitted
  edit counts — an earlier version compared against `HEAD` instead and reported
  `UNCHANGED` while a modified file sat in the tree.
- Pinning `checkpointer`'s two floating refs, or giving `kotoba-lang/ipfs` a
  `name`, moves the dependency lines from `FLOATING`/`UNNAMED` toward `PINNED`.
- Standing up either host, shipping the rider, or finishing a
  `MIGRATION-TODO.md` item moves its line too. When the last one goes, the
  script exits `0` and says the README is stale.

That direction has been exercised, not assumed: with every declaration
satisfied the script exits `0`, and each of the five arms has been shown to
flip on its own.
