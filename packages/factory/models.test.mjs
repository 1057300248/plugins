// JL on magpie's Discord (droid 0.240.0, plugin 0.1.24): droid and Factory
// desktop offer Haiku 5.5, droid through magpie didn't. The cases are droid
// 0.240.0's own registry entries, saved byte for byte in testdata.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin } from "./index.mjs"

const DROID = readFileSync(new URL("./testdata/droid-0.240.0-models.txt", import.meta.url), "utf8")

// entry is a model's registry text in the fixture.
function entry(id) {
  const line = DROID.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`))
  if (!line) throw new Error(`${id} is not in the fixture`)
  return line
}

// limits reads an entry's context and output as the plugin states them: a
// total context for P(context, output), the input for R({…}) and te({…}).
function limits(text) {
  let m = text.match(/contextLimits:P\((\d+),(\d+)\)/)
  if (m) return { context: +m[1], output: +m[2] }
  m = text.match(/contextLimits:R\(\{maxInputTokens:(\d+),maxOutputTokens:(\d+)\}\)/)
  if (m) return { context: +m[1], output: +m[2] }
  m = text.match(/contextLimits:(\w+),/)
  const def = DROID.match(new RegExp(`^${m[1]}=te\\(\\{[^}]*maxInputTokens:(\\d+),maxOutputTokens:(\\d+)\\}\\)`, "m"))
  return { context: +def[1], output: +def[2] }
}

async function models() {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  return cfg.provider.factory.models
}

test("Haiku 5.5 and Mistral Large 4 are offered as droid 0.240.0 has them", async () => {
  const got = await models()
  for (const id of ["claude-haiku-5-5", "mistral-large-4"]) {
    const text = entry(id)
    const m = got[id]
    expect(m).toBeDefined()
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    expect(m.limit).toEqual(limits(text))
    // droid's "off" is the request without a level; the rest are variants
    const efforts = JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1]).filter((e) => e !== "off")
    expect(Object.keys(m.variants)).toEqual(efforts)
  }
  expect(got["claude-haiku-5-5"].provider.npm).toBe("@ai-sdk/anthropic")
  expect(got["claude-haiku-5-5"].provider.api).toBe("https://api.factory.ai/api/llm/a/v1")
  expect(got["claude-haiku-5-5"].variants.medium).toEqual({ effort: "medium" })
  // Mistral Large 4 is on droid's generic chat completions, images on
  expect(entry("mistral-large-4")).toContain('apiModelProvider:"generic-chat-completion-api"')
  expect(entry("mistral-large-4")).toContain("images:!0")
  expect(got["mistral-large-4"].provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(got["mistral-large-4"].attachment).toBe(true)
})

test("every model in droid 0.240.0's picker is offered, or left out for a reason", async () => {
  const got = await models()
  const picker = JSON.parse(DROID.match(/^var y=(\[[^\]]*\]);/m)[1])
  const reason = {
    // droid picks these itself, client side
    auto: "router", "auto-fast": "router",
    // Gemini goes on a route of Factory's own
    "gemini-3.1-pro-preview": "gemini", "gemini-3.8-flash": "gemini", "gemini-3.7-flash": "gemini",
    "gemini-3.6-flash": "gemini", "gemini-3.5-flash": "gemini", "gemini-3-flash-preview": "gemini",
    // not released (unreleased:!0) or not in the registry
    "garnet-07-15": "unreleased", "atlas-07-21": "unreleased", "aster-07-15": "unreleased", inkling: "unreleased",
    // asks the user to accept Factory's high-cost terms first
    "gpt-6-astra-ultrafast": "opt-in",
    // older generations the plugin has never offered, as before
    "claude-opus-4-7": "older", "claude-opus-4-6": "older", "claude-opus-4-5-20251101": "older",
    "claude-sonnet-4-5-20250929": "older", "gpt-5.5-pro": "older", "gpt-5.4-mini": "older", "gpt-5.2": "older",
    "gpt-5.2-codex": "older", "gpt-5.1-codex-max": "older", "grok-4.5": "older", "kimi-k2.5": "older",
    "glm-5.1": "older", "glm-5": "older", "glm-4.7": "older",
    "deepseek-v4-flash-0731": "older", "deepseek-v4-pro": "older",
  }
  const missing = picker.filter((id) => !got[id] && !reason[id] && !/-fast$/.test(id))
  expect(missing).toEqual([])
  expect(entry("gpt-6-astra-ultrafast")).toContain('explicitOptInRequirement:{kind:"high_cost"')
  expect(got["gpt-6-astra-ultrafast"]).toBeUndefined()
})
