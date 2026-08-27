<!--
  Required Pull Request description.

  This template is short on purpose: long templates get answered with "yes"
  on every box and answered with nothing on the free-text fields. The
  reviewer needs the answers; the boxes help the author think about the
  reviewer.
-->

## What changed, and why

<!-- One paragraph. State the behaviour the change introduces and the
behaviour it replaces. If the commit message already says it, link the
commit and skip the rest. -->

## Test evidence

<!-- What you ran locally, and what passed. CI is required to be green
before merge; this section is for the runs that decided to push. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm --filter @shikoo/dashboard e2e` (when the change is user-facing)
- [ ] `docker build` + `docker run` smoke (when the change touches the image)

## Touched a critical surface?

<!-- These are the surfaces where a mistake costs money, trust, or both.
A "yes" anywhere triggers a review note and a CodeRabbit pass on the
.coderabbit.yaml path-instructions for that surface. -->

- [ ] Money (IRR, wallet, partial unique indexes, reconciliation)
- [ ] Migrations (a new numbered file, an edit, a backfill)
- [ ] Authentication or sessions (login, TOTP, cookie, lockout)
- [ ] Permissions (a route guard, a `mayRead` change, a role new to the panel)
- [ ] SMS parsing (a new bank, a new format, a digit-normalisation rule)

If any is checked, name the affected file or migration number here:

## Migration and rollback impact

<!-- New migration file? Rollback story: drop column on a follow-up,
reverse direction on a one-way move, what stays read-only after. Existing
migration edited? Refuse the change unless the schema ledger has been
baselined. -->

## Threat-model impact

<!-- What a reasonable adversary can now do that they could not before.
If the answer is "nothing", say so. Threat-model.md is the reference;
this section is for anything that should land in a new revision of it. -->

## Screenshots (UI only)

<!-- The Playwright suite covers the panels it knows about. If you built a
new screen or changed the layout of an existing one, attach a screenshot
in light and dark theme; reviewers cannot run the build and look. -->