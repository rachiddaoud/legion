# M1b fixture-track ledger (T34)

Accounts for PLAN-V3 §Milestones **M1b**'s fixture track — *"editing the contract invalidates
**both** siblings' spec approvals and their dependents (the cascade is verified, not assumed); a
secondary whose by-reference record points at a missing or hash-mismatched recap refuses
`stage-complete intake`"* — the same way `M0-FIXTURE-LEDGER.md` and `M1A-FIXTURE-LEDGER.md` account
for theirs. For each case: the test that proves it, cited by file + test name, with the decisive
assertion quoted **verbatim**; the mutation record; and the honest split between what is
**kernel-hermetic** and what is **prose-borne**.

`M0-FIXTURE-LEDGER.md` and `M1A-FIXTURE-LEDGER.md` are **byte-untouched** by this chunk. Where an
M0 or M1a row already carries a claim this track would otherwise re-prove — the ordinary
artifact-hash cascade, prefix re-derivation at every forward hop, the immobility discipline — it is
CITED and not duplicated.

---

## THE SHIPS-DARK ROW — read this before any other row

**This ledger claims HERMETIC ENFORCEMENT ONLY. It does not claim M1b.**

PLAN-V3 §Milestones M1b's 2026-07-29 amendment split the milestone in two: the initiative layer is
**built unattended now with hermetic fixture coverage**, and the **attended FE+BE proving run is
DEFERRED** until a real cross-repo need appears. Until that run the layer **ships dark** — no real
initiative has been driven through it, and **M1b's acceptance stays OPEN**.

So, precisely:

- **What every row below proves:** the real `bin/legion.mjs`, driven over real repositories and
  real dossiers in a temp `LEGION_HOME`, refuses what it must refuse and accepts what it must
  accept. `built and hermetically tested` is the exact truthful claim, and it is the whole claim.
- **What NO row below proves, and what nothing in this repository proves today:** that one
  code-informed intake over a real frontend + backend project produces two features that a human
  drives to two verified MRs. That is M1b's acceptance. It has not happened. A reader who takes
  this file as evidence that it has is reading it wrong, and a future chunk that cites this file as
  M1b's delivery is citing it wrong.
- **Consequently the fixture track is COMPLETE while the MILESTONE is not.** Those are different
  statements and this ledger only ever makes the first one.

---

## The bar every "covered-by" row meets

Identical to M0's and M1a's, verbatim in force. A row is only claimed as covered when the cited
test is **ADVERSARIAL**: it drives the real `bin/legion.mjs` into a state where refusal is the
correct answer, asserts the refusal **and what the refusal names**, and asserts that **no state
moved** (manifest bytes compared — `h.assertUnmoved()` in the fixture's own feature, the local
`assertUnmoved(dossier, snap, …)` for the sibling dossiers the fixture did not start). A test that
walks the happy path and asserts success is never accepted as coverage of a refusal. Every group
ends on a **positive control**: a refusal test that never proves the door opens again passes just
as well against a layer that wedged it shut.

Two additions this track needs that M0's and M1a's did not:

1. **BOTH siblings, never one.** M1b's sentence is *"invalidates **both** siblings' spec
   approvals"*. Every cascade assertion is written as a loop over `siblings(p)` so it can never
   assert on one sibling and read as covering the pair.
2. **The regression pin is part of the track.** M1b's own constraint is that it *must not
   destabilize M1a*. A row therefore exists whose entire job is that a **non-initiative** feature
   is byte-identical to what it was before this layer existed.

**How to keep this file honest.** No aspirational rows. If a cited test is deleted, weakened or
renamed, this file is wrong and whoever reads it is reading a lie. Cite file + test name; quote the
assertion that carries the claim, not the setup. A case blocked by a product defect says NOT
COVERED and names the defect — an honest hole outranks a false row.

**No product code was changed by T34.** This chunk writes prose (`skills/feature/SKILL.md`,
`skills/start/SKILL.md`, `agents/architect.md`), this ledger, and one re-aimed assertion in
`test/plugin-manifest.test.mjs` (finding 1). The behaviour every row cites was built by T32
(`6bf8906` + `ba7eea7`) and T33 (`58cb5c9` + `30e3db7`).

