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

// Distansen leses fra produkttittelen på ordrelinjen (krever ikke read_products)
function distanseFra(tittel) {
  const t = tittel ?? '';
  if (/olympisk/i.test(t)) return 'Olympisk +';
  if (/halvdistanse|70\.3/i.test(t)) return /\blag\b|relay|stafett/i.test(t) ? '70.3 lag' : '70.3';
  return null;
}

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
const KORR = JSON.parse(readFileSync(new URL('./korrigeringer.json', import.meta.url), 'utf8'));
const nokkel = (navn) => (navn ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const INKLUDER = new Set((KORR.inkluder ?? []).map(nokkel));
const INKLUDER_ORDRER = new Set((KORR.inkluder_ordrer ?? []).map((o) => '#' + String(o).replace(/\D/g, '')));
const PERSONER = Object.fromEntries(Object.entries(KORR.personer ?? {}).map(([k, v]) => [nokkel(k), v]));
// Rettelser per lag, med lagnavnet slik det står i Shopify: { "sted": "Narvik", "etapper": { "Swim": "Navn", "Bike": "Navn", "Run": "Navn" } }
const LAG = Object.fromEntries(Object.entries(KORR.lag ?? {}).map(([k, v]) => [nokkel(k), v]));
// Deltaker 1, 2 og 3 i lagpåmeldingen tar svøm, sykkel og løp i den rekkefølgen
const ETAPPER = ['Swim', 'Bike', 'Run'];
// Personer på inkluder-listen hentes også hvis de meldte seg på før salgsstart
const HENT_FRA = INKLUDER.size ? '2026-01-01T00:00:00+01:00' : null;

const store = (process.env.SHOPIFY_STORE ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const mangler = ['SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'].filter((k) => !(process.env[k] ?? '').trim());
if (!process.env.SHOPIFY_ADMIN_TOKEN && mangler.length) {
  console.error(`FEIL: Disse secrets mangler eller er tomme i GitHub: ${mangler.join(', ')}`);
  process.exit(1);
}

let TILGANGER = null;
let ELDSTE = null;

async function token() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const r = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID.trim(),
      client_secret: process.env.SHOPIFY_CLIENT_SECRET.trim(),
    }),
  });
  const tekst = await r.text();
  if (!r.ok) {
    console.error(`FEIL: Shopify ga ikke tilgangsnøkkel (HTTP ${r.status}) for butikken ${store}.`);
    console.error('Svar fra Shopify: ' + (tekst.match(/<title>([^<]*)<\/title>/)?.[1] ?? tekst.slice(0, 500)));
    process.exit(1);
  }
  const j = JSON.parse(tekst);
  console.log(`Fikk tilgangsnøkkel. Tilganger: ${j.scope ?? 'ukjent'}`);
  TILGANGER = j.scope ?? null;
  if (TILGANGER && !TILGANGER.includes('read_all_orders')) {
    console.warn('ADVARSEL: Appen mangler read_all_orders. Ordrer eldre enn 60 dager blir ikke med.');
  }
  return j.access_token;
}

const QUERY = `query($cursor: String, $q: String) {
  orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name
      createdAt
      cancelledAt
      displayFinancialStatus
      lineItems(first: 20) {
        nodes { currentQuantity title customAttributes { key value } }
      }
    }
  }
}`;

