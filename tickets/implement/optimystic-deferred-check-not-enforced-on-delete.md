description: Protected rows (like a strand admin) can be deleted without a valid signature because the schema's delete-authorization rules were never told to run on delete. Add the missing "on delete" to the two authorization checks so deletes are rejected when unauthorized.
prereq:
files: ../sereus/schemas/strand.qsql, ../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts, ../sereus/schemas/control.qsql, ../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/planner/building/delete.ts
difficulty: easy
----

## Root cause (corrected from the fix ticket's hypothesis)

The fix ticket hypothesized the omission was in the optimystic vtab transactor or in
Quereus's `xUpdate` orchestration. **Research disproves both.** The defect is a
**schema-authoring omission in the sereus Strand schema** — not in optimystic and not in
Quereus.

Causal chain, fully traced through the engine:

1. A Quereus `CHECK` carries an **operations bitmask** (`RowConstraintSchema.operations`,
   `packages/quereus/src/schema/table.ts:524`). A bare `check (expr)` with no `on …` clause
   defaults to `DEFAULT_ROWOP_MASK = RowOpFlag.INSERT | RowOpFlag.UPDATE`
   (`table.ts:478`, via `opsToMask([])`). **DELETE is deliberately excluded.**
2. Enforcement filters by that mask: `shouldCheckConstraint` returns
   `(constraint.operations & operation) !== 0` (`constraint-builder.ts:23-26`).
3. The DELETE plan path is **not** missing constraint wiring — `buildDeleteStmt`
   (`planner/building/delete.ts:208-255`) already calls `buildConstraintChecks(…, RowOpFlag.DELETE, …)`
   and constructs a `ConstraintCheckNode` with `RowOpFlag.DELETE`, expanding the OLD/NEW
   flat row exactly like INSERT/UPDATE. It simply has nothing to evaluate, because every
   default-mask CHECK is filtered out for DELETE at step 2.
4. This is **documented, intentional, SQL-standard behavior**, not a bug:
   - `docs/sql.md:1143` — "`check (expr)` is enforced on INSERT and UPDATE by default;
     `check on {insert | update | delete}[,...]` restricts the operations."
   - `docs/architecture.md:247` cites **issue #23 "CHECK `on delete` mask drop"** as a
     declarative-equivalence regression fingerprint — i.e. `on delete` is a deliberately
     supported, tested opt-in feature.
   - The optimizer's row-invariant gate (`docs/optimizer.md:1552`) is built on the
     assumption that delete membership in a CHECK mask is opt-in.

So insert-side enforcement works (INSERT is in the default mask) and delete-side does not
(DELETE is not) — exactly the asymmetry the fix ticket observed. **Nothing in optimystic or
Quereus needs to change.**

## The actual defect: `strand.qsql` forgot `on delete`

`Authority.Authorized` is clearly *authored to gate deletes* — its second branch
(`old.MemberKey is not null and old.MemberKey = context.AuthorityKey and verify(old.MemberKey…)`)
only makes sense on a DELETE (on INSERT, `old.*` is NULL). But it is declared as a bare
`check (…)`, so it defaults to `insert|update` and never runs on DELETE. Same for
`MemberPeer.Authorized` (a bare `verify()` over `coalesce(new, old)`).

**The same schema author already does this correctly elsewhere.** `schemas/control.qsql`
gates its signed deletes with the right pattern:
- `CadrePeer.AuthorizedInsert check on insert, delete (…)` (control.qsql:58)
- a second `AuthorizedInsert check on insert, delete (…)` (control.qsql:95)
- `AuthorizedAddOrRemove check on insert, delete (…)` (control.qsql:127)
- with an explicit comment (control.qsql:145): *"defaults to insert+update; the check on
  insert, delete above excludes update"*.

This **resolves the fix ticket's CadreControl audit worry in the negative**: control.qsql's
signed deletes are already enforced — no change needed there. The gap is **Strand-only**.

## The fix

In **both** copies (they must stay byte-equivalent — see the header note in
`strand-schema.ts`):
- `../sereus/schemas/strand.qsql`
- `../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts` (the embedded
  `STRAND_SCHEMA` constant — `MemberPeer.Authorized` ≈ line 135, `Authority.Authorized`
  ≈ line 151)

