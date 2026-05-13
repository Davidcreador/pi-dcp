# Contributing

Thanks for considering a contribution. pi-dcp is a small, focused extension — most useful PRs will be one of:

- A bug fix with a regression test
- A new opencode-dcp feature we haven't ported yet
- Documentation improvements

## Setup

```bash
git clone git@github.com:Davidcreador/pi-dcp.git
cd pi-dcp
npm install --no-save typescript @earendil-works/pi-coding-agent
```

Pi auto-loads extensions from `~/.pi/agent/extensions/<name>/`. For live testing, symlink your clone:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-dcp
```

## Workflow

```bash
npm run check         # tsc --noEmit && node --test test/*.test.ts
```

CI runs the same command on Node 22 and 24. Anything that adds a non-trivial feature should land with a test.

## Code style

- Tabs for indentation (existing convention)
- TypeScript strict mode; avoid `as any` outside test code
- Every file has a top-of-file JSDoc explaining its role
- Public-facing functions document the **invariant** they protect, not just what they do
- Tests live next to their feature and use `node:test` + `node:assert/strict`

## Adding a new opencode-dcp feature

1. Add the config knob to `lib/config.ts` (interface + DEFAULT_CONFIG)
2. Wire it through the relevant module (pipeline / nudges / a tool / a command)
3. Add a test in `test/<area>.test.ts`
4. Update the **Configuration reference** + **How it differs from opencode-dcp** tables in `README.md`
5. Update `skills/pi-dcp/SKILL.md` if the feature is user-facing

Open a PR. Keep commits atomic so they can be reverted independently.

## Reporting issues

Please include:

- pi version (`pi --version`)
- pi-dcp commit (`cd ~/.pi/agent/extensions/pi-dcp && git rev-parse --short HEAD`)
- Your `config.json` (redact API keys)
- Last ~30 lines of `~/.pi-dcp/dcp.log` with `debug: true` set