---

## Ledger

| # | Case (PLAN-V3 M1b, adversarial form) | Status |
|---|---|---|
| 1 | a contract edit invalidates **BOTH** siblings' spec approvals **and their dependents** | **covered** — added by T33, `test/acceptance/m1b-fixtures.test.mjs` |
| 2 | a by-reference record pointing at a **missing or hash-mismatched** recap refuses `stage-complete intake` | **covered** — added by T32, `test/cli/initiative.test.mjs` |
| — | *the attended FE+BE proving run* | **NOT COVERED, and not a hole** — it is the milestone's DEFERRED acceptance (ships-dark row) |

---

## 1. A contract edit falls BOTH siblings' spec approvals and their dependents — COVERED (T33)

**The fixture is a real two-repository initiative**, because a same-project pair would prove a
weaker thing: a BE primary in the fixture's own repo hosting the shared recap and the interface
contract, an FE secondary in a **second real repository registered as a second legion project in
the same `LEGION_HOME`**, completing intake **by reference**, with **different profiles**
(standard + express — §Initiatives' "any mix", which costs nothing and pins that the cascade does
not care). Both siblings are walked legitimately to an approved spec and an approved plan through
the real bin, `plan check --import` included, before anything is poisoned.

### 1(a) The subject IS the binding — pinned to its VALUE, not to "something changed"

`test/acceptance/m1b-fixtures.test.mjs` ·
**``M1b-1 editing the interface contract falls BOTH siblings' spec approvals and every dependent stage``**

The positive control that opens the case computes the expected subject **independently of the
kernel**, from the files on disk, for **each** sibling — the primary resolving the contract from its
own recorded artifact, the secondary from its reference, both landing on the one file in the
primary's dossier:

```
assert.equal(s.readTasks().approvals.spec.subjectHash, specSubjectWithContract(spec, p.contractPath),
  `${s.name}: the spec approval must bind spec bytes AND the live contract bytes`);
assert.notEqual(s.readTasks().approvals.spec.subjectHash, sha256(readFileSync(spec)),
  `${s.name}: and it must NOT be the bare spec hash — that is the pre-T33 formula`);
```

### 1(b) THE ADVERSARIAL CENTRE — the FILE EDIT ALONE is enough, before any re-record

This is the assertion that separates a real drift guard from a bookkeeping one. A binding that
keyed off the **recorded** artifact hash would still read "valid" here: the contract moved and
nobody's approval noticed, which is PLAN-V3 risk 6 word for word. The subject binds **live bytes**,
so the poison lands the moment the file changes:

```
assert.equal(r.code, 1, `${s.name}: a moved contract must poison the prefix immediately, before any re-record`);
assert.match(r.stderr, /stage 'spec' does not re-derive satisfied/);
assertUnmoved(s, snap, 'a refused stage-enter build over an edited contract');
```

### 1(c) BOTH siblings' spec approvals fall, and the refusal names the approval

Each sibling steps backward to `spec` first — always allowed, always recorded, and it clears
nothing (§State `stage-enter`), which is precisely why the refusal that follows is evidence rather
than an artefact of the round trip:

```
assert.equal(r.code, 1, `${s.name}: stage-complete spec must refuse after the contract moved`);
assert.match(r.stderr, /no hash-valid spec approval/,
  'the refusal names the APPROVAL that fell — the operator re-records that, not the artifact');
assert.match(r.stderr, /decision-record spec/, 'and the op that repairs it');
assertUnmoved(s, snap, 'a refused stage-complete spec over an edited contract');
```

### 1(d) THE DEPENDENTS — and the precise shape of *how* they fall

The plan **approval record survives**: its own subject is `plan.md` + `planContent` and never
mentioned the contract. What falls is every stage that **reads the prefix** (§State corollary 1) —
so the dependency has to be proven at a **consumer**, and the case asserts the unchanged record
first so the refusal cannot be about anything else:

```
assert.equal(JSON.stringify(s.readTasks().approvals.plan), planApprovalsBefore[i],
  `${s.name}: control — the plan approval RECORD is unchanged; what fell is the stage that reads the prefix`);
```

