# macOS compatibility record

## Library upgrade 0.1.1

On Windows 11, Kimi 3.2.17.10, 2026-10-17: a disabled synthetic server placed in the ordinary desktop runtime's `runtime/kimi-code/home/mcp.json` appeared in the real authenticated `mcp.list` result. A synthetic skill placed in the ordinary desktop runtime's `skills` appeared in the real `skills.list` result. Both fixtures were removed and the original MCP bytes restored after the probe. No server command or skill was executed.

An isolated synthetic Kimi configuration and upgraded adapter forwarded a shared instruction through the upgraded Work provider to the actual Work service using the existing desktop sign-in. The streamed response was HTTP 200, completed with `[DONE]`, and returned the exact marker present only in the shared instruction. This was a bridge request, not a desktop UI-submitted turn. Neither running Magpie nor Kimi was switched during the test. Fourteen agent tests passed, covering hot instruction changes/removal, unreadable instruction refusal, native directory links, preservation and existing bridge behavior.

The same disabled MCP/skill discovery probe passed on macOS 26.6.2 arm64, ordinary Kimi 3.2.17 build 3.2.17.4, at 2026-10-17 04:37 UTC. Real `mcp.list` and `skills.list` both found their synthetic fixtures, then the original MCP bytes were restored and both fixtures removed. The 0.1.1 package created both directory symlinks in a temporary fixture; the 0.1.4 provider read the real desktop sign-in, returned `k3-agent` and `k2d8-preview`, and read one shared-allowance window. These calls did not execute an MCP command, invoke a skill or submit a desktop conversation. The earlier macOS inference record below remains the separate 0.1.0 record.

Observed at **2026-10-16 20:09 UTC** (2026-10-17 04:09 UTC+8): macOS 26.6.2 arm64; ordinary Kimi desktop **3.2.17, build 3.2.17.4** (`com.moonshot.kimichat`); official Magpie **0.1.1276**; Bun **1.4.3**. Agent runtime files were pinned to `dd3a8b889507f4c810e074acbb0dbf8a167ac99c` and checked against their Git blob SHA-256 values.

The user signed in to ordinary Kimi desktop and opened Work. Its real configuration was found at:

```text
~/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json
```

The real runner was at `agents/main/runner.state.json` relative to that directory, reported `running`, and had no active turns. The fields `credentials.kimiCode.apiKey`, `credentials.kimiCode.baseUrl`, `credentials.kimiWeb.accessToken` and `credentials.kimiWeb.userId` were present and nonempty. All credential values and the local control token remained on the Mac and are omitted here.

## What ran

1. Started official Magpie in a separate temporary `XDG_CONFIG_HOME` on an unused loopback port, with the Kimi Work provider from PR #171. The real desktop sign-in was read using the normal macOS home. The existing Magpie process/profile was not restarted or replaced.
2. Instantiated the submitted `KimiAdapter` with a temporary `stateDir`, its default macOS Kimi path, and the submitted `rpc` implementation. Calls went to Kimi's real authenticated local WebSocket endpoint, not a fixture. The actual methods `models.current`, `conversations.setModel`, `conversations.getKimiModelList` and `conversations.updateKimiModelList` all succeeded.
3. Connected with selected model `kimi-work/k3-agent`. The adapter reported `connected` with no catalog error, wrote its owned loopback address, and added the gateway's catalog to the real runtime. There were initially two native Kimi models.
4. Sent a synthetic authenticated HTTP request to the adapter's `/v1/chat/completions`, using the real Kimi credential only on that loopback hop. The adapter used Magpie's credential for the gateway hop. Official Magpie then invoked the real Kimi Work provider and service. The response was HTTP 200 with a complete SSE stream and exactly `KIMI_WORK_MAC_OK`. Magpie's route record named agent `kimi-desktop`, provider `kimi-work`, requested model `kimi-work/k3-agent` and served model `k3-agent`.
5. Stopped the adapter, verified the restoration results below, and stopped only the temporary gateway.

## Restoration observed

```json
{
  "baseRestored": true,
  "currentRestored": true,
  "nativeCatalogRestored": true,
  "credentialsUnchanged": true,
  "unrelatedSettingsPreserved": true,
  "noSyntheticModels": true,
  "modelSnapshotRemoved": true,
  "sandboxGatewayStopped": true
}
```

Configuration preservation here is a semantic comparison, not a claim about JSON whitespace. The credential-bearing document was held in memory for comparison only; it was never copied to a backup or uploaded. No app resources or model-menu injection patch were installed.

## Limits

The inference originated from a synthetic HTTP client at the bridge, **not a desktop UI-submitted Work conversation**. This proves the actual macOS control methods, configuration lifecycle and streamed adapter → official Magpie → real provider route; it does not prove desktop UI selection behavior. This run did not exercise Kimi search/fetch, SIGKILL, sleep/wake, natural token rotation or a future Kimi release. The Windows desktop UI observation is separate.

The private API failure/rollback behavior and manual recovery are documented in README. The disclosed split routing of inference to Magpie and search/fetch to Kimi remains a separate maintainer review point; the subscription-provider decision in #171 is not presented as a desktop UI or search/fetch test.
