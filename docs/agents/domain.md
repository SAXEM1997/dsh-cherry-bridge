# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `GLOSSARY.md` and one `docs/adr/` at the repo root. There is no per-context split — this is not a monorepo, and no `GLOSSARY-MAP.md` is used.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root: the domain vocabulary this project actually uses.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

**Neither exists yet.** They are created lazily — `/domain-modeling` writes the first glossary entry or the first ADR when a term or a decision is actually resolved. Until then, proceed silently: don't flag their absence and don't create them upfront.

## File structure

Single-context repo (this repo):

```
/
├── GLOSSARY.md            ← created with the first resolved term
├── docs/
│   ├── adr/               ← created with the first ADR
│   │   ├── 0001-….md
│   │   └── 0002-….md
│   └── agents/            ← this setup: issue tracker, triage labels, domain docs
├── src/
└── …
```

`GLOSSARY.md` and `docs/adr/` are domain documentation, not process records; `docs/superpowers/**` and `docs/agents/**` stay internal and are never published with the package.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
