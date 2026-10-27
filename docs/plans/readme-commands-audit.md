# Audit: README Commands vs Scripts

Audit of commands documented in `README.md` (specifically "Commands" and linked documentation) compared against `package.json` scripts and `scripts/`.

## Audit Table

| Command | Status | Fix |
| --- | --- | --- |
| `bun run dev` | Verified | None. Flags `--force`, `--shared`, `--isolated`, `--hosting=test` match `scripts/dev-services.ts`. Migration stamp behavior in `scripts/prepare-dev-environment.ts` verified. |
| `OPENBOT_SKIP_SKIA=1 bun install --frozen-lockfile` | Verified | None. Environment variable handled in `scripts/setup-mobile-skia.ts`. `bun run --cwd apps/mobile setup:skia` verified in `apps/mobile/package.json`. |
| `bun run preview` | Verified | None. Script matches `scripts/preview.ts`. |
| `bun run mobile:go` | Verified | None. Script delegates to `@openbot/mobile start:go` (`bunx expo start --go --clear`). |
| `bun mobile:ios` | Inconsistent syntax | Update to `bun run mobile:ios` for consistency with all other `bun run` commands in the table. Root `package.json` defines `"mobile:ios"`. |
| `bun run dev:mobile` | Verified | None. Flags `--pair-only`, `--simulator=<udid>`, `--port=<n>` match `scripts/dev-mobile.ts`. Update inner reference `bun mobile:ios` to `bun run mobile:ios`. |
| `bun run mobile:ios:build:local` | Verified | None. Matches `@openbot/mobile ios:build:local`. |
| `bun run mobile:ios:release:testflight` | Verified | None. Matches `@openbot/mobile ios:release:testflight`. |
| `bun mobile:ios:rocketsim` | Inconsistent syntax | Update to `bun run mobile:ios:rocketsim` for consistency. Root `package.json` defines `"mobile:ios:rocketsim"`. |
| `bun run mobile:go:tunnel` | Verified | None. Matches `@openbot/mobile start:go:tunnel`. |
| `bun run dev:api` | Verified | None. Matches `scripts/dev-services.ts api`. |
| `bun run dev:apns-key -- <AuthKey_ID.p8> [KEY_ID]` | Verified | None. Arguments match `scripts/dev-apns-key.ts`. |
| `bun run api:start` | Verified | None. Matches `@openbot/auth-api start`. |
| `bun run api:images` | Verified | None. Matches `@openbot/auth-api images`. |
| `bun run api:migrate:local` | Verified | None. Matches `@openbot/auth-api db:migrate:local`. |
| `bun run api:migrate:remote` | Verified | None. Matches `@openbot/auth-api db:migrate:remote`. |
| `bun run api:deploy` | Verified | None. Matches `@openbot/auth-api deploy`. |
| `bun run api:stripe:bootstrap` | Verified | None. Flag `--live` matches `scripts/stripe-bootstrap.ts`. Webhook path `/v1/stripe/webhook` verified. |
| `bun run hosting:setup --target=production\|test` | Verified | None. Flag `--target=production\|test` matches `scripts/hosting/setup-account-server.ts`. |
| `bun run hosting:template` | Verified | None. Flags `--version`, `--appimage-url`, `--appimage-sha256`, `--auth-api-url` and env `BOAT_TEMPLATE_API_KEY` match `scripts/hosting/build-boat-template.ts`. |
| `bun run status:build` | Verified | None. Matches `@openbot/status build`. |
| `bun run status:smoke` | Verified | None. Matches `scripts/status-page-smoke.ts`. |
| `bun run remote:up` | Verified | None. Matches Docker Compose invocation in `remote/`. |
| `bun run remote:check` | Verified | None. Matches `remote/scripts/check.ts`. |
| `bun run remote:check:compose` | Verified | None. Matches `remote/scripts/check.ts --compose`. |
| `bun run remote:update` | Verified | None. Matches `remote/scripts/update.ts`. |
| `bun run dev:all` | Verified | None. Matches `scripts/dev-services.ts all`. |
| `bun run dev:slack` | Verified | None. Matches `scripts/dev-services.ts app --slack`. Accepts `--shared`. |
| `bun run dev:test-client` | Verified | None. Matches `scripts/dev-services.ts test-client`. |
| `bun run dev:seed` | Verified | None. Flags `--if-missing`, `--scale=...`, `--dry-run`, `--help` match `scripts/seed-dev-state.ts`. |
| `bun run dev:reset` | Verified | None. Script `scripts/reset-dev-state.ts` takes no options, handles `--help`. |
| `bun run dev:status` | Verified | None. Flags `--pid=<supervisor pid>`, `--all` match `scripts/dev-stack.ts status`. |
| `bun run dev:verify` | Verified | None. Flag `--run` matches `scripts/dev-verify.ts`. |
| `bun run dev:stop` | Verified | None. Flags `--pid=<supervisor pid>`, `--all` match `scripts/dev-stack.ts stop`. |
| `bun run dev:forget` | Verified | None. Flags `--pid=`, `--all` match `scripts/dev-stack.ts forget`. |
| `bun run storybook` | Verified | None. Env `OPENBOT_STORYBOOK_PORT` and `--port` refusal match `scripts/dev-storybook.ts`. |
| `bun run build-storybook` | Verified | None. Env `OPENBOT_STORYBOOK_CHECK=true` handled by Storybook config. |
| `bun run dev:automation` | Verified | None. Commands (`instances`, `pages`, `snapshot`, `screenshot`, `click`, `type`) and flags (`--page=`, `--wait-for=`, `--allow-mutations`, `--instance=`, `--port=`) match `scripts/dev-automation/cli.ts`. |
| `bun run dev:cpu` | Verified | None. Flags `--duration=`, `--interval=`, `--label=`, `--out=`, `--compare=` match `scripts/dev-automation/cli.ts cpu`. |
| `bun run dev:memory` | Verified | None. Flags `--label=`, `--out=`, `--heap-snapshot=` match `scripts/dev-automation/cli.ts memory`. |
| `bun run dev:bench` | Verified | None. Flags `--scenario=`, `--runs=`, `--label=`, `--compare=`, `--cpu-profile`, `--frames`, `--call-counts` match `scripts/dev-automation/bench.ts`. |
| `bun run check` | Verified | None. Aggregates desktop static checks, browser smoke, API checks, and vitest desktop suite. |
| `bun run typecheck` | Verified | None. Parallel execution of all 15 `typecheck:*` project targets verified. |
| `bun run knip:check` | Verified | None. Runs root `knip`. |
| `bun run check:ui` | Verified | None. Matches `scripts/ui-foundation-check.ts`. |
| `bun run check:assets` | Verified | None. Matches `scripts/check-image-assets.ts`. |
| `bun run check:doc-links` | Verified | None. Matches `scripts/check-doc-links.ts`. |
| `bun run verify:preload` | Verified | None. Matches `scripts/verify-preload-bundle.ts`. |
| `bun run types:ratchet` | Verified | None. Flags `--write`, `--add=<option>` match `scripts/type-ratchet.ts` / `scripts/debt-ratchet.ts`. |
| `bun run i18n:check` | Verified | None. Flags `--fix`, `--json` match `scripts/i18n-check.ts`. |
| `bun run test:backend` | Verified | None. Runs `vitest run src/backend`. |
| `bun run test:changed` | Verified | None. Runs `vitest run --changed origin/main --maxWorkers=1`. |
| `bun run test:related -- <source>...` | Verified | None. Runs `vitest related --run --maxWorkers=1`. |
| `bun run test:browser` | Verified | None. Scenarios `--scenario=controls`, `--scenario=tool-boundary`, `--scenario=evaluation`, `--scenario=wait-deadlines`, `--scenario=popups` match `scripts/browser-smoke-electron.ts`. |
| `bun run test:codex` | Verified | None. Runs `scripts/codex-doctor.ts --strict`. |
| `bun run test:durations` | Verified | None. Matches `scripts/test-durations.ts`. |
| `bun run cua-driver:doctor` | Verified | None. Env `OPENBOT_CUA_DRIVER_PATH` matches `scripts/cua-driver-doctor.ts`. |
| `bun run prepare:cua-driver` | Verified | None. Invokes `scripts/install-cua-driver.ts`. Mentioned alternate `bun scripts/install-cua-driver.ts <platform> <arch>` verified. |
| `bun run pin:cua-driver <version>` | Verified | None. Argument `<version>` matches `scripts/pin-cua-driver.ts`. |
| `bun run package` | Verified | None. Builds macOS unpacked app bundle. |
| `bun run package:verify` | Verified | None. Matches `scripts/verify-macos-package.ts`. |
| `bun run package:win` | Verified | None. Builds Windows unpacked application. |
| `bun run package:win:verify` | Verified | None. Matches `scripts/verify-windows-package.ts`. |
| `bun run package:linux` | Verified | None. Builds Linux unpacked application. |
| `bun run package:linux:arm64` | Verified | None. Builds Linux arm64 application. |
| `bun run package:linux:verify` | Verified | None. Matches `scripts/verify-linux-package.ts`. |
| `bun scripts/create-github-app.ts [--org <org>]` | Verified | None. Flag `--org <org>` matches `scripts/create-github-app.ts`. |
| `bun run release:preflight` | Verified | None. Matches `scripts/release-preflight.ts`. |
| `bun run dist:mac` | Verified | None. Builds DMG/ZIP artifacts. |
| `bun run dist:win` | Verified | None. Builds NSIS installer. |
| `bun run dist:linux` | Verified | None. Builds Linux x64 AppImage. |
| `bun run dist:linux:arm64` | Verified | None. Builds Linux arm64 AppImage. |
| `bun run release:patch` | Verified | None. Matches `scripts/prepare-release.ts patch`. |
| `bun run mobile:release:patch` | Verified | None. Matches `scripts/prepare-release.ts patch --mobile`. Mentions `mobile:release:minor` and `mobile:release:major`. |
| `bun run mobile:release:published <ios\|android\|both>` | Verified | None. Flag `--version x.y.z` and store targets match `scripts/publish-mobile-release.ts`. |
| `bun run test:acp-directories` | Verified | None. Matches `scripts/acp-additional-directories-e2e.ts`. |
| `bun run test:custom-agents` | Verified | None. Matches `scripts/custom-acp-agent-e2e.ts`. |
| `bun run test:mcp-tool-consent` | Verified | None. Matches `scripts/mcp-tool-consent-e2e.ts`. |
| `bun run test:ui-blocks` | Verified | None. Matches `scripts/ui-blocks-e2e.ts`. |
| `bun run test:filesystem` | Verified | None. Matches `scripts/filesystem-smoke.ts`. |
| `bun run test:imagegen` | Verified | None. Runs `scripts/filesystem-smoke.ts --provider codex --imagegen`. |
| `bun run test:workspace-only` | Verified | None. Flags `--provider <id>`, `--model <id>` match `scripts/filesystem-smoke.ts`. |
| `bun run test:provider-detection` | Verified | None. Matches `scripts/provider-detection-e2e.ts`. |
| `bun run test:storage-live` | Verified | None. Matches `scripts/provider-storage-smoke.ts`. |

