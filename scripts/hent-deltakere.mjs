// Henter påmeldinger fra Shopify og skriver data/deltakere.json.
// Kjøres av .github/workflows/deltakere.yml hver time.
//
// Miljøvariabler (settes som secrets i GitHub):
//   SHOPIFY_STORE          f.eks. 6r5u10-uz.myshopify.com
//   SHOPIFY_CLIENT_ID      fra appen i Shopify Dev Dashboard
//   SHOPIFY_CLIENT_SECRET  fra appen i Shopify Dev Dashboard
//   (eller SHOPIFY_ADMIN_TOKEN hvis du har en ferdig shpat_-nøkkel)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const KAPASITET = 100;
const RACEDAG = new Date('2027-08-07');
// Bare påmeldinger fra og med 1. august 2026 (norsk tid) og frem til i dag
const SALG_START = '2026-08-01T00:00:00+02:00';
const API = '2026-10';
// Uten samtykke vises deltakeren bare i statistikken, ikke i listen
const KREV_SAMTYKKE = process.env.KREV_SAMTYKKE !== 'nei';
const SAMTYKKE_FELT = 'Vis i deltakerlisten';

const DISTANSER = {
  'halvdistanse-triatlon': '70.3',
  'halvdistanse-relay': '70.3 lag',
  'olympisk-distanse-triatlon': 'Olympisk +',
};

const LAND = [
  [/sverige|sweden|stockholm|göteborg|gothenburg|kiruna|luleå|malmö/i, 'Sverige'],
  [/storbritannia|united kingdom|\buk\b|england|scotland|skottland|wales|london|manchester/i, 'Storbritannia'],
  [/tyskland|germany|deutschland|berlin|hamburg|münchen|munich/i, 'Tyskland'],
  [/danmark|denmark|københavn|copenhagen/i, 'Danmark'],
  [/finland|suomi|helsinki/i, 'Finland'],
  [/nederland|netherlands|holland|amsterdam/i, 'Nederland'],
  [/\busa\b|united states|america/i, 'USA'],
];

const STEDER = JSON.parse(readFileSync(new URL('./steder.json', import.meta.url), 'utf8'));

const store = process.env.SHOPIFY_STORE;
if (!store) throw new Error('Mangler SHOPIFY_STORE');

async function token() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const r = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID ?? '',
      client_secret: process.env.SHOPIFY_CLIENT_SECRET ?? '',
    }),
  });
  if (!r.ok) throw new Error(`Fikk ikke tilgangsnøkkel fra Shopify (${r.status})`);
  return (await r.json()).access_token;
}

const QUERY = `query($cursor: String, $q: String) {
  orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt
      cancelledAt
      displayFinancialStatus
      lineItems(first: 20) {
        nodes { currentQuantity product { handle } customAttributes { key value } }
      }
    }
  }
}`;

async function hentOrdrer(tok) {
  const ut = [];
  let cursor = null;
  do {
    const r = await fetch(`https://${store}/admin/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query: QUERY, variables: { cursor, q: `created_at:>='${SALG_START}'` } }),
    });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error('Shopify-feil: ' + JSON.stringify(j.errors ?? r.status));
    ut.push(...j.data.orders.nodes);
    cursor = j.data.orders.pageInfo.hasNextPage ? j.data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return ut;
}

function alder(fodt) {
  const d = new Date(fodt);
  if (isNaN(d)) return null;
  let a = RACEDAG.getFullYear() - d.getFullYear();
  if (RACEDAG < new Date(RACEDAG.getFullYear(), d.getMonth(), d.getDate())) a--;
  return a > 0 && a < 100 ? a : null;
}

// Gjør fritekst ("Narvik", "Mo i Rana, Nordland", "Kiruna, Sverige") om til fylke eller land
function plasser(tekst) {
  const t = (tekst ?? '').trim();
  if (!t) return { fylke: null, land: null };
  for (const [re, land] of LAND) if (re.test(t)) return { fylke: null, land };
  const biter = [t, ...t.split(/[,/()\-]| og /)].map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const b of biter) if (STEDER[b]) return { fylke: STEDER[b], land: 'Norge' };
  return { fylke: null, land: null };
}

const pen = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function deltakere(ordrer) {
  const ut = [];
  for (const o of ordrer) {
    if (new Date(o.createdAt) < new Date(SALG_START)) continue;
    if (o.cancelledAt || ['REFUNDED', 'VOIDED'].includes(o.displayFinancialStatus)) continue;
    for (const li of o.lineItems.nodes) {
      const distanse = DISTANSER[li.product?.handle];
      if (!distanse || li.currentQuantity < 1) continue;
      const a = Object.fromEntries(li.customAttributes.map((x) => [x.key, x.value]));
      const samtykke = a[SAMTYKKE_FELT] === 'Ja';
      if (distanse === '70.3 lag') {
        const fra = a['Hvor kommer dere fra?'];
        for (let i = 1; i <= 3; i++) {
          const navn = pen(a[`Fullt navn på deltaker ${i}`]);
          if (!navn) continue;
          ut.push({ navn, alder: alder(a[`Fødselsdag til deltaker ${i}`]), kjonn: a[`Kjønn på deltaker ${i}`],
            distanse, lag: pen(a['Lagnavn']) || null, fra, samtykke });
        }
      } else {
        ut.push({ navn: pen(a['Fullt navn']), alder: alder(a['Fødselsdag']), kjonn: a['Kjønn'],
          distanse, lag: null, fra: a['Hvor kommer du fra?'], samtykke });
      }
    }
  }
  return ut;
}

const tell = (liste) => liste.reduce((m, k) => (k ? ((m[k] = (m[k] ?? 0) + 1), m) : m), {});

const alle = deltakere(await hentOrdrer(await token())).map((p) => ({ ...p, ...plasser(p.fra) }));

const data = {
  oppdatert: new Date().toISOString(),
  kapasitet: KAPASITET,
  antall: alle.length,
  statistikk: {
    kjonn: tell(alle.map((p) => p.kjonn)),
    distanse: tell(alle.map((p) => (p.distanse === 'Olympisk +' ? 'Olympisk +' : '70.3'))),
    fylker: tell(alle.map((p) => p.fylke)),
    utland: tell(alle.map((p) => (p.land && p.land !== 'Norge' ? p.land : null))),
    ukjent_sted: alle.filter((p) => !p.land).length,
  },
  deltakere: alle
    .filter((p) => p.samtykke || !KREV_SAMTYKKE)
    .map((p) => ({ navn: p.navn, alder: p.alder, sted: pen(p.fra) || '–', distanse: p.distanse, ...(p.lag ? { lag: p.lag } : {}) }))
    .sort((a, b) => (a.navn.split(' ').at(-1) + a.navn).localeCompare(b.navn.split(' ').at(-1) + b.navn, 'nb')),
};

// Behold forrige tidsstempel hvis ingenting er endret, så det ikke blir en commit hver time
try {
  const forrige = JSON.parse(readFileSync('data/deltakere.json', 'utf8'));
  if (JSON.stringify({ ...forrige, oppdatert: 0 }) === JSON.stringify({ ...data, oppdatert: 0 })) data.oppdatert = forrige.oppdatert;
} catch {}

mkdirSync('data', { recursive: true });
writeFileSync('data/deltakere.json', JSON.stringify(data, null, 1) + '\n');
console.log(`${data.antall} deltakere, ${data.deltakere.length} i listen, ${data.statistikk.ukjent_sted} uten kjent sted`);
