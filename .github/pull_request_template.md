## What changed

<!-- Short description -->

## Verification

- [ ] `npm run verify`
- [ ] `npm pack && npm run package:smoke` (if publish surface changed)
- [ ] No secrets / local paths committed
- [ ] Docs updated if behavior changed

## Live verification

- [ ] Not required
- [ ] Live E2E workflow (`workflow_dispatch`) on trusted main commit
- [ ] Local: `npm run e2e:reliability`

## Release impact

- [ ] None
- [ ] Patch
- [ ] Minor
- [ ] Major
