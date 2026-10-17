// Τυπώνει τα rentals και τα rate plans σας από το Hosthub,
// για να συμπληρώσετε το ROOMS στο wrangler.jsonc.
//
//   HOSTHUB_API_KEY=xxxx node scripts/setup-ids.mjs
//
// (Τρέχει τοπικά, μία φορά. Το key δεν αποθηκεύεται πουθενά.)

const BASE = "https://app.hosthub.com/api/2019-03-01";
const KEY = process.env.HOSTHUB_API_KEY;
if (!KEY) { console.error("Ορίστε HOSTHUB_API_KEY"); process.exit(1); }

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: KEY } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
  return body.data ?? body;
}

const rentals = await get("/rentals");
for (const r of rentals) {
  console.log(`\n■ ${r.name}  →  rentalId: ${r.id}`);
  try {
    const plans = await get(`/rentals/${r.id}/rate-plans`);   // ⚠️ ελέγξτε το path στο YAML
    for (const p of plans) console.log(`    rate plan: ${p.name ?? "(χωρίς όνομα)"}  →  ratePlanId: ${p.id}`);
  } catch (e) {
    console.log("    (δεν βρέθηκαν rate plans — ελέγξτε το path στο YAML)", e.message);
  }
}

// Δείγμα από τις απαντήσεις, για να επιβεβαιώσετε τα ονόματα πεδίων
if (rentals[0]) {
  const ev = await get(`/rentals/${rentals[0].id}/calendar-events`);
  console.log("\nΔείγμα calendar event:\n", JSON.stringify(ev[0] ?? null, null, 2));
}
