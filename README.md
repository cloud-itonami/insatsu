# insatsu

**印刷 — cloud print and postal orchestration.** A job arrives with a document
and a destination address; the network picks a regional print shop, prints near
the recipient, and hands the physical mail to a postal carrier. This repo holds
two units of that system, extracted verbatim out of `etzhayyim/root`.

**The code here works. Getting to it does not.** Both test suites pass — 14
tests — but neither `npm install` nor `pnpm install` completes in either unit,
the declared runtime dependency of the appview no longer exists anywhere, and
the actor DID does not resolve in DNS. None of that is visible from reading the
source, which looks fine. It has to be measured:
**`nbb docs/check-declared.cljs`** ([quickstart](docs/operator-quickstart.md)).

**The identity is not here.** `did:web:insatsu.etzhayyim.com` and the actor
manifest belong to the sibling repo `cloud-itonami/insatsu-actor`; a copy of
that DID shell was added here in August 2026 and removed again two commits
later (`1026dd9`, `94f880e`) precisely because this repo is not its owner.
Read this one as **the application code**, and `insatsu-actor` as the actor.

## What is in here

Two units, with no build or dependency relationship between them.

### `kotoba/` — the record layer

Where a print-mail job is *stored*, split by sensitivity. This is the interesting
part of the repo and the part with real invariants.

| | collection | how it is written |
|---|---|---|
| **public** | `com.etzhayyim.apps.insatsu.printPartner` | plaintext AT records — the print-shop catalog: capabilities, capacity, `baseCostUsd`, `perPageUsd` |
| **sealed** | `com.etzhayyim.apps.insatsu.printMailJob` | `sdk.encryptedWrite` — recipient name, street address, postal code, document URL, case id, subject |

The split is the point: a print job is postal-operator PII plus a document
chain-of-custody, so the substrate never sees it in plaintext, while the shop
catalog stays open so anyone can route against it. Three invariants hold it
together, and all three are covered by tests:

- **Money is a decimal string, never a float.** `"12.50"`, not `12.5`. The
  AT lexicon has no float, and the rollup counts records rather than summing
  amounts. `"1.2.3"` is rejected.
- **Cross-layer foreign key.** A job's `partnerDid` must already exist in the
  *plaintext* catalog before the *encrypted* write happens — a job for an
  unknown shop is rejected, so the sealed layer cannot accumulate references
  into nothing.
- **Read capability is the owner DID**, plus any explicitly named recipients.
  A DID that was not granted one reads zero jobs, not ciphertext it might
  later crack.

### `appview/insatsu-ins4tup1/` — the worker

`print-network.ts` is a self-contained quote engine over six seeded partners
(Tokyo, Singapore, Berlin, Chicago, São Paulo, Johannesburg) that scores by
destination, page count,
service level and mail class, and returns a route type and a cost. It has **no
imports at all** and can be run directly — see the quickstart. `app.ts` (484
lines) wraps it as a Kotodama host worker.

### What deliberately is *not* here

Print production, the `composeAndPost` postal injection into 郵便, the
settlement of print and postage costs. Those are regulated *acts*; this repo
holds the job *data* and the routing decision. The acts stay at etzhayyim and
are reached through a consent capability.

## Status — measured 2026-08-14

Do not trust this table. Re-take it: **`nbb docs/check-declared.cljs`**. Every
line below is that program's output, on tip `94f880e`.

### The install path is dead in three independent places

| | |
|---|---|
| `@etzhayyim/sdk` → `@etzhayyim/checkpointer` → `@etzhayyim/ipfs` | `checkpointer@63586c4` asks for `kotoba-lang/ipfs#main` — a **branch**, not a pin. `package.json` at that branch contains only `{private, scripts}`: **no `name`**, so no package manager can install it. `pnpm` stops here with `ERR_PNPM_MISSING_PACKAGE_NAME`. |
| the same, → `@etzhayyim/pqh` | `checkpointer` also floats on `kotoba-lang/pqh#main`, where **there is no `package.json` at all** |
| `@etzhayyim/kotodama-host-sdk` | declared `workspace:*` by the appview. Not in this repo; **404 on the npm registry**; and `kotoba-lang/kotodama-host`, which carries that name in this workspace, states that its "TypeScript package metadata and runtime facade code were removed". The package the appview imports does not exist anywhere. |

Eight of the ten git dependency nodes are pinned to a SHA and fine. The two
that are not are enough to stop every install.

Separately, `npm install` never gets far enough to see any of that: on
npm 11.16.0 / node 26.3.0 it aborts while preparing the first git dependency
with `EALLOWSCRIPTS — --allow-scripts is not allowed in project-scoped
installs`. That is npm passing an illegal flag to itself, and `--ignore-scripts`
does not avoid it.

### The declared hosts do not exist

`insatsu.etzhayyim.com` and `yuubin.etzhayyim.com` are both **NXDOMAIN**
(`etzhayyim.com` itself resolves, so this is not a DNS fault). So
`did:web:insatsu.etzhayyim.com` — the DID that names every partner in the
catalog and that `insatsu-actor` claims — cannot be resolved by anyone, and
the downstream the quote engine hands Japanese domestic mail to is unreachable.

### The migration is still open

`MIGRATION-TODO.md` says a post-migration scan found a substrate-boundary
violation and lists five remediations. **None of the five are done.** The
appview still sits on Kysely/SQL (`createKyselyDb()`, four call sites), which
the charter says must become AT MST + IPFS. The check script re-runs that scan
rather than trusting the file.

`NOTICE` conditions the licence grant on `CHARTER-RIDER.md`. That file is
**not in this repo**, so the terms you accept by using this cannot be read.

### What is intact

- **The extraction.** First commit `80312f2`: 16 files / 61,137 bytes, which is
  exactly the 14 files / 60,649 bytes `migration.edn` declares plus its two
  allowed additions (`README.edn`, `migration.edn`, 488 bytes). No extracted
  path has drifted by a byte since.
- **The tests.** `kotoba` 6 passing, `appview` 8 passing. They pass because
  `kotoba` uses an in-memory `MockEtzhayyim` and the appview replaces its
  missing host SDK with `vi.mock` — that is, *the suites are green precisely
  because they do not touch the parts that are broken.* They are still worth
  running: they are what pins the three invariants above.

`README.edn` declares this repo as `:name "com-etzhayyim-app-insatsu"`,
`:kind :app` — a name from before the move to `cloud-itonami/insatsu`.

## Next

The cheapest real repair is one line in another repo: give
`kotoba-lang/ipfs`'s `package.json` a `name`, or pin `checkpointer`'s two
floating refs. That unblocks `pnpm install` for every package that depends on
`@etzhayyim/sdk`, not just this one. The appview's host SDK is a larger
question — the TypeScript surface it wants was deliberately retired, so the
worker needs rewriting against the CLJC contract rather than repairing.

Neither is done here. This change is documentation and a measurement, nothing
else.