### Other Commands in README.md

| Command | Status | Fix |
| --- | --- | --- |
| `bun run codex:doctor` (L217) | Verified | None. Matches `scripts/codex-doctor.ts`. |
| `bun run dev:bootstrap` (L224) | Verified | None. Matches `scripts/prepare-dev-environment.ts`. |
| `bun run dev --shared` (L247) | Verified | None. Flag handled by `scripts/dev-services.ts`. |
| `bun run dev:seed --dry-run` (L260) | Verified | None. Flag handled by `scripts/seed-dev-state.ts`. |
| `bun run marketplace:seed:local` (L266) | Verified | None. Matches `scripts/publish-production-catalog.ts --local --apply`. |
| `bun run marketplace:build` (L268) | Verified | None. Matches `scripts/build-production-catalog.ts`. |
| `bun run marketplace:publish:production` (L268) | Verified | None. Matches `scripts/publish-production-catalog.ts`. |
| `bun run release:minor` / `release:major` (L560) | Verified | None. Matches `scripts/prepare-release.ts`. |
| `sudo openbot-host setup --create-user <name>` (L595) | Verified | None. Matches `scripts/openbot-host.ts`. |
| `sudo openbot-host verify` (L596) | Verified | None. Matches `scripts/openbot-host.ts`. |
| `sudo openbot-host status [--json]` (L596) | Verified | None. Matches `scripts/openbot-host.ts`. |
| `sudo openbot-host watch` (L596) | Verified | None. Matches `scripts/openbot-host.ts`. |