```
assert.equal(stale.code, 1, `${s.name}: the plan stage depends on a spec stage that no longer re-derives`);
assert.match(stale.stderr, /earlier stage 'spec' does not re-derive satisfied/);
assert.match(stale.stderr, /no hash-valid spec approval/);
```

```
assert.equal(fwd.code, 1, `${s.name}: and the build stage is unreachable while it stands`);
assert.match(fwd.stderr, /stage 'spec' does not re-derive satisfied/);
assertUnmoved(s, snap, 'a refused plan-stage op over an edited contract');
```

**`legion finalize` and `close delivered` are NOT separately asserted here, and the reason is
stated rather than glossed.** They call **the same** `unsatisfiedPrefix`
(`src/cli/finalize.mjs`, `kernel/state.mjs` `closeFeature`) and the same `computeSubjectHash`, so
they inherit this with no code of their own — *verified by reading, with nothing changed there*.
That is a genuine residual of this row and it is recorded as finding 2, not hidden in a claim.

### 1(e) Positive control — the door is closed, not wedged

Re-approving each spec against the **new** contract (the human looked at the new interface)
releases both siblings, and the plan approval that was never dropped starts counting again:

```
assert.equal(s.readTasks().approvals.spec.subjectHash, specSubjectWithContract(spec, p.contractPath),
  `${s.name}: the new approval binds the NEW contract bytes`);
```

and the other direction of the same claim — restoring the **original** bytes must not revive an
approval given to the new ones, because the subject is a claim about **content**, not about mtime
or edit order:

```
assert.equal(back.code, 1, 'the contract is back to v1 while the spec was approved against v2 — that must refuse too');
```

### 1(f) The fail-closed directions, and the writer-side guard the row depends on

| what | test | decisive assertion |
|---|---|---|
| the contract file **vanishes** — one deletion in the primary's dossier reaches both siblings | ``M1b-2 a contract that cannot be read fails BOTH siblings closed, loudly at the recorder`` | `assert.equal(r.code, 1, `${s.name}: a spec approval whose contract is gone must not be usable`);` and, at the recorder, `assert.match(rec.stderr, /cannot be read/);` |
| a secondary's block carries a **hollow** contract reference (hand-edited manifest) | ``M1b-2b a SECONDARY whose block carries no usable contract reference fails closed, not open`` | `assert.equal(r.code, 1, 'a secondary with no contract reference must not fall back to the bare spec hash');` |
| an **unknown role** must resolve like the host, not like "no contract" | same test | `assert.equal(drift.code, 1, 'an unknown role must still bind the recorded contract');` |
| the contract is **re-recorded at a NEW path**, which would split the two resolution paths | ``M1b-4 the interface contract cannot be RE-RECORDED AT A NEW PATH while the initiative stands`` | `assert.equal(r.code, 1, 'relocating the contract of an initiative feature must be refused');` |

**M1b-4 is load-bearing for row 1, not a bonus.** Both siblings bind the contract **by path** — the
secondary through the reference `feature start` pinned, the primary through its own recorded
artifact. A relocation moves only the primary's half: the old file stays on disk, stays hash-valid,
and the sibling keeps binding a contract that is no longer the initiative's, with no signal
anywhere in its repository. Without the writer-side refusal, *"a contract edit falls BOTH
siblings"* would be true only of **in-place** edits, and row 1 would be asserting a guarantee the
kernel does not have. The test asserts the counterfactual rather than arguing it:

```
assert.equal(readFileSync(p.contractPath, 'utf8'), CONTRACT_V1);
assert.notEqual(readFileSync(relocated, 'utf8'), CONTRACT_V1);
```

### 1(g) THE M1a REGRESSION PIN — a non-initiative feature is byte-identical to before

`test/acceptance/m1b-fixtures.test.mjs` ·
**``M1b-3 a NON-initiative feature's spec subject is sha256(spec bytes) alone — even holding a contract artifact``**

