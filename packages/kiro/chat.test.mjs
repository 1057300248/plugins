import { afterEach, expect, test } from "bun:test"
import { KiroAuthPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const auth = (access) => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3600000, profileArn: PROFILE, method: "social" })
const schema = (path, levels) => ({ properties: { [path]: { properties: { effort: { enum: levels, default: "max" } } } } })
const gpt = (levels) => ({ modelId: "gpt-test", modelName: "GPT Test", supportedInputTypes: ["TEXT", "IMAGE"],
  tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 10000 }, additionalModelRequestFieldsSchema: schema("reasoning", levels),
  accessToken: "RAW-CATALOG-SECRET", extra: { privateData: "RAW-CATALOG-SECRET" } })

// Synthetic AWS event frames, using the same framing as the existing Kiro tests.
function frame(kind, payload, exception = false) {
  const enc = new TextEncoder()
  const headers = { ":message-type": exception ? "exception" : "event", [exception ? ":exception-type" : ":event-type"]: kind }
  const hs = Object.entries(headers).map(([key, value]) => {
    const k = enc.encode(key), v = enc.encode(value), h = new Uint8Array(k.length + v.length + 4)
    h[0] = k.length; h.set(k, 1); h[k.length + 1] = 7
    new DataView(h.buffer).setUint16(k.length + 2, v.length); h.set(v, k.length + 4)
    return h
  })
  const hlen = hs.reduce((n, h) => n + h.length, 0), b = enc.encode(JSON.stringify(payload))
  const out = new Uint8Array(16 + hlen + b.length), view = new DataView(out.buffer)
  view.setUint32(0, out.length); view.setUint32(4, hlen)
  let offset = 12
  for (const h of hs) { out.set(h, offset); offset += h.length }
  out.set(b, offset)
  return out
}
const response = (...frames) => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close() } }))
const ok = () => response(frame("assistantResponseEvent", { content: "OK" }), frame("metadataEvent", { tokenUsage: { inputTokens: 2, outputTokens: 3 } }))
const call = (fetcher, body) => fetcher("https://runtime.us-east-1.kiro.dev/chat/completions", { method: "POST", body: JSON.stringify(body) })
const request = (more = {}) => ({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], ...more })

