// worker/index.ts — Giardino: site + Hosthub proxy σε ένα Cloudflare Worker
//
//   /api/*   → αυτός ο κώδικας
//   ό,τι άλλο → το build του React (dist/) μέσω static assets (δωρεάν, απεριόριστα)
//
// Endpoints:
//   GET  /api/rooms/:slug/calendar?from=2026-11-01&to=2026-12-31   τιμές + διαθεσιμότητα (από cache)
//   POST /api/quote  { slug, checkIn, checkOut, adults, breakfast? }  τιμή (δωμάτιο + πρωινό + προκαταβολή) με ζωντανό έλεγχο
//   POST /api/verify/send   { email, lang? }  στέλνει νέο τυχαίο 8ψήφιο κωδικό στο email (ακυρώνει τον προηγούμενο)
//   POST /api/verify/check  { email, code }   ελέγχει τον κωδικό (έως 5 λάθη)
//   POST /api/verify/reset  { email }         ακυρώνει τον τρέχοντα κωδικό (όταν ο επισκέπτης φεύγει από το βήμα)
//   POST /api/enquiry { kind, date?, people?, email, phone, lang? }  αίτημα προσφοράς από το Coffee & Bar → email στον οικοδεσπότη
//   POST /api/book   { slug, checkIn, checkOut, adults, breakfast?, guest:{name,email,phone}, country?, notes?, verifyCode, turnstileToken }
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