The adversarial half is that the feature **has recorded a contract artifact** and still carries no
initiative block: a clause keyed off the artifact rather than the block would fire here and change
the subject of a feature that never opted in — an observable behaviour change to non-initiative
features, which is M1b's red line.

```
assert.equal(h.readTasks().approvals.spec.subjectHash, sha256(readFileSync(specPath)),
  'the pre-T33 formula, byte for byte: spec bytes alone');
```

```
assert.equal(h.legion('state', 'stage-complete', 'spec').code, 0,
  'a contract edit must be invisible to a feature that never joined an initiative');
```

```
assert.equal(h.legion('state', 'stage-enter', 'build').code, 0,
  'and the prefix re-derives satisfied whatever the contract file does');
```

M1b-4's second positive control pins the same red line at the **writer**: a feature with no block
relocates its contract artifact as freely as any other artifact, so the refusal is gated on the
**block**, never on the kind.

```
assert.equal(moved.code, 0, `a non-initiative feature's contract artifact moves freely: ${moved.stderr}`);
```

---

## 2. A by-reference record on a missing or mismatched recap refuses `stage-complete intake` — COVERED (T32)

The by-reference clause is the **one** additive prerequisite in the whole layer (§State
`stage-complete intake`, rev 6): for a SECONDARY the recap-and-agreement half may be satisfied by
the recap reference validating **now**. What keeps the guarantee real is that the reference is
re-derived on **every** call — a stored "yes, this validated once" would be exactly the stored
conclusion §State's facts-not-conclusions rule exists to prevent.

### 2(a) The recap FILE is GONE

`test/cli/initiative.test.mjs` ·
**``by-reference intake REFUSES when the primary's recap is deleted, naming the path and the remedy``**

```
assert.equal(r.code, 1);
assert.match(r.stderr, /recap REFERENCE does not validate/);
assert.ok(r.stderr.includes(pair.recapPath), 'the refusal names the referenced path');
assert.match(r.stderr, /GONE/);
assert.match(r.stderr, /decision-record intake/, 'and the remedy: re-agree in THIS feature');
assertUnmoved(sec.dossier, snap, 'refused by-reference intake (recap deleted)');
```

closed by the **"alternative, not replacement"** positive control — a secondary that held its own
recap conversation is not punished for the primary's missing file:

```
assert.equal(sec.legion('state', 'decision-record', 'intake').code, 0);
assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
```

### 2(b) The recap HASH no longer matches — and both hashes are named

`test/cli/initiative.test.mjs` ·
**``by-reference intake REFUSES on an EDITED recap, naming both hashes``**

```
assert.equal(r.code, 1);
assert.match(r.stderr, /CHANGED/);
assert.ok(r.stderr.includes(before), 'names the hash the reference was derived against');
assert.ok(r.stderr.includes(after), 'and the live hash it no longer matches');
assertUnmoved(sec.dossier, snap, 'refused by-reference intake (recap edited)');
```

positive control, and it is the sharp form — **restoring the exact bytes accepts again**, so the
reference is a claim about content rather than about a file's mtime or its existence at some
earlier moment:

```
assert.equal(sha256(readFileSync(pair.recapPath)), before, 'restored byte-for-byte');
assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
```

**GONE and CHANGED are deliberately DISTINGUISHED** in the refusal text — their remedies differ —
and both name the path. That is asserted above, not assumed.

### 2(c) A block that claims the role while carrying nothing to validate

`test/cli/initiative.test.mjs` ·
**``a hand-edited block with no usable recap reference FAILS CLOSED at stage-complete intake``**

The dangerous reading is "no reference ⇒ nothing to check ⇒ pass". The role alone opens the
alternative arm; whether the reference is **usable** is a separate question, and it fails closed:

```
assert.equal(r.code, 1, 'a role with no reference must never satisfy the row');
assert.match(r.stderr, /carries no usable recap reference/);
assertUnmoved(sec.dossier, snap, 'refused by-reference intake (malformed block)');
```

### 2(d) THE THREAT MODEL'S CENTRE — a recap edited AFTER intake completed poisons the PREFIX

The case that matters most for "a secondary built against a stale agreement", because it is the one
a stored completion would silently pass:

`test/cli/initiative.test.mjs` ·
**``a recap edited AFTER intake completed poisons the PREFIX — the next forward stage-enter refuses``**

```
assert.equal(r.code, 1, 'a completed stage is a fact about evidence that no longer holds');
assert.match(r.stderr, /stage 'intake' does not re-derive satisfied/);
assert.match(r.stderr, /CHANGED/);
assertUnmoved(sec.dossier, snap, 'refused stage-enter after a recap edit');
```

The cross-**repository** form of the same claim is driven end to end in
**``THE DRIVING CASE: the link spans REPOSITORIES — a secondary in the FE repo finds the BE primary``**:

```
assert.equal(hop.code, 1, 'a recap edited in the OTHER repo must poison this feature\'s prefix');
```

### 2(e) What the alternative must NOT weaken — the four controls

| claim | test | decisive assertion |
|---|---|---|
| an **ordinary** feature still needs its own intake approval | ``a SECONDARY completes intake with NO intake approval — the recap reference validates now`` | `assert.equal(p.code, 1, 'a non-initiative feature must still need its own intake approval');` |
| **classification is never by reference** | ``CLASSIFICATION IS NEVER BY REFERENCE — a valid recap ref does not excuse an unclassified profile`` | `assert.match(r.stderr, /profile is 'unclassified'/);` |
| the **intent-artifact** clause stays per-feature | ``the INTENT-ARTIFACT clause stays per-feature — a secondary with a valid ref still records its own`` | `assert.match(r.stderr, /no intent artifact recorded/);` |
| the reference survives the primary being **abandoned** (§Startup: abandon never deletes a dossier) | ``the reference survives the primary being ABANDONED — abandon never deletes a dossier`` | `assert.ok(existsSync(pair.recapPath), 'abandon must not delete the dossier');` |

### 2(f) The EARLIER gate — the link is refused before a bad reference can exist

The by-reference row is the last line of defence, not the first. `feature start --initiative` will
not mint a reference at all unless the primary has recorded the recap **and** the contract **and**
the human has agreed the recap, and each refusal leaves **no trace** (no manifest, no worktree, no
branch — the T17/R18 rule):

```
assert.match(s.r.stderr, /holds no hash-valid intake approval over its recap/);
assert.ok(s.r.stderr.includes(recapPath), 'the refusal names the recap nobody has agreed');
assert.match(s.r.stderr, /legion state decision-record intake/, 'and the op that records the agreement');
assertNothingStarted(h, s);
```

(``a secondary is refused while the primary has NOT AGREED its own recap — the human gate is not
deleted``, plus ``a primary whose recap DRIFTED since it was agreed cannot be linked either — a
stale approval is no agreement`` and ``a secondary is refused when the primary's recap FILE is
gone, not merely unrecorded``.)

---

## Kernel-hermetic vs prose-borne — the honest split

**KERNEL-HERMETIC** (a test drives the real bin and a refusal is asserted; everything in rows 1 and
2 above):

- the spec subject binds the contract's **live** bytes, per role, for both siblings;
- both siblings' spec approvals fall on a contract edit, and every prefix-reading stage with them;
- the contract path is immutable for the life of the initiative block;
- non-initiative features are unchanged, at the reader **and** at the writer;
- the by-reference intake alternative, its GONE/CHANGED refusals, its re-validation on every call,
  and the four things it does not weaken;
- every link-time refusal at `feature start`, each leaving no trace;
- the role/primary/reference **derivation** (no caller-supplied hashes anywhere) and the
  scan-derived sibling grouping.

**PROSE-BORNE** (no kernel surface can tell the honest form from the dishonest one; recorded here
as such rather than papered over with a test of a call both forms make identically):

1. **That the interface contract contains the right thing** — endpoints, payloads, error shapes,
   and nothing that is one repository's business alone (`skills/feature/SKILL.md` intake step 6).
   The kernel hashes bytes; it cannot read a contract.
2. **That the shared intake is genuinely ONE intake over N repos** — one recap conversation with
   the human, covering the whole split, once (`skills/feature/SKILL.md` intake steps 6–7). The
   kernel sees an `intent` artifact and an approval; a per-repo recap and a shared one look
   identical to it.
3. **That a SECONDARY session does not hold a second recap** — the ceremony §Initiatives names
   explicitly (`skills/feature/SKILL.md`, the secondary paragraph after intake step 9). Recording
   its own `decision-record intake` also satisfies the row, and *should* when the recap has moved,
   so the kernel cannot distinguish diligence from ceremony here.
4. **That the operator starts the siblings, and in a sensible order.** Sequencing is human by
   design and there is **no dependency enforcement between siblings** (decision 14: bought on
   demonstrated need, not now). Nothing tests an ordering nothing enforces.
5. **That the architect plans against the contract and treats a contract change as a spec-level
   change** (`agents/architect.md` Inputs). An agent prompt is prose; the kernel's half of it — the
   approvals actually falling — is row 1.
6. **That the layer stays dark.** "Do not manufacture a cross-repo initiative to exercise it" is a
   discipline, not a guard. `skills/feature/SKILL.md` intake step 6 and `skills/start/SKILL.md`
   step 3 carry it; `test/plugin-manifest.test.mjs` ·
   ``the multi-repo intake form lands the mechanics and fences M1b out`` pins that the sentences
   are still there and still say the acceptance is open — which is a check on the **prose**, not on
   behaviour, and is recorded as such.

---

## Mutation record

**CARRIED OVER, not re-run by T34.** T34 changes no product code, so re-running these mutants would
re-measure the same trees T32 and T33 already measured. Each row names the commit whose task
applied it, so the claim is auditable rather than inherited on trust. Sources were reverted and
verified clean by the tasks that applied them.

### T32 — the link and the by-reference clause (`6bf8906`, fixes `ba7eea7`)

| # | Mutant | Result |
|---|---|---|
| M-T32-1 | `initiativeRefValid`: delete the `live !== ref.hash` comparison (existence alone "validates") | **KILLED** by 2 — ``by-reference intake REFUSES on an EDITED recap`` and ``a recap edited AFTER intake completed poisons the PREFIX`` |
| M-T32-2 | `deriveInitiativeRef`: copy the primary's **recorded** hash instead of deriving from the bytes | **KILLED** by 1 — ``a primary artifact edited since it was recorded binds the secondary to the LIVE bytes, loudly`` |
| M-T32-3 | `scanProjectFeatures`: drop the self-exclusion | **KILLED** by 2 — ``a restarted primary is not made a secondary of itself``, ``feature status renders the initiative grouping`` |
| M-T32-4 | narrow the scan back to the caller's own project | **KILLED, and exclusively** — ``THE DRIVING CASE: the link spans REPOSITORIES`` only |
| M-T32-5 | `if (false)` over the primary's intake-approval check at link time | **KILLED** by both agreement cases — ``the human gate is not deleted``, ``a primary whose recap DRIFTED`` |

M-T32-4 is the one worth re-reading. The pre-fix code scanned only the caller's project, and a
legion project is **exactly one repository** — so `--initiative <id>` typed in the FE repo derived
a **second primary**, exited 0 and printed `initiative: <id> (primary)`. A success line the code did
not deliver, with the secondary role, both references and the whole contract cascade unreachable
for every real initiative. That it is killed *exclusively* by the cross-repository case is the
evidence that a same-project fixture would have proven the weaker thing.

### T33 — the spec-subject binding (`58cb5c9`, fix `30e3db7`)

| # | Mutant | Result |
|---|---|---|
| M-T33-1 | contract bytes dropped from the spec subject | **KILLED** — `M1b-1` fails |
| M-T33-2 | the secondary binds the **recorded** ref hash, not the live bytes | **KILLED** — `M1b-1`, `M1b-2` fail |
| M-T33-3 | the PRIMARY resolves no contract (secondary-only arm) | **KILLED** — `M1b-1`, `M1b-2` fail |
| M-T33-4 | the clause keys off the **artifact** instead of the **block** | **KILLED** — `M1b-3` fails (the M1a red line) |
| M-T33-5 | the `':'` framing separator dropped from the two-digest subject | **KILLED** — `M1b-1` fails |
| M-T33-6 | an unknown role binds nothing (the fail-**open** reading) | **KILLED** — `M1b-2b` fails |
| M-T33-7 | the contract-relocation guard removed | **KILLED** — `M1b-4` fails at the refusal |
| M-T33-8 | the same guard un-gated from the initiative block (fires for every feature) | **KILLED** — `M1b-4` fails at the **non-initiative** control |

M-T33-4 and M-T33-8 are the pair that matter for M1a: one over-binds at the reader, the other
over-refuses at the writer, and each is killed by the regression pin rather than by a cascade case.
Thirteen mutants across both tasks (five from T32, eight from T33), thirteen killed, none
surviving.

---

## Findings raised by this audit

1. **A PIN THAT HAD TO BE RE-AIMED, and it was pinning a sentence the build made false.**
   `test/plugin-manifest.test.mjs` · ``the multi-repo intake form lands the mechanics and fences
   M1b out`` asserted `/no sibling features[\s\S]{0,200}M1b/` against
   `skills/feature/SKILL.md`'s intake stage — i.e. it pinned the pre-c10 fence *"create no sibling
   features, no initiative links, no by-reference intake records and no interface contract — that
   is M1b"*. T32/T33 built exactly those mechanics, so keeping the assertion would have required
   keeping prose that is now false. It was **re-aimed, not relaxed**: four assertions where there
   was one — the contract-recording op, the `--initiative <id>` flag, the SHIPS-DARK fence, and
   `acceptance stays **open**`. The test name is unchanged (a rename here would be
   indistinguishable from a rename-to-pass) and it is still accurate in substance: what the fence
   now fences out is driving a **real** initiative, which is M1b's deferred acceptance. This is the
   only file outside prose and this ledger that T34 touched, and it is recorded here so the change
   is visible rather than discovered.
2. **`legion finalize` and `close delivered` inherit the contract binding BY READING, not by a
   test.** Row 1's dependents are proven at `stage-complete plan` and the forward `stage-enter
   build`. finalize and `close delivered` call the same `unsatisfiedPrefix` and the same
   `computeSubjectHash`, and nothing in T33 touched their code — which is a sound argument and not
   an assertion. The reason no row drives them is honest and worth stating: both need a green
   boundary receipt, a verified MR read-back and a full lifecycle prefix, so a case would be an
   order of magnitude more setup for a claim that rides one shared formula. Recorded as a residual;
   a cheap later add would be a single case that walks an initiative sibling to `finalize` and
   edits the contract underneath it.
3. **The prose-borne list is longer than M1a's, and structurally so.** Five of the six entries
   above are about *what a human and a session do around* the layer — one recap, one contract, the
   operator starting siblings — because §Initiatives deliberately put cross-repo **above** the
   kernel. That is the design working, not a coverage gap, but it means the fixture track can never
   be the whole of M1b: the attended run is where items 1, 2 and 4 are actually judged. This is the
   ships-dark row restated from the evidence side.
4. **Sibling enumeration is derived by SCAN; PLAN-V3 §Initiatives' literal block shape lists
   `siblings: [feature ids]`.** T32 deviated deliberately (a stored list is a conclusion that
   outlives its evidence, and writing one into a sibling's manifest would be a cross-manifest
   read-modify-write on a file with no CAS) and proposed the amendment in its task return. The
   deviation is **asserted** rather than merely argued —
   ``assert.ok(!JSON.stringify(sec.readFeature()).includes('siblings'), 'no siblings[] is ever
   written');`` and ``assert.ok(!primarySnap.feature.includes('siblings'), 'least of all in the
   PRIMARY\'s manifest');`` — so if the operator rules the other way, this ledger and those
   assertions are what have to change together. Restated here because a ledger is where a reader
   goes looking for what the evidence actually says.

**Cited, not re-reported** (already on HANDOFF's record): the c9 notes (RR1 × tree-bound milestone
verdicts, the `args.profile` whitelist, the full-profile codex-consult gap), the T12b residual, and
M0 row 8's live-only conventions. M0's and M1a's own rows are out of this track's scope by
construction.
