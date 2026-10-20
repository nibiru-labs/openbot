# Pi with a saved custom endpoint

OpenBot owns agent identity, the durable mailbox, task scheduling, permissions, and the tool bridge.
Pi owns the model and tool execution loop within one provider session. Its `steer` input is read
before a subsequent model call, after the current assistant turn has finished its tool calls.
It does not interrupt an in-flight model response or a running tool.

## Configuration

Keep the endpoint key in OpenBot's encrypted custom-provider settings. Configure the matching
provider and model in Pi's `models.json`. Use the variable returned by
`piProviderKeyVariable(endpointId)` as the `apiKey` environment reference, prefixed with `$`.
OpenBot supplies that variable only when it spawns Pi; it does not write an auth-file copy.
Pi's discovery and profile-generation clients receive the same mapping. Each spawn reads the
current saved keys, so a future process can use an updated key.

For MiniMax M Plan on the domestic endpoint, the tested configuration uses:

- Base URL: `https://api.minimax.cn/v1`
- API: `openai-completions`
- Model: `MiniMax-M3.1-Flash`
- Input: `text`, `image`; reasoning enabled, with low thinking for the pilot.

Do not set `reasoningEffort` to `none` for this model. Do not copy a key into `models.json`, a
launcher, a command-line argument, or a report. Custom headers are not mapped by this bridge.
Pi model capability and limit metadata must match the endpoint; OpenBot does not infer it from
an arbitrary custom model name. A provider switch starts or resumes its own provider session;
it does not transfer a running OpenCode turn to Pi.

## Workspace confinement

A confined Pi process can write its session directory and the lock directories used to read
`auth.json`, `models-store.json`, `trust.json`, and `settings.json`. It cannot change those files,
`models.json`, or shared extensions. Pi creates and removes the locks itself: the host must not
precreate a lock directory. Confined launches use `--no-approve`, so Pi ignores trust-gated project
settings and extensions. Explicit OpenBot MCP extensions remain available. Full-access launches
keep their existing trust behavior.

## Verification

Run the actual Pi process against the synthetic local service:

```sh
bun scripts/pi-custom-provider-e2e.ts /absolute/path/to/pi --confined
```

Use macOS for the confined case. The script keeps its fixture outside the system temporary
directory, verifies an authenticated model call, checks that no key was persisted in auth.json,
and attempts writes to the five shared configuration files through the real sandbox. It writes
`.openbot-build/pi-custom-provider-e2e/report.json`. It uses no real account or model credentials.