type Day = {
  price: number | null;      // τιμή νύχτας σε € (null = δεν έχει οριστεί)
  minStay: number;           // ελάχιστες νύχτες όταν η άφιξη είναι αυτή τη μέρα
  maxStay: number;           // μέγιστες νύχτες όταν η άφιξη είναι αυτή τη μέρα
  blocked: boolean;          // κλειστή (κράτηση, block ή μη διαθέσιμη στο Hosthub)
  noArrival?: boolean;       // δεν επιτρέπεται άφιξη αυτή τη μέρα
  noDeparture?: boolean;     // δεν επιτρέπεται αναχώρηση αυτή τη μέρα
  extraPP?: number;          // επιπλέον € ανά άτομο / νύχτα πάνω από το όριο
  ppThreshold?: number;      // άτομα που περιλαμβάνονται στην τιμή
};
const emptyDay = (): Day => ({ price: null, minStay: 1, maxStay: 365, blocked: false });
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
  // CalendarEvent — επιβεβαιωμένο με πραγματική απάντηση. Κάθε μη ακυρωμένο event
  // (Booking, block κ.λπ.) κλείνει τις ημέρες date_from … date_to (η date_to είναι η αναχώρηση).
  evCancelled: (e: any): boolean => e.cancelled_at != null,
  // RentalDailyRate — επιβεβαιωμένο με πραγματική απάντηση του Hosthub (τιμές σε λεπτά)
  rateDate:     (r: any): string => String(r.date).slice(0, 10),
  ratePrice:    (r: any): number => Number(r.amount?.cents) / 100,
  rateCurr:     (r: any): string => r.amount?.currency ?? "EUR",
  rateMinStay:  (r: any): number => Number(r.minimum_length_of_stay ?? 1) || 1,
  rateMaxStay:  (r: any): number => Number(r.maximum_length_of_stay ?? 365) || 365,
  rateOpen:     (r: any): boolean => r.is_available !== false,
  rateNoArrive: (r: any): boolean => r.block_arrival === true,
  rateNoDepart: (r: any): boolean => r.block_departure === true,
  rateExtraPP:  (r: any): number => Number(r.extra_cost_per_person?.cents ?? 0) / 100,
  ratePPLimit:  (r: any): number => Number(r.amount_of_people_threshold ?? 0),
  newBooking: (room: Room, b: BookingInput, p: Pricing) => ({
    type: "Booking",
    date_from: b.checkIn,
    date_to: b.checkOut,
    guest_name: b.guest.name,
    guest_email: b.guest.email,
    guest_phone: b.guest.phone,
    guest_adults: b.adults,
    booking_value: { cents: Math.round(p.total * 100), currency: p.currency },
    // χώρα, πρωινό, τιμές, προκαταβολή και παρατηρήσεις του πελάτη → σημειώσεις της κράτησης στο Hosthub
    notes: bookingNotes(b, p),
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
    const items = F.listData(page);
    out.push(...items);
    // Το Hosthub δίνει πάντα "next", ακόμα και στην τελευταία σελίδα → σταματάμε στην πρώτη άδεια
    next = items.length ? F.nextPage(page) : null;
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
    const price = F.ratePrice(r);
    days[d] = {
      price: Number.isFinite(price) && price > 0 ? price : null,
      minStay: F.rateMinStay(r),
      maxStay: F.rateMaxStay(r),
      blocked: !F.rateOpen(r),
      noArrival: F.rateNoArrive(r) || undefined,
      noDeparture: F.rateNoDepart(r) || undefined,
      extraPP: F.rateExtraPP(r) || undefined,
      ppThreshold: F.ratePPLimit(r) || undefined,
    };
    currency = F.rateCurr(r);
  }
  for (const e of events) {
    if (F.evCancelled(e)) continue;
    for (const d of nights(maxStr(F.evFrom(e), start), minStr(F.evTo(e), end))) {
      (days[d] ??= emptyDay()).blocked = true;
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
  | { ok: false; reason: string; minStay?: number; maxStay?: number };

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

async function quote(env: Env, room: Room, checkIn: string, checkOut: string, adults = 1): Promise<QuoteResult> {
  const bad = validateDates(checkIn, checkOut);
  if (bad) return { ok: false, reason: bad };

  const snap = await getSnapshot(env);
  const days = snap.rooms[room.slug] ?? {};
  const list = nights(checkIn, checkOut);

  if (list.some((d) => days[d]?.blocked)) return { ok: false, reason: "not_available" };

  // τιμή νύχτας + τυχόν επιπλέον χρέωση ανά άτομο (αν έχει οριστεί στο Hosthub)
  const perNight = list.map((d) => {
    const day = days[d];
    if (!day || day.price == null) return { date: d, price: null as number | null };
    const extra = day.extraPP && day.ppThreshold ? Math.max(0, adults - day.ppThreshold) * day.extraPP : 0;
    return { date: d, price: day.price + extra };
  });
  if (perNight.some((n) => n.price == null)) return { ok: false, reason: "no_rate" };

  const first = days[checkIn]!;
  if (list.length < first.minStay) return { ok: false, reason: "min_stay", minStay: first.minStay };
  if (list.length > first.maxStay) return { ok: false, reason: "max_stay", maxStay: first.maxStay };
  if (first.noArrival) return { ok: false, reason: "no_arrival" };
  if (days[checkOut]?.noDeparture) return { ok: false, reason: "no_departure" };

  // η cache μπορεί να είναι έως 10' παλιά → ζωντανός έλεγχος πριν δώσουμε τελική τιμή
  if (!(await liveAvailable(env, room, checkIn, checkOut))) return { ok: false, reason: "not_available" };

  const total = Math.round(perNight.reduce((s, n) => s + n.price!, 0) * 100) / 100;
  return { ok: true, nights: list.length, total, currency: snap.currency, perNight: perNight as any };
}

// ---------- τιμολόγηση: πρωινό + προκαταβολή ----------
const BREAKFAST_PP = 9;          // € ανά άτομο ανά νύχτα — ΙΔΙΟ με το BREAKFAST_PP στο index.html
const DEPOSIT_RATE = 0.3;        // 30% του συνόλου
const DEPOSIT_AFTER_DAYS = 5;    // προκαταβολή όταν η άφιξη απέχει περισσότερες από 5 ημέρες
const athensToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date()); // YYYY-MM-DD
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const r2 = (x: number) => Math.round(x * 100) / 100;

type QuoteOk = Extract<QuoteResult, { ok: true }>;
type Pricing = { nights: number; room: number; breakfast: number; total: number; deposit: number; currency: string };

function pricing(q: QuoteOk, adults: number, breakfast: boolean, checkIn: string): Pricing {
  const bf = breakfast ? adults * q.nights * BREAKFAST_PP : 0;
  const total = r2(q.total + bf);
  const deposit = daysBetween(athensToday(), checkIn) > DEPOSIT_AFTER_DAYS
    ? Math.round((total * DEPOSIT_RATE) / 10) * 10          // στρογγυλοποίηση στην πλησιέστερη δεκάδα
    : 0;
  return { nights: q.nights, room: q.total, breakfast: bf, total, deposit, currency: q.currency };
}

const money = (x: number, c: string) => `${Number.isInteger(x) ? x : x.toFixed(2)} ${c === "EUR" ? "€" : c}`;

function bookingNotes(b: BookingInput, p: Pricing) {
  const c = p.currency;
  return [
    b.country?.trim() && `Χώρα: ${b.country.trim()}`,
    p.breakfast
      ? `Πρωινό: Ναι – ${b.adults} άτομα × ${p.nights} νύχτες × ${money(BREAKFAST_PP, c)} = ${money(p.breakfast, c)}`
      : "Πρωινό: Όχι",
    `Τιμή δωματίου: ${money(p.room, c)}`,
    `Τελική τιμή: ${money(p.total, c)}`,
    p.deposit ? `Προκαταβολή 30%: ${money(p.deposit, c)} (εκκρεμεί)` : "Προκαταβολή: δεν απαιτείται",
    b.notes?.trim() && `Σημειώσεις πελάτη: ${b.notes.trim()}`,
  ].filter(Boolean).join("\n");
}

// ---------- επαλήθευση email ----------
// Τυχαίος 8ψήφιος κωδικός, αποθηκεύεται στο KV μόνο ως hash, με λήξη.
// • Κάθε νέα αποστολή αντικαθιστά τον προηγούμενο κωδικό → ισχύει μόνο ο τελευταίος.
// • Επαναποστολή μόνο μετά από 1 λεπτό.
// • 5 λάθος κωδικοί για το ίδιο email → κλείδωμα του email για 30 λεπτά.
// • Ο επαληθευμένος κωδικός ισχύει για μία μόνο κράτηση.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL = 15 * 60;           // ο κωδικός ισχύει 15 λεπτά από την αποστολή
const OTP_VERIFIED_TTL = 30 * 60;  // μετά την επαλήθευση: 30 λεπτά για να ολοκληρωθεί η κράτηση
const OTP_RESEND_SEC = 60;         // επαναποστολή μετά από 1 λεπτό (το KV δέχεται ελάχιστη λήξη 60")
const OTP_MAX_FAILS = 5;           // λάθη πριν το κλείδωμα
const OTP_LOCK_SEC = 30 * 60;      // διάρκεια κλειδώματος
const OTP_MAX_SENDS = 8;           // αποστολές ανά email ανά ώρα (προστασία από κατάχρηση)

type OtpRec = { h: string; verified?: boolean };
type OtpResult = { ok: true } | { ok: false; reason: string; attemptsLeft?: number; retryIn?: number };

const otpKey = (email: string) => `otp:${email}`;
const coolKey = (email: string) => `otp-cool:${email}`;
const failKey = (email: string) => `otp-fail:${email}`;
const sendsKey = (email: string) => `otp-sends:${email}`;
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const otpHash = (email: string, code: string) => sha256(`giardino-otp:${email}:${code}`);

function newCode() {
  // ομοιόμορφα τυχαίος 00000000–99999999
  const max = Math.floor(0xffffffff / 1e8) * 1e8;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= max);
  return String(a[0] % 1e8).padStart(8, "0");
}

async function getFails(env: Env, email: string) {
  return Number(await env.CACHE.get(failKey(email))) || 0;
}

async function sendVerifyCode(env: Env, rawEmail: string, lang?: string, site = ""): Promise<OtpResult> {
  const email = normEmail(rawEmail);
  if ((await getFails(env, email)) >= OTP_MAX_FAILS) return { ok: false, reason: "too_many_attempts" };

  const cool = await env.CACHE.getWithMetadata<{ until: number }>(coolKey(email));
  const until = cool.metadata?.until ?? 0;
  if (until > Date.now()) return { ok: false, reason: "too_soon", retryIn: Math.ceil((until - Date.now()) / 1000) };

  const sends = Number(await env.CACHE.get(sendsKey(email))) || 0;
  if (sends >= OTP_MAX_SENDS) return { ok: false, reason: "too_many_sends" };

  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.error("verify: RESEND_API_KEY ή MAIL_FROM λείπει — δεν μπορεί να σταλεί κωδικός");
    return { ok: false, reason: "email_unavailable" };
  }

  const code = newCode();
  const sent = await sendCodeEmail(env, rawEmail.trim(), code, lang === "en" ? "en" : "el", site);
  if (!sent) return { ok: false, reason: "email_failed" };

  // ο νέος κωδικός αντικαθιστά τον παλιό
  await Promise.all([
    env.CACHE.put(otpKey(email), JSON.stringify({ h: await otpHash(email, code) } satisfies OtpRec), { expirationTtl: OTP_TTL }),
    env.CACHE.put(coolKey(email), "1", { expirationTtl: OTP_RESEND_SEC, metadata: { until: Date.now() + OTP_RESEND_SEC * 1000 } }),
    env.CACHE.put(sendsKey(email), String(sends + 1), { expirationTtl: 3600 }),
  ]);
  return { ok: true };
}

