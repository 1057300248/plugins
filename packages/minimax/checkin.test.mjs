// The daily check-in (每日签到): the panel's day statuses and the claim's
// answers, as the minimax-cloud endpoints answer them (quota-hub's
// minimax2api worked them out). Everything runs against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin } from "./index.mjs"
import { _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const STATUS = "/minimax-cloud/api/v1/signin/status"
const CLAIM = "/minimax-cloud/api/v1/signin/claim"
const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "a@example.com" }

const day = (over = {}) => ({ day_no: 1, points: 10, status: 2, is_today: true, ...over })

const week = (todayNo, over = {}) => Array.from({ length: 7 }, (_, i) => {
  const dayNo = i + 1
  const status = dayNo < todayNo ? 3 : dayNo === todayNo ? 2 : 1
  return day({ day_no: dayNo, status, is_today: dayNo === todayNo, ...over })
})

async function checkin() {
  const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return plugin.auth.checkin(async () => auth)
}

test("a claimable day is claimed, its points and the streak reported", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(7) } }))
  f.route("POST " + CLAIM, (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer tok")
    return json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20, day_no: 7 } })
  })
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20, streak: 7 })
})

test("a claimed day is done, the streak counting it", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 3 }) } }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 1 })
})

test("the claim saying already-today is done", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 2, points: 10 } }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 1 })
})

test("a claimable mid-week day is claimed with the streak before it", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(3) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
  expect(await checkin()).toEqual({ outcome: "claimed", credit: 20, streak: 3 })
})

test("a claimed mid-week day reports the points and streak", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({
    base_resp: { status_code: 0 },
    data: { days: week(4, { status: 3 }) },
  }))
  expect(await checkin()).toEqual({ outcome: "done", credit: 10, streak: 4 })
})

test("the check-in requests are signed like the account API", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 20 } }))
  await checkin()
  const status = f.seen.find((r) => r.path === STATUS)
  const claim = f.seen.find((r) => r.path === CLAIM)
  for (const r of [status, claim]) {
    expect(r.headers.get("user-agent")).toBe("MiniMaxCode")
    expect(r.headers.get("yy")).toBeTruthy()
    expect(r.headers.get("x-timestamp")).toBeTruthy()
    expect(r.headers.get("x-signature")).toBeTruthy()
    expect(r.query.get("device_platform")).toBe("mcode")
    expect(r.query.get("timezone_offset")).toBe(String(new Date().getTimezoneOffset() * -60))
  }
  expect(claim?.text).toBe("{}")
})

test("the China panel is asked on the chat host, not the account host", async () => {
  f = fakeMiniMax()
  const was = { ..._internal.SITES["minimax-code"] }
  Object.assign(_internal.SITES["minimax-code"], {
    agent: "https://account.example",
    llm: f.origin,
  })
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 3 }) } }))
  const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await plugin.auth.checkin(async () => auth)
  expect(out).toEqual({ outcome: "done", credit: 10, streak: 1 })
  expect(f.seen.filter((r) => r.path === STATUS)).toHaveLength(1)
  Object.assign(_internal.SITES["minimax-code"], was)
})

test("a day that hasn't started is inactive", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(8).map((d) => ({ ...d, status: 1 })) } }))
  expect(await checkin()).toEqual({ outcome: "inactive" })
})

test("a day that isn't available is ineligible", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1, { status: 4 }) } }))
  expect(await checkin()).toEqual({ outcome: "ineligible" })
})

test("a panel without days is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: [] } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("no panel")
})

test("a reply without a panel is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({}))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("no panel")
})

test("a non-2xx panel is failed", async () => {
  for (const body of [
    json({ error: "invalid signature" }, 400),
    json({ message: "internal" }, 502),
  ]) {
    f?.close()
    f = fakeMiniMax()
    f.route("GET " + STATUS, () => body)
    const out = await checkin()
    expect(out.outcome).toBe("failed")
    expect(out.message).toMatch(/HTTP (400|502)/)
  }
})

test("a panel without today is inactive and no claim is made", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(8).map((d) => ({ ...d, is_today: false })) } }))
  expect(await checkin()).toEqual({ outcome: "inactive" })
  expect(f.seen.filter((r) => r.path === CLAIM)).toHaveLength(0)
})

test("the panel's error is failed with its words", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 1004, status_msg: "login fail" } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("login fail")
})

test("a turned-away token is failed without signing the account out", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => new Response("no", { status: 401 }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.signIn).toBeUndefined()
})

test("a forbidden check-in is failed without signing the account out", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => new Response("no", { status: 403 }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("403")
  expect(out.signIn).toBeUndefined()
})

test("an unknown claim_result is failed", async () => {
  f = fakeMiniMax()
  f.route("GET " + STATUS, () => json({ base_resp: { status_code: 0 }, data: { days: week(1) } }))
  f.route("POST " + CLAIM, () => json({ base_resp: { status_code: 0 }, data: { claim_result: 9 } }))
  const out = await checkin()
  expect(out.outcome).toBe("failed")
  expect(out.message).toContain("claim_result")
})

test("a not-signed-in account is failed without a request", async () => {
  f = fakeMiniMax()
  const plugin = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await plugin.auth.checkin(async () => ({ type: "api", key: "k" }))
  expect(out.outcome).toBe("failed")
  expect(out.message).toBe("not signed in")
  expect(f.seen.length).toBe(0)
})