test("actual loader discovers schema, declares Chat, and preserves xhigh/max/none on the final wire", async () => {
  const seen = [], lists = []
  let active = auth("synthetic-A"), levelsA = ["none", "low", "high", "xhigh", "max"]
  globalThis.fetch = async (url, init) => {
    const bearer = init.headers.Authorization
    if (String(url).includes("/List-Available-Models")) {
      lists.push(bearer)
      return Response.json({ models: [gpt(bearer.endsWith("synthetic-A") ? levelsA : ["low"])] })
    }
    if (String(url).endsWith("/generateAssistantResponse")) { seen.push(JSON.parse(init.body)); return ok() }
    throw new Error("unexpected mock request " + url)
  }
  const hooks = await KiroAuthPlugin()
  const loader = await hooks.auth.loader(async () => active)
  const models = await hooks.provider.models({ models: {} }, { auth: active })
  expect(models["gpt-test"].api.npm).toBe("@ai-sdk/openai-compatible")
  expect(models["gpt-test"].variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
  expect(JSON.stringify(models)).not.toContain("RAW-CATALOG-SECRET")
  expect(JSON.stringify(models)).not.toContain("synthetic-A")
  for (const effort of ["xhigh", "max", "none"]) {
    const res = await call(loader.fetch, request({ reasoning_effort: effort }))
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("OK")
    expect(seen.at(-1).additionalModelRequestFields).toEqual({ reasoning: { effort } })
    expect(JSON.stringify(seen.at(-1))).not.toContain("RAW-CATALOG-SECRET")
    expect(JSON.stringify(seen.at(-1))).not.toContain("max_thinking_length")
  }
  expect(lists).toEqual(["Bearer synthetic-A"])
  active = auth("synthetic-B")
  expect((await call(loader.fetch, request({ reasoning_effort: "xhigh" }))).status).toBe(400)
  expect(seen).toHaveLength(3)
  expect(lists.at(-1)).toBe("Bearer synthetic-B")
  active = auth("synthetic-A")
  levelsA = ["low"]
  await hooks.provider.models({ models: {} }, { auth: active }) // explicit refresh replaces A, not B
  expect((await call(loader.fetch, request({ reasoning_effort: "xhigh" }))).status).toBe(400)
  expect(seen).toHaveLength(3)
})

test("Chat tool names, multi-turn results, images, streaming and usage share the existing Kiro path", async () => {
  const name = "mcp_" + "long_tool_name_".repeat(7), alias = _internal.toolName(name)
  const captured = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/List-Available-Models")) return Response.json({ models: [gpt(["xhigh", "max"])] })
    if (!String(url).endsWith("/generateAssistantResponse")) throw new Error("unexpected request")
    captured.push(JSON.parse(init.body))
    if (captured.length === 1) return response(
      frame("reasoningContentEvent", { text: "consider" }),
      frame("toolUseEvent", { toolUseId: "call1", name: alias, input: '{"query":' }),
      frame("toolUseEvent", { toolUseId: "call1", name: alias, input: '"x"}' }),
      frame("metadataEvent", { tokenUsage: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 5, cacheWriteInputTokens: 7 } }))
    return response(frame("assistantResponseEvent", { content: "done" }),
      frame("metadataEvent", { stopReason: "max_tokens", tokenUsage: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 5 } }))
  }
  const hooks = await KiroAuthPlugin(), loader = await hooks.auth.loader(async () => auth("synthetic-C"))
  const first = request({ reasoning_effort: "xhigh", tools: [{ type: "function", function: { name, parameters: { type: "object" } } }] })
  const res = await call(loader.fetch, first), body = await res.json()
  expect(body.choices[0].finish_reason).toBe("tool_calls")
  expect(body.choices[0].message.tool_calls).toEqual([{ id: "call1", type: "function", function: { name, arguments: '{"query":"x"}' } }])
  expect(body.choices[0].message.reasoning_content).toBe("consider")
  expect(body.usage).toEqual({ prompt_tokens: 14, completion_tokens: 3, total_tokens: 17, prompt_tokens_details: { cached_tokens: 5 } })
  const second = request({ reasoning_effort: "max", stream: true, stream_options: { include_usage: true },
    messages: [...first.messages, body.choices[0].message, { role: "tool", tool_call_id: "call1",
      content: [{ type: "text", text: "result" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }] })
  const stream = await call(loader.fetch, second), wire = await stream.text()
  expect(wire).toContain('"content":"done"')
  expect(wire).toContain('"finish_reason":"length"')
  expect(wire).toContain('"cached_tokens":5')
  expect(wire).toContain("data: [DONE]")
  const state = captured[1].conversationState, current = state.currentMessage.userInputMessage
  expect(state.history[1].assistantResponseMessage.toolUses[0].name).toBe(alias)
  expect(current.userInputMessageContext.toolResults[0]).toMatchObject({ toolUseId: "call1", content: [{ text: "result" }] })
  expect(current.images).toEqual([{ format: "png", source: { bytes: "aGVsbG8=" } }])
  expect(current.userInputMessageContext.tools[0].toolSpecification.name).toBe(alias)
  expect(captured[1].additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } })
})

test("streamed Chat tools retain indices/arguments and an early exception stays an HTTP error", async () => {
  const names = new Map([["short", "full-name"]])
  const events = () => _internal.events(response(frame("toolUseEvent", { toolUseId: "id", name: "short", input: { x: 1 } })).body, "gpt-test", false)
  const s = await (await _internal.replyChat(events(), "gpt-test", true, names)).text()
  expect(s).toContain('"index":0,"id":"id"')
  expect(s).toContain('"name":"full-name"')
  expect(s).toContain('"arguments":"{\\\"x\\\":1}"')
  expect(s).toContain('"finish_reason":"tool_calls"')
  for (const stream of [false, true]) {
    const it = _internal.events(response(frame("ThrottlingException", { message: "Too many requests" }, true)).body, "gpt-test", false)
    expect((await _internal.replyChat(it, "gpt-test", stream, names)).status).toBe(429)
  }
})

test("Chat rejects lossy content and malformed tool input instead of silently dropping it", () => {
  expect(() => _internal.chatInput(request({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }] }))).toThrow()
  expect(() => _internal.chatInput(request({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "id", type: "function", function: { name: "t", arguments: "bad" } }] }] }))).toThrow()
  expect(() => _internal.chatInput(request({ tool_choice: "required" }))).toThrow()
})