async function hentSide(tok, q) {
  const ut = [];
  let cursor = null;
  do {
    const r = await fetch(`https://${store}/admin/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query: QUERY, variables: { cursor, q } }),
    });
    const tekst = await r.text();
    let j = null;
    try { j = JSON.parse(tekst); } catch {}
    if (!r.ok || !j || j.errors) {
      console.error(`FEIL: Henting av ordrer feilet (HTTP ${r.status}).`);
      console.error('Svar fra Shopify: ' + tekst.slice(0, 800));
      process.exit(1);
    }
    ut.push(...j.data.orders.nodes);
    cursor = j.data.orders.pageInfo.hasNextPage ? j.data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return ut;
}

// Arkiverte ordrer (status closed) kommer ikke alltid med i et vanlig søk, så de hentes i tillegg
async function hentOrdrer(tok) {
  const fra = `created_at:>='${HENT_FRA ?? SALG_START}'`;
  const alle = [...await hentSide(tok, fra), ...await hentSide(tok, `${fra} status:closed`)];
  const unike = new Map(alle.map((o) => [o.name, o]));
  console.log(`Hentet ${unike.size} ordrer`);
  ELDSTE = [...unike.values()].map((o) => o.createdAt).sort()[0] ?? null;
  return [...unike.values()];
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
  // Prøv hele teksten, så ord-grupper på 3, 2 og 1 ord ("Kragerø i Telemark", "Tromsø Triathlonklubb")
  const ord = t.toLowerCase().replace(/[^a-zæøåäöü\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const kandidater = [ord.join(' ')];
  for (let i = 0; i < ord.length; i++) for (const len of [3, 2, 1]) if (i + len <= ord.length) kandidater.push(ord.slice(i, i + len).join(' '));
  for (const k of kandidater) if (STEDER[k]) return { fylke: STEDER[k], land: 'Norge' };
  if (/\bnorge\b|\bnorway\b/i.test(t)) return { fylke: null, land: 'Norge' };
  return { fylke: null, land: null };
}

const aldersgruppe = (a) => a == null ? 'Ukjent' : a < 30 ? 'Under 30' : a < 40 ? '30–39' : a < 50 ? '40–49' : a < 60 ? '50–59' : '60+';
const pen = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
// Navn skrevet med bare små eller bare store bokstaver får stor forbokstav ("jan ivar andreassen" -> "Jan Ivar Andreassen")
const navnPen = (s) => {
  const t = pen(s);
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
};

// Ordrenummer 1066 blir startnummer 66, 1155 blir 155
const nummer = (navn) => { const n = parseInt(String(navn ?? '').replace(/\D/g, ''), 10); return isNaN(n) ? null : n >= 1000 ? n - 1000 : n; };

const utelatt = [];

function deltakere(ordrer) {
  const ut = [];
  for (const o of ordrer) {
    const forTidlig = new Date(o.createdAt) < new Date(SALG_START);
    const ugyldig = o.cancelledAt ? 'kansellert' : ['REFUNDED', 'VOIDED'].includes(o.displayFinancialStatus) ? 'refundert' : null;
    o.lineItems.nodes.forEach((li, linje) => {
      const distanse = distanseFra(li.title);
      const a = Object.fromEntries(li.customAttributes.map((x) => [x.key, x.value]));
      const personer = [];
      if (distanse === '70.3 lag') {
        for (let i = 1; i <= 3; i++) {
          const navn = navnPen(a[`Fullt navn på deltaker ${i}`]);
          if (navn) personer.push({ navn, alder: alder(a[`Fødselsdag til deltaker ${i}`]), kjonn: a[`Kjønn på deltaker ${i}`],
            distanse, lag: pen(a['Lagnavn']) || 'Lag uten navn', lagId: `${o.name}/${linje}`, etappe: ETAPPER[i - 1], fra: a['Hvor kommer dere fra?'] });
        }
      } else {
        personer.push({ navn: navnPen(a['Fullt navn']), alder: alder(a['Fødselsdag']), kjonn: a['Kjønn'],
          distanse, lag: null, fra: a['Hvor kommer du fra?'] });
      }
      for (const p of personer) {
        const tvungen = INKLUDER.has(nokkel(p.navn)) || INKLUDER_ORDRER.has(o.name);
        const grunn = !distanse ? 'ukjent produkt' : forTidlig ? 'før salgsstart' : ugyldig ?? (li.currentQuantity < 1 ? 'fjernet fra ordren' : null);
        if (grunn && !tvungen) {
          if (distanse || li.title) utelatt.push({ ordre: o.name, grunn, produkt: li.title });
          continue;
        }
        ut.push({ ...p, nr: nummer(o.name) });
      }
    });
  }
  return ut;
}

// Manuelle rettelser fra korrigeringer.json
function korriger(p) {
  const k = PERSONER[nokkel(p.navn)] ?? {};
  const fra = k.sted ?? (p.lagId && LAG[nokkel(p.lag)]?.sted) ?? KORR.steder?.[pen(p.fra)] ?? p.fra;
  return { ...p, ...k, fra, distanse: k.distanse ?? p.distanse };
}

const tell = (liste) => liste.reduce((m, k) => (k ? ((m[k] = (m[k] ?? 0) + 1), m) : m), {});

// Deltakere som ikke finnes som ordre i Shopify legges inn manuelt i korrigeringer.json
const fraShopify = deltakere(await hentOrdrer(await token()));
const finnes = new Set(fraShopify.map((p) => nokkel(p.navn)));
const ekstra = (KORR.ekstra ?? []).filter((e) => !finnes.has(nokkel(e.navn))).map((e) => ({ navn: e.navn, alder: e.alder ?? null, kjonn: e.kjonn, distanse: e.distanse,
  lag: e.lag ?? null, lagId: e.lag ? `ekstra/${e.lag}` : null, etappe: e.etappe ?? null, fra: e.sted, nr: e.nr ?? null }));
const alle = [...fraShopify, ...ekstra].map(korriger).map((p) => ({ ...p, ...plasser(p.fra) }));

// Et lag tar én startplass og vises som én rad, med medlemmene per etappe
function paameldinger(personer) {
  const lag = new Map(), ut = [];
  for (const p of personer) {
    if (!p.lagId) { ut.push({ nr: p.nr, navn: p.navn, alder: p.alder, sted: pen(p.fra) || '–', distanse: p.distanse }); continue; }
    if (!lag.has(p.lagId)) {
      const e = { nr: p.nr, navn: p.lag, alder: null, sted: pen(p.fra) || '–', distanse: p.distanse, medlemmer: [] };
      lag.set(p.lagId, e); ut.push(e);
    }
    lag.get(p.lagId).medlemmer.push({ etappe: p.etappe, navn: p.navn, alder: p.alder });
  }
  for (const e of lag.values()) {
    const k = LAG[nokkel(e.navn)]?.etapper;
    const alderFor = (navn) => e.medlemmer.find((m) => nokkel(m.navn) === nokkel(navn))?.alder ?? null;
    e.medlemmer = k ? ETAPPER.filter((x) => k[x]).map((x) => ({ etappe: x, navn: k[x], alder: alderFor(k[x]) }))
      : e.medlemmer.sort((a, b) => ETAPPER.indexOf(a.etappe) - ETAPPER.indexOf(b.etappe));
  }
  return ut;
}
const liste = paameldinger(alle);

const data = {
  oppdatert: new Date().toISOString(),
  kapasitet: KAPASITET,
  // Antall startplasser som er tatt (et lag teller som én). Statistikken under gjelder personer.
  antall: liste.length,
  personer: alle.length,
  statistikk: {
    kjonn: tell(alle.map((p) => p.kjonn)),
    distanse: tell(alle.map((p) => (p.distanse === 'Olympisk +' ? 'Olympisk +' : '70.3'))),
    fylker: tell(alle.map((p) => p.fylke)),
    utland: tell(alle.map((p) => (p.land && p.land !== 'Norge' ? p.land : null))),
    ukjent_sted: alle.filter((p) => !p.land).length,
    // Antall per kjønn, øvelse og aldersgruppe, uten navn, brukes til filtrering i Fordeling
    kryss: Object.entries(tell(alle.map((p) => [p.kjonn ?? 'Ukjent', p.distanse, aldersgruppe(p.alder)].join('|'))))
      .map(([k, n]) => [...k.split('|'), n]),
  },
  deltakere: liste
    .sort((a, b) => (a.navn.split(' ').at(-1) + a.navn).localeCompare(b.navn.split(' ').at(-1) + b.navn, 'nb')),
};

// Tidspunktet viser siste kjøring, så det oppdateres hver gang jobben går

mkdirSync('data', { recursive: true });
writeFileSync('data/deltakere.json', JSON.stringify(data, null, 1) + '\n');
// Kontrollrapport uten personopplysninger: hvilke ordrer som ble utelatt og hvorfor
const funnet = new Set(alle.map((p) => nokkel(p.navn)));
writeFileSync('data/kontroll.json', JSON.stringify({
  oppdatert: data.oppdatert,
  antall: data.antall,
  utelatt,
  inkluder_ikke_funnet: [...INKLUDER].filter((n) => !funnet.has(n)).length,
  tilganger: TILGANGER,
  eldste_ordre: ELDSTE,
}, null, 1) + '\n');
console.log(`Utelatt: ${utelatt.length} ordrelinjer. Se data/kontroll.json`);
console.log(`${data.antall} påmeldinger (${data.personer} personer), ${data.statistikk.ukjent_sted} uten kjent sted`);