async function checkVerifyCode(env: Env, rawEmail: string, code: unknown): Promise<OtpResult> {
  const email = normEmail(rawEmail);
  const fails = await getFails(env, email);
  if (fails >= OTP_MAX_FAILS) return { ok: false, reason: "too_many_attempts" };

  const rec = await env.CACHE.get<OtpRec>(otpKey(email), "json");
  if (!rec) return { ok: false, reason: "code_expired" };

  if (typeof code === "string" && /^\d{8}$/.test(code) && (await otpHash(email, code)) === rec.h) {
    if (!rec.verified)
      await Promise.all([
        env.CACHE.put(otpKey(email), JSON.stringify({ ...rec, verified: true }), { expirationTtl: OTP_VERIFIED_TTL }),
        fails ? env.CACHE.delete(failKey(email)) : null,  // σωστός κωδικός → μηδενίζονται τα λάθη
      ]);
    return { ok: true };
  }

  const n = fails + 1;
  if (n >= OTP_MAX_FAILS) {
    await Promise.all([
      env.CACHE.put(failKey(email), String(n), { expirationTtl: OTP_LOCK_SEC }),
      env.CACHE.delete(otpKey(email)),              // ο κωδικός δεν ισχύει πια
    ]);
    return { ok: false, reason: "too_many_attempts" };
  }
  await env.CACHE.put(failKey(email), String(n), { expirationTtl: OTP_LOCK_SEC });
  return { ok: false, reason: "invalid_code", attemptsLeft: OTP_MAX_FAILS - n };
}

