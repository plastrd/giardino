// worker/index.ts — Giardino: site + Hosthub proxy σε ένα Cloudflare Worker
//
//   /api/*   → αυτός ο κώδικας
//   ό,τι άλλο → το build του React (dist/) μέσω static assets (δωρεάν, απεριόριστα)
//
// Endpoints:
//   GET  /api/rooms/:slug/calendar?from=2026-11-01&to=2026-12-31   τιμές + διαθεσιμότητα (από cache)
//   POST /api/quote  { slug, checkIn, checkOut }                   τελική τιμή με ζωντανό έλεγχο
//   POST /api/book   { slug, checkIn, checkOut, adults, guest:{name,email,phone}, country?, eta?, notes?, turnstileToken }
//
// Cron (κάθε 10'): τραβάει τιμές + κρατήσεις από Hosthub → ένα JSON στο KV.

interface Room { slug: string; name: string; rentalId: string; ratePlanId: string; maxGuests: number }

interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  ROOMS: Room[];                 // από wrangler.jsonc → vars
  HOSTHUB_API_KEY: string;       // secret
  HOSTHUB_BASE?: string;         // μόνο για δοκιμές (mock server)· αλλιώς το πραγματικό Hosthub
  TURNSTILE_SECRET: string;      // secret
  RESEND_API_KEY?: string;       // secret (προαιρετικό, για email)
  MAIL_FROM?: string;            // π.χ. "Giardino <bookings@giardino.gr>"
  NOTIFY_EMAIL?: string;         // email ιδιοκτήτη
}

type Day = { price: number | null; minStay: number; blocked: boolean };
type Snapshot = { updatedAt: string; currency: string; rooms: Record<string, Record<string, Day>> };

const BASE = "https://app.hosthub.com/api/2019-03-01";
const SNAPSHOT_KEY = "snapshot:v1";
const HORIZON_DAYS = 365;
const MAX_NIGHTS = 30;

// ─────────────────────────────────────────────────────────────
// Αντιστοίχιση πεδίων Hosthub — ⚠️ ΕΛΕΓΞΤΕ τα με το YAML του Hosthub.
// Όλα τα ονόματα πεδίων είναι μόνο εδώ, ώστε η διόρθωση να γίνει σε ένα σημείο.
const F = {
  listData:    (p: any): any[] => p.data ?? p,
  nextPage:    (p: any): string | null => p.navigation?.next ?? null,
  evFrom:      (e: any): string => String(e.date_from).slice(0, 10),
  evTo:        (e: any): string => String(e.date_to).slice(0, 10),
  evCancelled: (e: any): boolean => Boolean(e.is_cancelled) || e.status === "cancelled",
  rateDate:    (r: any): string => String(r.date).slice(0, 10),
  ratePrice:   (r: any): number => Number(r.price ?? r.rate),
  rateMinStay: (r: any): number => Number(r.min_stay ?? 1),
  rateCurr:    (r: any): string => r.currency ?? "EUR",
  newBooking: (room: Room, b: BookingInput, total: number, currency: string) => ({
    type: "Booking",
    date_from: b.checkIn,
    date_to: b.checkOut,
    guest_name: b.guest.name,
    guest_email: b.guest.email,
    guest_phone: b.guest.phone,
    guest_adults: b.adults,
    booking_value: { cents: Math.round(total * 100), currency },
    notes: [
      "Κράτηση από το site",
      b.eta && `Ώρα άφιξης: ${b.eta}`,
      b.country && `Χώρα: ${b.country}`,
      b.notes && `Σημειώσεις: ${b.notes}`,
    ].filter(Boolean).join(" · "),
  }),
};
// ─────────────────────────────────────────────────────────────