change the two authorization checks from a bare mask to one that includes DELETE:

```
constraint Authorized check on insert, update, delete ( … )   -- Authority.Authorized
constraint Authorized check on insert, update, delete ( … )   -- MemberPeer.Authorized
```

(`on insert, delete` would also work and mirror control.qsql's CadrePeer split, but
`on insert, update, delete` preserves the existing insert+update coverage with a one-token
edit and no behavioral regression on the insert/update paths.)

### Do NOT touch the `*Exists` checks

Leave `MemberPeer.MemberExists` (and the other `…Exists` checks) on their default
`insert|update` mask. `MemberExists` reads `new.MemberKey`, which is NULL on a DELETE — if
DELETE were added to its mask, the subquery `M.Key = new.MemberKey` would match nothing and
**every** MemberPeer delete would be rejected. This is exactly the `removeMemberPeer`
hazard the fix ticket flagged; the surgical per-constraint op mask is what avoids it. Only
the `Authorized` checks get DELETE.

## Verification

- Existing reproduction:
  `../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` →
  *"KNOWN GAP: a non-authority removal currently SUCCEEDS …"*. After the schema fix, a
  `delete from Strand.Authority` with a null/garbage signature must **reject** (no branch of
  `Authority.Authorized` is satisfied once `(select count(1) from Authority) <= 1` is false)
  and the row count must stay 3.
- The downstream flip of that KNOWN-GAP test to `rejects.toThrow()` + unchanged count is
  tracked on the **sereus** board as `flip-strand-membership-rotation-known-gap` — coordinate
  the schema edit with that flip (the schema change is the prerequisite that makes the flip
  pass).
- **Secondary observation to verify** (fix ticket flagged it): a bogus-signature
  `MemberPeer` delete previously "neither threw nor removed the row." With
  `MemberPeer.Authorized` now on `…, delete`, a bad-signature delete must **throw** (and a
  good-signature delete must remove the row). Re-run the probe and confirm the earlier
  "silent no-op" was just the unenforced mask — if a good-signature delete still fails to
  remove the row after the mask fix, that IS a real engine/vtab delete bug and should be
  split into a new fix ticket (it would not be the schema omission this ticket addresses).

## Scope / commit note

These edits land in the **sereus** repo (`C:\projects\sereus`), a sibling of optimystic, not
inside the optimystic working tree. The optimystic runner commits only optimystic's tree, so
the sereus schema change must be committed on the sereus side. The fix ticket listed the
`../sereus/...` paths in its `files:` header, so cross-repo editing was anticipated; just be
aware the optimystic commit will not capture the sereus diff. If your harness cannot commit
sereus from this board, hand the one-line schema edit + test flip to the sereus board
(it already owns `flip-strand-membership-rotation-known-gap`).

## TODO

- [ ] In `../sereus/schemas/strand.qsql`, change `Authority.Authorized` and
      `MemberPeer.Authorized` from `check (…)` to `check on insert, update, delete (…)`.
- [ ] Mirror the identical edit in the embedded `STRAND_SCHEMA` constant in
      `../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts`; keep the two byte-equivalent.
- [ ] Leave every `…Exists` check (esp. `MemberPeer.MemberExists`) on its default mask — do
      not add DELETE to them.
- [ ] Run `strand-membership-peer-rotation.spec.ts`; confirm the unauthorized Authority
      delete now rejects and the count stays 3. Coordinate the KNOWN-GAP→`rejects.toThrow()`
      flip with the sereus `flip-strand-membership-rotation-known-gap` ticket.
- [ ] Verify the secondary `MemberPeer` delete observation (bad sig → throws; good sig →
      removes). If a good-signature delete still no-ops after the mask fix, file a new fix
      ticket for a genuine delete-path bug — out of scope here.
- [ ] No optimystic / Quereus code change. (Engine is correct by design; this entry exists
      only to record that the `table.ts` / `constraint-builder.ts` / `delete.ts` paths were
      audited and confirmed correct.)