### Commands in Linked Documentation

| Document | Command | Status | Fix |
| --- | --- | --- | --- |
| `docs/web-client.md` | `bun run dev:api` | Verified | None. |
| `docs/web-client.md` | `bun run storybook --no-open` | Verified | None. Passthrough flag supported. |
| `docs/web-client.md` | `bun run dev --isolated` | Verified | None. Accepted flag. |
| `docs/hosted-servers.md` | `bun run api:deploy:test` | Verified | None. Matches root and auth-api scripts. |
| `docs/hosted-servers.md` | `bun run hosting:setup --target=test\|production` | Verified | None. Matches `scripts/hosting/setup-account-server.ts`. |
| `docs/hosted-servers.md` | `bun run dev --hosting=test` | Verified | None. Matches `scripts/dev-services.ts`. |
| `docs/hosted-servers.md` | `bun scripts/stripe-flows-e2e.ts --print-user-ids` | Verified | None. Script and flag exist. |
| `docs/hosted-servers.md` | `bun run hosting:template --version=...` | Verified | None. Matches `scripts/hosting/build-boat-template.ts`. |
| `apps/mobile/README.md` | `bun run mobile` | Verified | None. Starts mobile dev server. |
| `apps/mobile/README.md` | `bun run mobile:ios` | Verified | None. Standard script invocation. |
| `apps/mobile/README.md` | `bun run mobile:android` | Verified | None. Matches root and mobile scripts. |
| `apps/mobile/README.md` | `bun run mobile:lint`, `mobile:typecheck`, `mobile:doctor` | Verified | None. All defined in `package.json`. |
| `apps/mobile/README.md` | `bun run mobile:ios:build:local` / `mobile:android:build:local` | Verified | None. Matches `package.json`. |
| `apps/mobile/README.md` | `bun run mobile:ios:release:testflight` / `mobile:android:release:play` | Verified | None. Matches `package.json`. |
| `docs/architecture/servers.md` | `bun run api:stripe:bootstrap` | Verified | None. Matches root script. |
| `docs/messaging.md` | `bun run dev:slack` | Verified | None. Matches `scripts/dev-services.ts app --slack`. |
| `docs/i18n.md` | `bun run i18n:check [--fix] [--json]` | Verified | None. Flags match `scripts/i18n-check.ts`. |
| `docs/i18n.md` | `bun scripts/i18n-fit-e2e.ts --storybook=<url>` | Verified | None. Script and flag exist. |
| `docs/i18n.md` | `bun scripts/i18n-e2e.ts --allow-mutations` | Verified | None. Script and flag exist. |
| `docs/development-checks.md` | `bun run test:desktop -- --shard=<n>/2` | Verified | None. Vitest accepts shard flag. |
| `docs/development-checks.md` | Focused test commands (`test:changed`, `test:related`, `test:backend`) | Verified | None. All match `package.json`. |
| `docs/development-checks.md` | E2E test commands (`test:signal`, `test:team-api-routes`, etc.) | Verified | None. All defined in `package.json`. |