// για την κράτηση: ο κωδικός πρέπει να είναι ο τελευταίος που στάλθηκε ΚΑΙ να έχει επαληθευτεί
async function isCodeValid(env: Env, rawEmail: string, code: unknown): Promise<boolean> {
  const email = normEmail(rawEmail);
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) return false;
  const rec = await env.CACHE.get<OtpRec>(otpKey(email), "json");
  return !!rec?.verified && (await otpHash(email, code)) === rec.h;
}
const useCode = (env: Env, rawEmail: string) => env.CACHE.delete(otpKey(normEmail(rawEmail)));

// ---------- emails: κοινή εμφάνιση ----------
// Στα χρώματα του site, συμπαγή ώστε να χωράνε στην οθόνη. Πίνακες + inline styles για Gmail, Outlook, Apple Mail, κινητά.
const MC = { bg: "#F4F2EC", card: "#FFFFFF", ink: "#2F3A2B", muted: "#686D5B", leaf: "#585B48", sage: "#8A916F", soft: "#EEEFE6", cream: "#E9E4D7", line: "#E4E0D4" };
const M_SERIF = "'GFS Didot','Didot','Bodoni 72',Georgia,'Times New Roman',serif";
const M_SANS = "'Segoe UI',Helvetica,Arial,sans-serif";
const escH = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// σπάει την αυτόματη αναγνώριση διευθύνσεων/τηλεφώνων (μπλε σύνδεσμοι στο Gmail/iPhone)
const noLink = (s: string) => s.split(" ").join("&zwnj; ");
const M_FOOT = {
  el: { address: "Ευξείνου Πόντου 22, Δράμα" },
  en: { address: "22 Efxeinou Pontou, Drama, Greece" },
};

