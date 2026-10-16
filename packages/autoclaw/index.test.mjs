// The check-in mapping is magpie's contract (provider-plugins.md): every
// answer the upstream gives lands on one of its outcomes, and the plugin
// factory registers both providers with every hook check.mjs looks for.
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoclawAuthPlugin, AutoclawCnAuthPlugin, _internal } from "./index.mjs"

const { checkinOutcome, signinConfig, bareToken, codeValue, tokenFields, refreshTokens, startLocalOAuth } = _internal

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`

test("both providers register with models and every hook", async () => {
  for (const [Plugin, id, api] of [
    [AutoclawAuthPlugin, "autoclaw", "https://autoglm-api.autoglm.ai"],
    [AutoclawCnAuthPlugin, "autoclaw-cn", "https://autoglm-api.zhipuai.cn"],
  ]) {
    const hooks = await Plugin({ client: { auth: { set: async () => {} } } })
    expect(hooks.auth.provider).toBe(id)
    expect(hooks.auth.loader).toBeFunction()
    expect(hooks.auth.usage).toBeFunction()
    expect(hooks.auth.checkin).toBeFunction()
    expect(hooks.auth.methods[0].prompts.length).toBeGreaterThan(0)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider[id].api).toBe(api)
    expect(Object.keys(cfg.provider[id].models).length).toBeGreaterThan(0)
  }
})

test("checkinOutcome maps every upstream answer onto the contract", () => {
  expect(checkinOutcome({ success: true, reward_points: 400, continuous_days: 7 })).toEqual({
    outcome: "claimed", credit: 400, streak: 7, message: "已签到 +400 · 连续 7 天",
  })
  expect(checkinOutcome({ already_completed: true, reward_points: 200 })).toEqual({
    outcome: "done", credit: 200,
  })
  expect(checkinOutcome(null)).toEqual({ outcome: "failed", message: "签到接口无响应" })
  expect(checkinOutcome({ success: false, message: "风控拦截" })).toEqual({
    outcome: "failed", message: "风控拦截",
  })
})

test("signinConfig: plugin options over the file, the file over the default", () => {
  const home = mkdtempSync(join(tmpdir(), "autoclaw-cfg-"))
  const prev = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = home
    // no file, no options: auto-signing stays off, left to the native switch
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })

    mkdirSync(join(home, "magpie"), { recursive: true })
    const file = join(home, "magpie", "autoclaw.json")
    writeFileSync(file, JSON.stringify({ signin: false, signinHour: 8 }))
    expect(signinConfig(undefined)).toEqual({ signin: false, signinOnUsage: false, signinHour: 8 })
    expect(signinConfig({ signin: true, signinOnUsage: true })).toEqual({
      signin: true, signinOnUsage: true, signinHour: 8,
    })
    // a broken file reads as no file
    writeFileSync(file, "{ not json")
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test("the JWT's exp is the token's truth, with the 10-minute skew", () => {
  const access = jwt({ exp: 2_000_000_000 })
  expect(bareToken(`Bearer ${access}`)).toBe(access)
  expect(tokenFields({ access_token: `Bearer ${access}`, refresh_token: "Bearer r1" })).toEqual({
    access, refresh: "r1", expires: 2_000_000_000_000 - 10 * 60 * 1000,
  })
  expect(codeValue("123456")).toBe(123456)
  expect(codeValue("12a45")).toBe("12a45")
})

// The request path, against a fake upstream: which headers the chat request
// carries, how a wrong host's 401 rotates to the other one, and when the host
// is told the sign-in is dead.
test("loader().fetch signs with X-Authorization and rotates hosts on 401", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  let mode = "ok" // ok | first-401 | all-401
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    if (mode === "first-401") { mode = "ok"; return new Response("{}", { status: 401 }) }
    if (mode === "all-401") return new Response("{}", { status: 401 })
    return new Response("ok")
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "Bearer a1" }))

    // The chat path goes to the upstream, signed by X-Authorization, not Authorization
    await loader.fetch("x", { headers: { Authorization: "Bearer old" } })
    expect(calls.at(-1).url).toBe("https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions")
    expect(calls.at(-1).headers.get("X-Authorization")).toBe("Bearer a1")
    expect(calls.at(-1).headers.get("Authorization")).toBe(null)

    // A 401 from the home host retries the other one, which answers
    mode = "first-401"
    calls.length = 0
    expect((await loader.fetch("x")).status).toBe(200)
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["autoglm-api.autoglm.ai", "autoglm-api.zhipuai.cn"])

    // Both hosts refusing the token answers 401 with the sign-in marker
    mode = "all-401"
    const refused = await loader.fetch("x")
    expect(refused.status).toBe(401)
    expect(refused.headers.get("X-Magpie-Sign-In")).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens orders hosts by the token's source_id and falls back on 400002", async () => {
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
    const { pathname } = url
    if (pathname === "/userapi/v1/refresh") return Response.json({ code: 400002, msg: "need agent refresh" })
    if (pathname === "/userapi/v1/agent-refresh") {
      return Response.json({ code: 0, msg: "ok", data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } })
    }
    throw new Error(`unexpected request ${pathname}`)
  }
  try {
    // An agent (SMS) token tries the CN host first, and its /refresh answers 400002
    const out = await refreshTokens(jwt({ source_id: "agent", device_id: "dev-1" }), [])
    expect(requests.map((r) => `${new URL(r.url).origin}${r.url.pathname}`)).toEqual([
      "https://autoglm-api.zhipuai.cn/userapi/v1/refresh",
      "https://autoglm-api.zhipuai.cn/userapi/v1/agent-refresh",
    ])
    expect(requests[0].body.device_id).toBe("dev-1")
    expect(out).toEqual({ access: "a2", refresh: "r2", expires: Date.now() + 3600_000 - 600_000 })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens tries the oversea host first and marks a dead token expired", async () => {
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    return new Response(JSON.stringify({ code: 401001, msg: "invalid_grant" }), { status: 401 })
  }
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.signIn).toBe("expired")
    // A web token belongs to the oversea host; its 401 stops the rotation there
    expect(requests.map((u) => u.origin)).toEqual(["https://autoglm-api.autoglm.ai"])
  } finally {
    globalThis.fetch = realFetch
  }
})

// A 401 whose body isn't an envelope (a gateway's plain text) must still tell
// the host the sign-in is dead, or the user isn't offered to sign in again.
test("refreshTokens marks a non-envelope 401 as expired too", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("Unauthorized", { status: 401 })
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.message).toContain("non-envelope response (HTTP 401)")
    expect(threw.signIn).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

// The local OAuth server against a fake upstream and a real listener: the
// callback only accepts the state the authorize page handed out, and the
// legacy /callback catch-all is gone.
test("the OAuth callback takes only the state the authorize page handed out", async () => {
  const realFetch = globalThis.fetch
  const upstream = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    // The plugin's own local server stays real; only the upstream is faked
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    upstream.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
    if (url.pathname === "/userapi/overseasv1/google-oauth-url") {
      return Response.json({ code: 0, msg: "ok", data: { oauth_url: "https://accounts.google.test/o/auth2/auth?state=st-123&client_id=c" } })
    }
    if (url.pathname === "/userapi/overseasv1/google-oauth-login") {
      return Response.json({ code: 0, msg: "ok", data: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "r1", user_id: "u1" } })
    }
    if (url.pathname === "/userapi/v1/user-profile") {
      return Response.json({ code: 0, msg: "ok", data: { user_name: "Tester" } })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  try {
    const session = await startLocalOAuth("google", () => {})
    const port = Number(/127\.0\.0\.1:(\d+)\//.exec(session.instructions)[1])
    const local = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init)

    // The guide page's Continue hands out the authorize URL, and the state in it
    const openAuth = await (await local("/open-auth", { method: "POST" })).json()
    expect(openAuth.url).toContain("state=st-123")

    // A forged state is turned away without ending the session…
    const evil = await local("/auth/callback-google?code=evil&state=attacker")
    expect(evil.status).toBe(200)
    expect(await evil.text()).toContain("state 不匹配")

    // …and the old /callback catch-all no longer answers
    expect((await local("/callback?code=evil&state=st-123")).status).toBe(404)

    // …while the real one still signs in with exactly the code it was given
    const good = await local("/auth/callback-google?code=good-code&state=st-123")
    expect(await good.text()).toContain("授权成功")
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(result.accountId).toBe("Tester")
    const login = upstream.find((u) => u.url.pathname === "/userapi/overseasv1/google-oauth-login")
    expect(login.body.code).toBe("good-code")
    expect(login.body.state).toBe("st-123")

    // The session's port is released once the callback returns
    let refused = false
    try { await local("/") } catch { refused = true }
    expect(refused).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})