// ---------- Hosthub client ----------
async function hh(env: Env, path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : (env.HOSTHUB_BASE ?? BASE) + path;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: env.HOSTHUB_API_KEY, "Content-Type": "application/json" }, // ΧΩΡΙΣ "Bearer"
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Hosthub ${res.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function hhList(env: Env, path: string) {
  const out: any[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < 20; i++) {          // όριο σελίδων για ασφάλεια
    const page = await hh(env, next);
    out.push(...F.listData(page));
    next = F.nextPage(page);
  }
  return out;
}

// ---------- ημερομηνίες (πάντα YYYY-MM-DD, UTC) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}
function nights(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
const maxStr = (a: string, b: string) => (a > b ? a : b);
const minStr = (a: string, b: string) => (a < b ? a : b);

// ---------- συγχρονισμός (cron) ----------
async function buildRoom(env: Env, room: Room) {
  const [rates, events] = await Promise.all([
    hhList(env, `/rate-plans/${room.ratePlanId}/rates`),
    hhList(env, `/rentals/${room.rentalId}/calendar-events`),
  ]);
  const start = today(), end = addDays(start, HORIZON_DAYS);
  const days: Record<string, Day> = {};
  let currency = "EUR";

  for (const r of rates) {
    const d = F.rateDate(r);
    if (d < start || d >= end) continue;
    days[d] = { price: F.ratePrice(r), minStay: F.rateMinStay(r), blocked: false };
    currency = F.rateCurr(r);
  }
  for (const e of events) {
    if (F.evCancelled(e)) continue;
    for (const d of nights(maxStr(F.evFrom(e), start), minStr(F.evTo(e), end))) {
      (days[d] ??= { price: null, minStay: 1, blocked: false }).blocked = true;
    }
  }
  return { days, currency };
}

async function sync(env: Env): Promise<Snapshot> {
  const snap: Snapshot = { updatedAt: new Date().toISOString(), currency: "EUR", rooms: {} };
  for (const room of env.ROOMS) {                  // σειριακά: λίγα ταυτόχρονα αιτήματα προς Hosthub
    const { days, currency } = await buildRoom(env, room);
    snap.rooms[room.slug] = days;
    snap.currency = currency;
  }
  await env.CACHE.put(SNAPSHOT_KEY, JSON.stringify(snap));
  return snap;
}

async function getSnapshot(env: Env): Promise<Snapshot> {
  return (await env.CACHE.get<Snapshot>(SNAPSHOT_KEY, "json")) ?? (await sync(env));
}

// ---------- υπολογισμός τιμής ----------
type QuoteResult =
  | { ok: true; nights: number; total: number; currency: string; perNight: { date: string; price: number }[] }
  | { ok: false; reason: string; minStay?: number };

function validateDates(checkIn: string, checkOut: string): string | null {
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) return "invalid_dates";
  if (checkIn < today()) return "past_date";
  if (checkOut <= checkIn) return "invalid_dates";
  if (nights(checkIn, checkOut).length > MAX_NIGHTS) return "too_long";
  return null;
}

async function liveAvailable(env: Env, room: Room, checkIn: string, checkOut: string) {
  const events = await hhList(env, `/rentals/${room.rentalId}/calendar-events`);
  return !events.some((e) => !F.evCancelled(e) && F.evFrom(e) < checkOut && F.evTo(e) > checkIn);
}

async function quote(env: Env, room: Room, checkIn: string, checkOut: string): Promise<QuoteResult> {
  const bad = validateDates(checkIn, checkOut);
  if (bad) return { ok: false, reason: bad };

  const snap = await getSnapshot(env);
  const days = snap.rooms[room.slug] ?? {};
  const list = nights(checkIn, checkOut);

  const perNight = list.map((d) => ({ date: d, price: days[d]?.price ?? null }));
  if (perNight.some((n) => n.price == null)) return { ok: false, reason: "no_rate" };

  const minStay = days[checkIn]?.minStay ?? 1;
  if (list.length < minStay) return { ok: false, reason: "min_stay", minStay };

  // η cache μπορεί να είναι έως 10' παλιά → ζωντανός έλεγχος πριν δώσουμε τελική τιμή
  if (!(await liveAvailable(env, room, checkIn, checkOut))) return { ok: false, reason: "not_available" };

  const total = Math.round(perNight.reduce((s, n) => s + n.price!, 0) * 100) / 100;
  return { ok: true, nights: list.length, total, currency: snap.currency, perNight: perNight as any };
}

// ---------- κράτηση ----------
interface BookingInput {
  slug: string; checkIn: string; checkOut: string; adults: number; lang?: "el" | "en";
  notes?: string; country?: string; eta?: string;
  guest: { name: string; email: string; phone: string }; turnstileToken: string;
}

async function verifyTurnstile(env: Env, token: string, ip: string | null) {
  const fd = new FormData();
  fd.append("secret", env.TURNSTILE_SECRET);
  fd.append("response", token ?? "");
  if (ip) fd.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd });
    return ((await r.json()) as any).success === true;
  } catch (e) {
    console.error("turnstile unreachable", e);
    return false;
  }
}

function validateGuest(b: BookingInput, room: Room): string | null {
  const g = b.guest ?? ({} as any);
  if (!g.name || g.name.trim().length < 2 || g.name.length > 100) return "invalid_name";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email ?? "") || g.email.length > 200) return "invalid_email";
  const digits = String(g.phone ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15 || String(g.phone).length > 30) return "invalid_phone";
  if (!Number.isInteger(b.adults) || b.adults < 1 || b.adults > room.maxGuests) return "invalid_guests";
  if (b.notes && String(b.notes).length > 1000) return "notes_too_long";
  if (b.country && String(b.country).length > 60) return "bad_request";
  if (b.eta && String(b.eta).length > 30) return "bad_request";
  return null;
}

