# Contributing

Thanks for interest in chatgpt-mcp.

## Before you start

- Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md)
- macOS is the supported development surface; Linux desktop is experimental
- Keep changes focused; prefer issues for large design proposals

## Development

```bash
npm install
npm run build
npm run typecheck
npm run check:unit         # typecheck + unit tests (CI merge bar)
npm run verify             # check:unit + build
npm run check          # needs CDP Chrome + worker for full green
```

Do not commit `.env`, SQLite databases, or Chrome profile data.

## Pull requests

1. One concern per PR when practical  
2. Run `npm run verify` before opening; use `npm pack && npm run package:smoke` if you changed publish surface  
3. Include a short test plan (commands run, platforms)  
4. Do not claim reliability numbers without linking the harness method (`npm run e2e:reliability` or Live E2E workflow)  
5. Update docs when behavior or setup steps change  

## Code of conduct

Be respectful. Harassment or abuse is not tolerated.