function emailLayout(o: { lang: "el" | "en"; site: string; title: string; preheader: string; body: string }) {
  const logo = o.site
    ? `<img src="${o.site}/img/wordmark.png" width="130" alt="Giardino" style="display:block;margin:0 auto;width:130px;height:auto;border:0">`
    : `<div style="font-family:${M_SERIF};font-size:28px;color:${MC.leaf}">giardino</div>`;
  return `<!doctype html>
<html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escH(o.title)}</title>
<style>a[x-apple-data-detectors],.nolink a{color:inherit!important;text-decoration:none!important;font:inherit!important}</style></head>
<body style="margin:0;padding:0;background:${MC.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${MC.bg}">${escH(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MC.bg}">
<tr><td align="center" style="padding:16px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${MC.card};border:1px solid ${MC.line};border-radius:14px;overflow:hidden">
    <tr><td align="center" style="padding:16px 20px 14px;background:${MC.cream};border-bottom:3px solid ${MC.leaf}">${logo}</td></tr>
    ${o.body}
    <tr><td class="nolink" style="padding:12px 24px;background:${MC.leaf};font-family:${M_SANS};font-size:12px;line-height:1.6;color:${MC.cream}">
      <span style="font-family:${M_SERIF};font-size:15px;color:#FFFFFF">Giardino</span> · <span style="color:${MC.cream}">${noLink(M_FOOT[o.lang].address)}</span> · <span style="color:${MC.cream};white-space:nowrap">+30&zwnj; 2521&zwnj; 402133</span>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// ---------- email με τον κωδικό επαλήθευσης ----------
const OTP_TEXT = {
  el: {
    subject: "Giardino - Κωδικός επαλήθευσης",
    preheader: (c: string) => `Ο κωδικός σας: ${c}. Ισχύει για 15 λεπτά.`,
    title: "Επαλήθευση email",
    intro: "Χρησιμοποιήστε τον παρακάτω κωδικό για να ολοκληρώσετε την κράτησή σας.",
    label: "Ο κωδικός σας",
    valid: "Ισχύει για 15 λεπτά· αν ζητήσετε νέο, αυτός παύει να ισχύει. Αν δεν ζητήσατε εσείς κωδικό, αγνοήστε αυτό το email.",
  },
  en: {
    subject: "Giardino - Verification code",
    preheader: (c: string) => `Your code: ${c}. Valid for 15 minutes.`,
    title: "Verify your email",
    intro: "Use the code below to complete your booking.",
    label: "Your code",
    valid: "Valid for 15 minutes; requesting a new code cancels this one. If you didn't request a code, ignore this email.",
  },
};

function otpEmailHtml(code: string, lang: "el" | "en", site: string) {
  const T = OTP_TEXT[lang];
  // ο κωδικός ως ενιαίο κείμενο σε Arial· ένα πάτημα τον επιλέγει ολόκληρο
  const codeBox = `<div style="display:inline-block;padding:10px 20px;background:${MC.card};border:1px solid ${MC.sage};border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:bold;line-height:1.2;letter-spacing:5px;color:${MC.ink};-webkit-user-select:all;user-select:all;white-space:nowrap">${code}</div>`;
  const body = `
    <tr><td style="padding:22px 24px 0;font-family:${M_SANS};color:${MC.ink}">
      <h1 style="margin:0 0 6px;font-family:${M_SERIF};font-weight:normal;font-size:24px;line-height:1.2;color:${MC.ink}">${T.title}</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:${MC.muted}">${T.intro}</p>
    </td></tr>
    <tr><td align="center" style="padding:16px 12px 0">
      <div style="background:${MC.soft};border-radius:12px;padding:14px 6px 16px">
        <p style="margin:0 0 8px;font-family:${M_SANS};font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:600;color:${MC.sage}">${T.label}</p>
        ${codeBox}
      </div>
    </td></tr>
    <tr><td style="padding:14px 24px 20px;font-family:${M_SANS}">
      <p style="margin:0;font-size:13px;line-height:1.55;color:${MC.muted}">${T.valid}</p>
    </td></tr>`;
  return emailLayout({ lang, site, title: T.title, preheader: T.preheader(code), body });
}

function otpEmailText(code: string, lang: "el" | "en") {
  const T = OTP_TEXT[lang];
  return `${T.title}\n\n${T.intro}\n\n${T.label}: ${code}\n\n${T.valid}\n\nGiardino · ${M_FOOT[lang].address} · +30 2521 402133`;
}

async function sendCodeEmail(env: Env, to: string, code: string, lang: "el" | "en", site = ""): Promise<boolean> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM, to,
        subject: OTP_TEXT[lang].subject,
        html: otpEmailHtml(code, lang, site),
        text: otpEmailText(code, lang),
      }),
    });
    if (!r.ok) console.error("verify email failed", r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error("verify email unreachable", e);
    return false;
  }
}

// ---------- κράτηση ----------
interface BookingInput {
  slug: string; checkIn: string; checkOut: string; adults: number; lang?: "el" | "en";
  breakfast?: boolean; notes?: string; country?: string;
  guest: { name: string; email: string; phone: string };
  verifyCode: string; turnstileToken: string;
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
  if (!EMAIL_RE.test(g.email ?? "") || g.email.length > 200) return "invalid_email";
  // τηλέφωνο με κωδικό χώρας, π.χ. +306912345678 (ελληνικό: +30 και 10 ψηφία)
  const phone = String(g.phone ?? "").replace(/[\s-]/g, "");
  if (!/^\+\d{8,15}$/.test(phone) || (phone.startsWith("+30") && phone.length !== 13)) return "invalid_phone";
  g.phone = phone;
  if (!Number.isInteger(b.adults) || b.adults < 1 || b.adults > room.maxGuests) return "invalid_guests";
  if (b.notes && String(b.notes).length > 1000) return "notes_too_long";
  if (b.country && String(b.country).length > 60) return "bad_request";
  return null;
}

async function book(env: Env, ctx: ExecutionContext, req: Request, b: BookingInput) {
  const room = findRoom(env, b.slug);
  if (!room) return json({ ok: false, reason: "unknown_room" }, 400);

  const invalid = validateGuest(b, room);
  if (invalid) return json({ ok: false, reason: invalid }, 400);

  if (!(await isCodeValid(env, b.guest.email, b.verifyCode)))
    return json({ ok: false, reason: "invalid_code" }, 400);

  if (!(await verifyTurnstile(env, b.turnstileToken, req.headers.get("CF-Connecting-IP"))))
    return json({ ok: false, reason: "captcha_failed" }, 403);

  // τιμή υπολογίζεται ΜΟΝΟ στον server
  const q = await quote(env, room, b.checkIn, b.checkOut, b.adults);
  if (!q.ok) return json(q, 409);
  const p = pricing(q, b.adults, b.breakfast === true, b.checkIn);

  const created = await hh(env, `/rentals/${room.rentalId}/calendar-events`, {
    method: "POST",
    body: JSON.stringify(F.newBooking(room, b, p)),
  });

  // κλείνουμε αμέσως τις μέρες στην cache, για να μη τις δει διαθέσιμες άλλος
  ctx.waitUntil(markBlocked(env, room.slug, b.checkIn, b.checkOut));
  ctx.waitUntil(useCode(env, b.guest.email));        // ο κωδικός ισχύει για μία κράτηση
  ctx.waitUntil(sendEmails(env, room, b, p, new URL(req.url).origin));

  return json({ ok: true, bookingId: created?.id ?? null, ...p });
}

async function markBlocked(env: Env, slug: string, from: string, to: string) {
  const snap = await getSnapshot(env);
  const days = (snap.rooms[slug] ??= {});
  for (const d of nights(from, to)) (days[d] ??= emptyDay()).blocked = true;
  await env.CACHE.put(SNAPSHOT_KEY, JSON.stringify(snap));
}

// ---------- email ολοκλήρωσης κράτησης ----------
// Ελληνικά ονόματα δωματίων (ίδια με το site)· αλλιώς χρησιμοποιείται το name από το wrangler.jsonc
const ROOM_NAMES: Record<string, { el: string; en: string }> = {
  s1: { el: "Διαμέρισμα ενός υπνοδωματίου", en: "One-Bedroom Apartment" },
  s2: { el: "Διαμέρισμα δύο υπνοδωματίων", en: "Two-Bedroom Apartment" },
};
const BOOK_TEXT = {
  el: {
    subject: "Ολοκλήρωση κράτησης",
    title: "Ολοκλήρωση κράτησης",
    thanks: (n: string) => `Σας ευχαριστούμε, ${n}!`,
    intro: "Η κράτησή σας στο Giardino καταχωρήθηκε. Ακολουθούν τα στοιχεία της:",
    room: "Δωμάτιο", dates: "Ημερομηνίες", guests: "Άτομα", breakfast: "Πρωινό", total: "Σύνολο", deposit: "Προκαταβολή",
    nights: (n: number) => (n === 1 ? "1 νύχτα" : `${n} νύχτες`),
    yes: (x: string) => `Ναι (${x})`, no: "Όχι",
    noDeposit: "Δεν χρειάζεται προκαταβολή",
    host: "Ο οικοδεσπότης θα έρθει σύντομα σε τηλεφωνική επικοινωνία μαζί σας.",
    locale: "el-GR",
  },
  en: {
    subject: "Booking completed",
    title: "Booking completed",
    thanks: (n: string) => `Thank you, ${n}!`,
    intro: "Your booking at Giardino has been received. Here are the details:",
    room: "Room", dates: "Dates", guests: "Guests", breakfast: "Breakfast", total: "Total", deposit: "Deposit",
    nights: (n: number) => (n === 1 ? "1 night" : `${n} nights`),
    yes: (x: string) => `Yes (${x})`, no: "No",
    noDeposit: "No deposit required",
    host: "Your host will contact you by phone shortly.",
    locale: "en-GB",
  },
};

const bookDay = (d: string, lang: "el" | "en") =>
  new Date(d + "T12:00:00Z").toLocaleDateString(BOOK_TEXT[lang].locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function bookingEmailHtml(room: Room, b: BookingInput, p: Pricing, lang: "el" | "en", site: string) {
  const T = BOOK_TEXT[lang];
  const day = (d: string) => bookDay(d, lang);
  const rows: [string, string, boolean?][] = [
    [T.room, ROOM_NAMES[room.slug]?.[lang] ?? room.name],
    [T.dates, `<span style="white-space:nowrap">${day(b.checkIn)} →</span> <span style="white-space:nowrap">${day(b.checkOut)}</span><br><span style="color:${MC.muted}">${T.nights(p.nights)}</span>`],
    [T.guests, String(b.adults)],
    [T.breakfast, p.breakfast ? T.yes(money(p.breakfast, p.currency)) : T.no],
    [T.total, `<b>${money(p.total, p.currency)}</b>`],
    [T.deposit, p.deposit ? `<b>${money(p.deposit, p.currency)}</b>` : T.noDeposit],
  ];
  const table = rows.map(([k, v], i) =>
    `<tr><td style="padding:9px 0;${i ? `border-top:1px solid ${MC.line};` : ""}font-size:13px;color:${MC.muted};vertical-align:top;width:38%">${k}</td>` +
    `<td class="nolink" style="padding:9px 0;${i ? `border-top:1px solid ${MC.line};` : ""}font-size:14px;color:${MC.ink};text-align:right">${v}</td></tr>`).join("");
  const body = `
    <tr><td style="padding:22px 24px 0;font-family:${M_SANS};color:${MC.ink}">
      <h1 style="margin:0 0 6px;font-family:${M_SERIF};font-weight:normal;font-size:24px;line-height:1.2;color:${MC.ink}">${T.thanks(escH(b.guest.name))}</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:${MC.muted}">${T.intro}</p>
    </td></tr>
    <tr><td style="padding:14px 16px 0">
      <div style="background:${MC.soft};border-radius:12px;padding:6px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${M_SANS}">${table}</table>
      </div>
    </td></tr>
    <tr><td style="padding:16px 24px 20px;font-family:${M_SANS}">
      <p style="margin:0;font-size:14px;line-height:1.55;color:${MC.ink}">${T.host}</p>
    </td></tr>`;
  return emailLayout({ lang, site, title: T.title, preheader: `${T.thanks(b.guest.name)} ${T.intro}`, body });
}

function bookingEmailText(room: Room, b: BookingInput, p: Pricing, lang: "el" | "en") {
  const T = BOOK_TEXT[lang];
  return [
    T.thanks(b.guest.name), "", T.intro, "",
    `${T.room}: ${ROOM_NAMES[room.slug]?.[lang] ?? room.name}`,
    `${T.dates}: ${bookDay(b.checkIn, lang)} → ${bookDay(b.checkOut, lang)} (${T.nights(p.nights)})`,
    `${T.guests}: ${b.adults}`,
    `${T.breakfast}: ${p.breakfast ? T.yes(money(p.breakfast, p.currency)) : T.no}`,
    `${T.total}: ${money(p.total, p.currency)}`,
    `${T.deposit}: ${p.deposit ? money(p.deposit, p.currency) : T.noDeposit}`,
    "", T.host, "", `Giardino · ${M_FOOT[lang].address} · +30 2521 402133`,
  ].join("\n");
}

async function sendEmails(env: Env, room: Room, b: BookingInput, p: Pricing, site = "") {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;
  const lang: "el" | "en" = b.lang === "en" ? "en" : "el";
  const send = (to: string, subject: string, html: string, text?: string) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to, subject, html, ...(text ? { text } : {}) }),
    }).then(async (r) => { if (!r.ok) console.error("booking email failed", r.status, (await r.text()).slice(0, 300)); });

  const jobs = [
    send(b.guest.email, BOOK_TEXT[lang].subject, bookingEmailHtml(room, b, p, lang, site), bookingEmailText(room, b, p, lang)),
  ];
  // ειδοποίηση στον ιδιοκτήτη (απλή, με όλα τα στοιχεία)
  if (env.NOTIFY_EMAIL && EMAIL_RE.test(env.NOTIFY_EMAIL))
    jobs.push(send(env.NOTIFY_EMAIL, `Νέα κράτηση από το site – ${escH(b.guest.name)}`,
      `<p>${escH(ROOM_NAMES[room.slug]?.el ?? room.name)}: ${b.checkIn} → ${b.checkOut}, ${b.adults} άτομα, σύνολο ${money(p.total, p.currency)}</p>` +
      `<p>${escH(b.guest.name)} · ${escH(b.guest.email)} · ${escH(b.guest.phone)}</p>` +
      `<p>${escH(bookingNotes(b, p)).replace(/\n/g, "<br>")}</p>`));
  await Promise.allSettled(jobs);
}

// ---------- αίτημα προσφοράς (Coffee & Bar) → email στον οικοδεσπότη ----------
const ENQ_KINDS: Record<string, string> = { o1: "Δεξίωση", o2: "Ιδιωτική εκδήλωση", o3: "Live / μουσική βραδιά", o4: "Εταιρική εκδήλωση" };
const ENQ_MAX_PER_HOUR = 5;      // αιτήματα ανά IP ανά ώρα (προστασία από spam)

async function enquiry(env: Env, req: Request, b: any) {
  const email = String(b.email ?? "").trim();
  const phone = String(b.phone ?? "").replace(/[\s-]/g, "");
  if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, reason: "invalid_email" }, 400);
  if (!/^\+\d{8,15}$/.test(phone) || (phone.startsWith("+30") && phone.length !== 13)) return json({ ok: false, reason: "invalid_phone" }, 400);
  const kind = ENQ_KINDS[String(b.kind)] ?? "Εκδήλωση";
  const date = DATE_RE.test(String(b.date ?? "")) ? String(b.date) : "";
  const people = Number.isInteger(b.people) && b.people > 0 && b.people < 10000 ? b.people : null;

  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.NOTIFY_EMAIL || !EMAIL_RE.test(env.NOTIFY_EMAIL)) {
    console.error("enquiry: λείπει RESEND_API_KEY, MAIL_FROM ή NOTIFY_EMAIL");
    return json({ ok: false, reason: "email_unavailable" }, 503);
  }

  const ip = req.headers.get("CF-Connecting-IP") ?? "x";
  const rk = `enq-ip:${ip}`;
  const n = Number(await env.CACHE.get(rk)) || 0;
  if (n >= ENQ_MAX_PER_HOUR) return json({ ok: false, reason: "too_many" }, 429);

  const html = enquiryEmailHtml({ kind, date, people, email, phone, lang: b.lang === "en" ? "en" : "el" }, new URL(req.url).origin);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM, to: env.NOTIFY_EMAIL, reply_to: email,      // «Απάντηση» → πηγαίνει κατευθείαν στον πελάτη
      subject: "Ένας πελάτης θέλει κάτι διαφορετικό",
      html,
      text: `Νέο αίτημα προσφοράς\n\nΕίδος: ${kind}\nΗμερομηνία: ${date ? bookDay(date, "el") : "—"}\nΆτομα: ${people ?? "—"}\nEmail: ${email}\nΤηλέφωνο: ${phone}\nΓλώσσα πελάτη: ${b.lang === "en" ? "Αγγλικά" : "Ελληνικά"}`,
    }),
  });
  if (!r.ok) {
    console.error("enquiry email failed", r.status, (await r.text()).slice(0, 300));
    return json({ ok: false, reason: "email_failed" }, 502);
  }
  await env.CACHE.put(rk, String(n + 1), { expirationTtl: 3600 });
  return json({ ok: true });
}

function enquiryEmailHtml(e: { kind: string; date: string; people: number | null; email: string; phone: string; lang: "el" | "en" }, site: string) {
  const rows: [string, string][] = [
    ["Είδος", escH(e.kind)],
    ["Ημερομηνία", e.date ? bookDay(e.date, "el") : "—"],
    ["Άτομα (περίπου)", e.people ? String(e.people) : "—"],
    ["Email", `<a href="mailto:${escH(e.email)}" style="color:${MC.leaf}">${escH(e.email)}</a>`],
    ["Τηλέφωνο", `<a href="tel:${escH(e.phone)}" style="color:${MC.leaf};white-space:nowrap">${escH(e.phone)}</a>`],
    ["Γλώσσα πελάτη", e.lang === "en" ? "Αγγλικά" : "Ελληνικά"],
  ];
  const table = rows.map(([k, v], i) =>
    `<tr><td style="padding:9px 0;${i ? `border-top:1px solid ${MC.line};` : ""}font-size:13px;color:${MC.muted};vertical-align:top;width:40%">${k}</td>` +
    `<td style="padding:9px 0;${i ? `border-top:1px solid ${MC.line};` : ""}font-size:14px;color:${MC.ink};text-align:right">${v}</td></tr>`).join("");
  const body = `
    <tr><td style="padding:22px 24px 0;font-family:${M_SANS};color:${MC.ink}">
      <h1 style="margin:0 0 6px;font-family:${M_SERIF};font-weight:normal;font-size:24px;line-height:1.2;color:${MC.ink}">Νέο αίτημα προσφοράς</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:${MC.muted}">Ένας πελάτης συμπλήρωσε τη φόρμα «Ζητήστε προσφορά» στο Coffee &amp; Bar.</p>
    </td></tr>
    <tr><td style="padding:14px 16px 0">
      <div style="background:${MC.soft};border-radius:12px;padding:6px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${M_SANS}">${table}</table>
      </div>
    </td></tr>
    <tr><td style="padding:16px 24px 20px;font-family:${M_SANS}">
      <p style="margin:0;font-size:13px;line-height:1.55;color:${MC.muted}">Πατώντας «Απάντηση» το email πηγαίνει κατευθείαν στον πελάτη.</p>
    </td></tr>`;
  return emailLayout({ lang: "el", site, title: "Νέο αίτημα προσφοράς", preheader: `${e.kind} · ${e.email} · ${e.phone}`, body });
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
      noArrival: !!days[d]?.noArrival,
      available: d >= today() && !!days[d] && !days[d].blocked && days[d].price != null,
    }));
    return json({ currency: snap.currency, updatedAt: snap.updatedAt, days: out }, 200,
      { "Cache-Control": "public, max-age=60" });
  }

  if (p === "/api/quote" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const room = findRoom(env, b.slug);
    if (!room) return json({ ok: false, reason: "unknown_room" }, 400);
    const adults = Number.isInteger(b.adults) ? Math.min(Math.max(b.adults, 1), room.maxGuests) : 1;
    const q = await quote(env, room, b.checkIn, b.checkOut, adults);
    if (!q.ok) return json(q);
    return json({ ok: true, ...pricing(q, adults, b.breakfast === true, b.checkIn) });
  }

  if (p === "/api/verify/send" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim();
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, reason: "invalid_email" }, 400);
    const r = await sendVerifyCode(env, email, b.lang, url.origin);
    return json(r, r.ok ? 200 : r.reason === "too_soon" || r.reason === "too_many_sends" ? 429 : r.reason === "too_many_attempts" ? 403 : 400);
  }

  if (p === "/api/verify/check" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim();
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, reason: "invalid_email" }, 400);
    const r = await checkVerifyCode(env, email, b.code);
    return json(r, r.ok ? 200 : r.reason === "too_many_attempts" ? 403 : 400);
  }

  if (p === "/api/verify/reset" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const email = String(b.email ?? "").trim();
    // ο κωδικός ακυρώνεται και η αναμονή του 1 λεπτού μηδενίζεται → μπορεί να σταλεί αμέσως νέος
    // (το όριο αποστολών ανά ώρα εξακολουθεί να ισχύει)
    if (EMAIL_RE.test(email) && email.length <= 200)
      await Promise.all([env.CACHE.delete(otpKey(normEmail(email))), env.CACHE.delete(coolKey(normEmail(email)))]);
    return json({ ok: true });
  }

  if (p === "/api/enquiry" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    return enquiry(env, req, b);
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