async function book(env: Env, ctx: ExecutionContext, req: Request, b: BookingInput) {
  const room = findRoom(env, b.slug);
  if (!room) return json({ ok: false, reason: "unknown_room" }, 400);

  const invalid = validateGuest(b, room);
  if (invalid) return json({ ok: false, reason: invalid }, 400);

  if (!(await verifyTurnstile(env, b.turnstileToken, req.headers.get("CF-Connecting-IP"))))
    return json({ ok: false, reason: "captcha_failed" }, 403);

  // τιμή υπολογίζεται ΜΟΝΟ στον server
  const q = await quote(env, room, b.checkIn, b.checkOut);
  if (!q.ok) return json(q, 409);

  const created = await hh(env, `/rentals/${room.rentalId}/calendar-events`, {
    method: "POST",
    body: JSON.stringify(F.newBooking(room, b, q.total, q.currency)),
  });

  // κλείνουμε αμέσως τις μέρες στην cache, για να μη τις δει διαθέσιμες άλλος
  ctx.waitUntil(markBlocked(env, room.slug, b.checkIn, b.checkOut));
  ctx.waitUntil(sendEmails(env, room, b, q.total, q.currency));

  return json({ ok: true, bookingId: created?.id ?? null, total: q.total, currency: q.currency });
}

async function markBlocked(env: Env, slug: string, from: string, to: string) {
  const snap = await getSnapshot(env);
  const days = (snap.rooms[slug] ??= {});
  for (const d of nights(from, to)) (days[d] ??= { price: null, minStay: 1, blocked: false }).blocked = true;
  await env.CACHE.put(SNAPSHOT_KEY, JSON.stringify(snap));
}

async function sendEmails(env: Env, room: Room, b: BookingInput, total: number, currency: string) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;
  const el = b.lang !== "en";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const summary = `${esc(room.name)}: ${b.checkIn} → ${b.checkOut}, ${b.adults} ${el ? "άτομα" : "guests"}, ${total} ${currency}`;
  const send = (to: string, subject: string, html: string) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to, subject, html }),
    });

  const jobs = [
    send(b.guest.email,
      el ? "Η κράτησή σας στο Giardino" : "Your booking at Giardino",
      `<p>${el ? "Ευχαριστούμε" : "Thank you"}, ${esc(b.guest.name)}!</p><p>${summary}</p>`),
  ];
  if (env.NOTIFY_EMAIL)
    jobs.push(send(env.NOTIFY_EMAIL, `Νέα κράτηση από το site – ${esc(b.guest.name)}`,
      `<p>${summary}</p><p>${esc(b.guest.email)} · ${esc(b.guest.phone)}</p>` +
      `<p>${esc([b.eta, b.country, b.notes].filter(Boolean).join(" · "))}</p>`));
  await Promise.allSettled(jobs);
}

// ---------- router ----------
const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...extra } });

const findRoom = (env: Env, slug: string) => env.ROOMS.find((r) => r.slug === slug);

async function handleApi(req: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(req.url);
  const p = url.pathname;

  const cal = p.match(/^\/api\/rooms\/([\w-]+)\/calendar$/);
  if (cal && req.method === "GET") {
    const room = findRoom(env, cal[1]);
    if (!room) return json({ error: "unknown_room" }, 404);
    const from = url.searchParams.get("from") ?? today();
    const to = url.searchParams.get("to") ?? addDays(from, 60);
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return json({ error: "invalid_dates" }, 400);
    const snap = await getSnapshot(env);
    const days = snap.rooms[room.slug] ?? {};
    const out = nights(from, minStr(to, addDays(from, 400))).map((d) => ({
      date: d,
      price: days[d]?.price ?? null,
      minStay: days[d]?.minStay ?? 1,
      available: d >= today() && !!days[d] && !days[d].blocked && days[d].price != null,
    }));
    return json({ currency: snap.currency, updatedAt: snap.updatedAt, days: out }, 200,
      { "Cache-Control": "public, max-age=60" });
  }

  if (p === "/api/quote" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const room = findRoom(env, b.slug);
    if (!room) return json({ ok: false, reason: "unknown_room" }, 400);
    return json(await quote(env, room, b.checkIn, b.checkOut));
  }

  if (p === "/api/book" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as BookingInput | null;
    if (!b) return json({ ok: false, reason: "bad_request" }, 400);
    return book(env, ctx, req, b);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, ctx);
    } catch (e) {
      console.error(e);                               // φαίνεται στα logs του dashboard
      return json({ ok: false, reason: "server_error" }, 500);
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sync(env).catch((e) => console.error("sync failed", e)));
  },
} satisfies ExportedHandler<Env>;
