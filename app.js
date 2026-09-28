'use strict';
/* ============================================================
   Sopralluoghi DEC – prototipo PWA
   Dati nel browser (IndexedDB). Report: Word + Excel + foto in ZIP.
   ============================================================ */

// ---------- utilità ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const fDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const fTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fTimeS = d => `${fTime(d)}:${pad(d.getSeconds())}`;
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const GG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const CATCOL = { A: '#5f8f14', B: '#c27c0e', C: '#7a4fa3', D: '#1f6f8b', E: '#b3261e', F: '#646b72' };
const catColor = c => CATCOL[c] || '#646b72';
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

// ---------- database ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sopralluoghi-dec', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('cantieri', { keyPath: 'id' });
        d.createObjectStore('sopralluoghi', { keyPath: 'id' }).createIndex('cantiere', 'cantiereId');
        d.createObjectStore('segnalazioni', { keyPath: 'id' }).createIndex('sopralluogo', 'sopralluogoId');
        d.createObjectStore('foto', { keyPath: 'id' }).createIndex('segnalazione', 'segnalazioneId');
        d.createObjectStore('impostazioni', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  get: (s, id) => DB.tx(s, 'readonly', st => st.get(id)),
  put: (s, v) => DB.tx(s, 'readwrite', st => st.put(v)),
  del: (s, id) => DB.tx(s, 'readwrite', st => st.delete(id)),
  all: s => DB.tx(s, 'readonly', st => st.getAll()),
  by: (s, idx, v) => DB.tx(s, 'readonly', st => st.index(idx).getAll(v)),
};
async function persistStorage() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { } }

// ---------- impostazioni ----------
const DEF_SET = {
  id: 'main',
  intestazione: ['Ph. D. Arch. Cristoforo Pacella', 'Via Santa Lucia, 11', '85055 – Picerno (Pz)', '0971.991522 – 351.9290492', 'divisione.rifiuti@ecoplanurbanistica.it', 'Pec: infoecoplanurbanistica@pec.it'],
  firmaRuolo: "La Direzione dell'esecuzione del contratto",
  firmaNome: 'Ph. D. Arch. Cristoforo Pacella',
  logo: (typeof LOGO_B64 !== 'undefined') ? LOGO_B64 : null,
};
async function settings() { return Object.assign({}, DEF_SET, (await DB.get('impostazioni', 'main')) || {}); }

// ---------- geometria ----------
function nearestStreet(cantiere, lat, lon) {
  const fc = cantiere && cantiere.stradario; if (!fc || !fc.features) return null;
  const k = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  let best = null;
  for (const f of fc.features) {
    const g = f.geometry; if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
      const ax = (ln[i][0] - lon) * k, ay = (ln[i][1] - lat) * ky, bx = (ln[i + 1][0] - lon) * k, by = (ln[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.d) best = { d, p: f.properties || {} };
    }
  }
  if (!best) return null;
  const p = best.p;
  return { via: p.nome || p.name || p.NOME || p.denominazione || 'Tratto senza nome', lotto: p.lotto || p.LOTTO || '', dist: Math.round(best.d) };
}
function programmaVicino(cantiere, lotto, when, days = 7) {
  if (!cantiere || !cantiere.programma || !lotto) return [];
  const t = when.getTime(), D = days * 864e5;
  return cantiere.programma.filter(x => x.lotto === lotto && Math.abs(new Date(x.data + 'T08:00:00').getTime() - t) <= D);
}

// ---------- GPS ----------
const GPS = {
  watch: null, last: null, subs: new Set(),
  start() {
    if (this.watch !== null || !navigator.geolocation) return;
    this.watch = navigator.geolocation.watchPosition(p => {
      this.last = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: p.timestamp };
      this.subs.forEach(f => f(this.last, null));
    }, e => this.subs.forEach(f => f(null, e)), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  },
  stop() { if (this.watch !== null) navigator.geolocation.clearWatch(this.watch); this.watch = null; },
  on(f) { this.subs.add(f); if (this.last) f(this.last, null); return () => this.subs.delete(f); }
};
function gpsBox(el) {
  const draw = (p, e) => {
    if (e && !p) { el.innerHTML = `<span class="dot ko"></span><span>GPS non disponibile: ${esc(e.code === 1 ? 'permesso negato. Consenti la posizione per questo sito nelle impostazioni del browser.' : 'segnale assente, riprova all\'aperto.')}</span>`; return; }
    if (!p) { el.innerHTML = '<span class="dot"></span><span>Ricerca della posizione…</span>'; return; }
    const cls = p.acc <= 15 ? 'ok' : p.acc <= 40 ? 'med' : 'ko';
    el.innerHTML = `<span class="dot ${cls}"></span><span>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} · precisione ±${p.acc} m</span>`;
  };
  draw(GPS.last, null); return GPS.on(draw);
}

// ---------- foto ----------
function toDMS(v) {
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}
async function processPhoto(file, meta) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const MAX = 2000, sc = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  // fascia dati
  const fs = Math.max(16, Math.round(w / 55)), lh = fs * 1.35;
  const lines = [
    `${meta.via}${meta.lotto ? ' – lotto ' + meta.lotto : ''}`,
    meta.lat != null ? `${meta.lat.toFixed(6)}, ${meta.lon.toFixed(6)}  ±${meta.acc} m  (WGS84)` : 'Posizione GPS non disponibile',
    `${fDate(meta.ts)} ${fTimeS(meta.ts)}  ·  ${meta.cantiere}`,
  ];
  const bh = Math.round(lh * lines.length + fs * 0.9);
  g.fillStyle = 'rgba(0,0,0,0.58)'; g.fillRect(0, h - bh, w, bh);
  g.fillStyle = '#fff'; g.font = `600 ${fs}px system-ui, Roboto, Arial, sans-serif`; g.textBaseline = 'top';
  lines.forEach((t, i) => g.fillText(t, Math.round(fs * 0.6), h - bh + Math.round(fs * 0.45) + i * lh));
  let dataUrl = c.toDataURL('image/jpeg', 0.86);
  // EXIF: data/ora e GPS
  try {
    const ts = meta.ts; const dt = `${ts.getFullYear()}:${pad(ts.getMonth() + 1)}:${pad(ts.getDate())} ${fTimeS(ts)}`;
    const ex = { '0th': { [piexif.ImageIFD.Software]: 'Sopralluoghi DEC', [piexif.ImageIFD.DateTime]: dt, [piexif.ImageIFD.ImageDescription]: lines[0].normalize('NFD').replace(/[^\x20-\x7e]/g, '') }, Exif: { [piexif.ExifIFD.DateTimeOriginal]: dt }, GPS: {} };
    if (meta.lat != null) {
      ex.GPS[piexif.GPSIFD.GPSLatitudeRef] = meta.lat >= 0 ? 'N' : 'S'; ex.GPS[piexif.GPSIFD.GPSLatitude] = toDMS(meta.lat);
      ex.GPS[piexif.GPSIFD.GPSLongitudeRef] = meta.lon >= 0 ? 'E' : 'W'; ex.GPS[piexif.GPSIFD.GPSLongitude] = toDMS(meta.lon);
      ex.GPS[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';
    }
    dataUrl = piexif.insert(piexif.dump(ex), dataUrl);
  } catch (e) { console.warn('EXIF', e); }
  const blob = await (await fetch(dataUrl)).blob();
  return { blob, w, h };
}
function pickFile(accept, capture) {
  return new Promise(res => {
    const inp = capture ? $('#cam') : $('#filepick');
    inp.value = ''; if (!capture) inp.accept = accept || '';
    inp.onchange = () => res(inp.files[0] || null); inp.click();
  });
}

// ---------- router e layout ----------
let cleanup = [];
function setBar(title, back) {
  $('#title').textContent = title; const b = $('#back');
  b.hidden = !back; b.onclick = () => { location.hash = back; };
}
function setDock(html, onclick) {
  const d = $('#dock');
  if (!html) { d.hidden = true; d.innerHTML = ''; return; }
  d.hidden = false; d.innerHTML = html; d.querySelector('button').onclick = onclick;
}
$('#menu').onclick = () => { location.hash = '#/impostazioni'; };
async function route() {
  cleanup.forEach(f => { try { f(); } catch (e) { } }); cleanup = [];
  setDock(null); window.scrollTo(0, 0);
  const h = location.hash.replace(/^#\/?/, '').split('/');
  const v = $('#view');
  try {
    if (!h[0]) return viewHome(v);
    if (h[0] === 'impostazioni') return viewSettings(v);
    if (h[0] === 'cantiere' && h[1] === 'nuovo') return viewCantiereEdit(v, null);
    if (h[0] === 'cantiere' && h[2] === 'modifica') return viewCantiereEdit(v, h[1]);
    if (h[0] === 'cantiere') return viewCantiere(v, h[1]);
    if (h[0] === 'sopralluogo' && h[2] === 'dati') return viewSopralluogoEdit(v, h[1]);
    if (h[0] === 'sopralluogo') return viewSopralluogo(v, h[1]);
    if (h[0] === 'segnalazione') return viewSegnalazione(v, h[1], h[2]);
    location.hash = '#/';
  } catch (e) { console.error(e); v.innerHTML = `<div class="card">Errore: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// ---------- home ----------
async function viewHome(v) {
  setBar('Sopralluoghi DEC', null);
  const cc = (await DB.all('cantieri')).sort((a, b) => a.nome.localeCompare(b.nome));
  const sop = await DB.all('sopralluoghi');
  v.innerHTML = `<h2>Cantieri</h2><div id="cl"></div>
    <div class="btns"><button class="btn primary" id="nuovo">Nuovo cantiere</button><button class="btn" id="imp">Importa pacchetto cantiere</button><button class="btn" id="rest">Ripristina backup</button></div>
    <p class="muted" style="margin-top:18px">I dati restano in questo telefono. A fine giornata usa "Genera report" o "Esporta backup" dal sopralluogo per non perderli.</p>`;
  const cl = $('#cl');
  if (!cc.length) cl.innerHTML = '<div class="empty">Nessun cantiere. Creane uno o importa un pacchetto (per esempio quello di Teverola).</div>';
  cc.forEach(c => {
    const n = sop.filter(s => s.cantiereId === c.id).length;
    const b = document.createElement('button'); b.className = 'item';
    b.innerHTML = `<div class="grow"><div class="t">${esc(c.nome)}</div><div class="s">${esc(c.comune || '')} · ${n} sopralluogh${n === 1 ? 'o' : 'i'}${c.stradario ? ' · stradario caricato' : ''}</div></div><span class="chev">›</span>`;
    b.onclick = () => { location.hash = '#/cantiere/' + c.id; }; cl.appendChild(b);
  });
  $('#nuovo').onclick = () => { location.hash = '#/cantiere/nuovo'; };
  $('#imp').onclick = importPacchetto;
  $('#rest').onclick = restoreBackup;
}
async function importPacchetto() {
  const f = await pickFile('.json,application/json'); if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (!p.cantiere) throw new Error('il file non contiene un cantiere');
    const c = Object.assign({ id: uid(), creato: Date.now() }, p.cantiere, { stradario: p.stradario || null, programma: p.programma || [] });
    await DB.put('cantieri', c); toast('Cantiere importato'); location.hash = '#/cantiere/' + c.id;
  } catch (e) { toast('Pacchetto non valido: ' + e.message, 4000); }
}

// ---------- cantiere ----------
const DEF_CATS = [
  { cod: 'A', nome: 'Vegetazione infestante su marciapiedi, cordoli e cunette' },
  { cod: 'B', nome: 'Contenitori stracolmi o danneggiati' },
  { cod: 'C', nome: 'Rifiuti o abbandoni su suolo pubblico' },
  { cod: 'D', nome: 'Caditoie ostruite o criticità del piano stradale' },
  { cod: 'E', nome: 'Intervento programmato non eseguito' },
  { cod: 'F', nome: 'Altro' }];
async function viewCantiere(v, id) {
  const c = await DB.get('cantieri', id); if (!c) { location.hash = '#/'; return; }
  setBar(c.nome, '#/');
  const sop = (await DB.by('sopralluoghi', 'cantiere', id)).sort((a, b) => b.inizio - a.inizio);
  const oggi = isoDay(new Date());
  const prog = (c.programma || []).filter(x => x.data === oggi);
  v.innerHTML = `
    <div class="card"><dl class="kv">
      <dt>Comune</dt><dd>${esc(c.comune)}</dd><dt>Contratto</dt><dd>${esc(c.contratto)}</dd><dt>CIG</dt><dd>${esc(c.cig)}</dd>
      <dt>Appaltatore</dt><dd>${esc(c.appaltatore)}</dd><dt>RUP</dt><dd>${esc(c.rup)}</dd>
      <dt>Stradario</dt><dd>${c.stradario ? c.stradario.features.length + ' tratti' : 'non caricato'}</dd>
      <dt>Programma</dt><dd>${(c.programma || []).length} interventi</dd></dl>
      <div class="btns"><button class="btn" id="mod">Modifica cantiere</button></div></div>
    <h2>Interventi programmati oggi</h2>
    <div class="card">${prog.length ? prog.map(x => `<div class="row" style="margin:4px 0"><span class="tag">${esc(x.servizio)}</span><b>${esc(x.lotto === 'RIS' ? 'riserva Ente' : x.lotto)}</b><span class="muted">${esc(x.orario || '')}</span></div>`).join('') : '<span class="muted">Nessun intervento programmato per oggi.</span>'}</div>
    <h2>Sopralluoghi</h2><div id="sl"></div>`;
  const sl = $('#sl');
  if (!sop.length) sl.innerHTML = '<div class="empty">Nessun sopralluogo registrato.</div>';
  for (const s of sop) {
    const n = (await DB.by('segnalazioni', 'sopralluogo', s.id)).length;
    const b = document.createElement('button'); b.className = 'item'; const d = new Date(s.inizio);
    b.innerHTML = `<div class="grow"><div class="t">${GG[d.getDay()]} ${fDate(d)}</div><div class="s">${n} segnalazion${n === 1 ? 'e' : 'i'} · ${s.chiuso ? 'chiuso alle ' + fTime(new Date(s.chiuso)) : 'in corso'}</div></div><span class="chev">›</span>`;
    b.onclick = () => { location.hash = '#/sopralluogo/' + s.id; }; sl.appendChild(b);
  }
  $('#mod').onclick = () => { location.hash = `#/cantiere/${id}/modifica`; };
  setDock('<button class="btn accent">Inizia un sopralluogo</button>', async () => {
    const s = { id: uid(), cantiereId: id, inizio: Date.now(), chiuso: null, partecipanti: '', meteo: '', note: '', protocollo: '' };
    await DB.put('sopralluoghi', s); location.hash = '#/sopralluogo/' + s.id;
  });
}
async function viewCantiereEdit(v, id) {
  const c = id ? await DB.get('cantieri', id) : { id: uid(), creato: Date.now(), nome: '', comune: '', contratto: '', cig: '', appaltatore: '', rup: '', categorie: DEF_CATS, stradario: null, programma: [] };
  setBar(id ? 'Modifica cantiere' : 'Nuovo cantiere', id ? '#/cantiere/' + id : '#/');
  const F = (k, l, ph = '') => `<label class="f" for="f_${k}">${l}</label><input type="text" id="f_${k}" value="${esc(c[k] || '')}" placeholder="${esc(ph)}">`;
  v.innerHTML = `<div class="card">
    ${F('nome', 'Nome del cantiere', 'Es. Teverola – Igiene urbana')}${F('comune', 'Ente', 'Es. Comune di Teverola (CE)')}
    ${F('contratto', 'Oggetto del contratto')}${F('cig', 'CIG')}${F('appaltatore', 'Appaltatore')}${F('rup', 'RUP')}
    <label class="f" for="f_cat">Categorie di disservizio (una per riga, "codice | descrizione")</label>
    <textarea id="f_cat" rows="7">${esc((c.categorie || DEF_CATS).map(x => x.cod + ' | ' + x.nome).join('\n'))}</textarea></div>
    <div class="card"><b>Stradario</b><p class="muted" style="margin:4px 0 0">${c.stradario ? c.stradario.features.length + ' tratti caricati.' : 'Non caricato.'} Serve a riconoscere la strada e il lotto di ogni segnalazione. Accetta GeoJSON o shapefile compresso in .zip (esportato da QGIS; il campo del nome può chiamarsi "name" o "nome", quello del lotto "lotto").</p>
      <div class="btns"><button class="btn" id="str">Carica stradario</button></div></div>
    <div class="btns"><button class="btn primary" id="save">Salva</button>${id ? '<button class="btn danger" id="del">Elimina cantiere</button>' : ''}</div>`;
  $('#str').onclick = async () => {
    const f = await pickFile('.geojson,.json,.zip'); if (!f) return;
    try {
      let gj;
      if (/\.zip$/i.test(f.name)) { gj = await shp(await f.arrayBuffer()); if (Array.isArray(gj)) gj = { type: 'FeatureCollection', features: gj.flatMap(x => x.features) }; }
      else gj = JSON.parse(await f.text());
      if (!gj.features) throw new Error('nessun elemento trovato');
      gj.features = gj.features.filter(x => x.geometry && /LineString/.test(x.geometry.type));
      c.stradario = gj; toast(`Stradario letto: ${gj.features.length} tratti. Premi Salva.`);
    } catch (e) { toast('Stradario non leggibile: ' + e.message, 4000); }
  };
  $('#save').onclick = async () => {
    ['nome', 'comune', 'contratto', 'cig', 'appaltatore', 'rup'].forEach(k => c[k] = $('#f_' + k).value.trim());
    if (!c.nome) { toast('Indica il nome del cantiere'); return; }
    c.categorie = $('#f_cat').value.split('\n').map(r => r.split('|')).filter(r => r[0].trim()).map(r => ({ cod: r[0].trim(), nome: (r[1] || r[0]).trim() }));
    await DB.put('cantieri', c); toast('Cantiere salvato'); location.hash = '#/cantiere/' + c.id;
  };
  if (id) $('#del').onclick = async () => {
    const ss = await DB.by('sopralluoghi', 'cantiere', id);
    if (!confirm(`Eliminare il cantiere e i suoi ${ss.length} sopralluoghi con tutte le foto? L'operazione non si può annullare.`)) return;
    for (const s of ss) await deleteSopralluogo(s.id);
    await DB.del('cantieri', id); location.hash = '#/';
  };
}

// ---------- sopralluogo ----------
async function deleteSopralluogo(id) {
  for (const s of await DB.by('segnalazioni', 'sopralluogo', id)) {
    for (const f of await DB.by('foto', 'segnalazione', s.id)) await DB.del('foto', f.id);
    await DB.del('segnalazioni', s.id);
  }
  await DB.del('sopralluoghi', id);
}
async function viewSopralluogo(v, id) {
  const s = await DB.get('sopralluoghi', id); if (!s) { location.hash = '#/'; return; }
  const c = await DB.get('cantieri', s.cantiereId); const d = new Date(s.inizio);
  setBar(`Sopralluogo ${fDate(d)}`, '#/cantiere/' + c.id);
  const seg = (await DB.by('segnalazioni', 'sopralluogo', id)).sort((a, b) => a.n - b.n);
  v.innerHTML = `<div id="map" role="region" aria-label="Mappa del sopralluogo"></div>
    <div class="gps" id="gps"></div>
    <div class="card" style="margin-top:10px"><dl class="kv"><dt>Cantiere</dt><dd>${esc(c.nome)}</dd><dt>Inizio</dt><dd>${GG[d.getDay()]} ${fDate(d)} ore ${fTime(d)}</dd>
      <dt>Stato</dt><dd>${s.chiuso ? 'chiuso alle ' + fTime(new Date(s.chiuso)) : 'in corso'}</dd><dt>Partecipanti</dt><dd>${esc(s.partecipanti || '—')}</dd></dl>
      <div class="btns"><button class="btn" id="dati">Dati del sopralluogo</button>
      ${s.chiuso ? '<button class="btn" id="riapri">Riapri</button>' : '<button class="btn" id="chiudi">Chiudi sopralluogo</button>'}</div></div>
    <h2>Segnalazioni (${seg.length})</h2><div id="sl"></div>
    <h2>Report e dati</h2><div class="card">
      <p class="muted" style="margin-top:0">Il report contiene il verbale Word, il registro Excel, le foto georiferite e un file GeoJSON, in un unico archivio .zip.</p>
      <div class="btns"><button class="btn primary" id="rep" ${seg.length ? '' : 'disabled'}>Genera report</button><button class="btn" id="bk">Esporta backup</button><button class="btn danger" id="del">Elimina sopralluogo</button></div>
      <div class="prog" id="pg" hidden><i></i></div></div>`;
  // mappa
  const map = L.map('map', { zoomControl: true }).setView([41, 14.2], 15);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' }).addTo(map);
  if (c.stradario) {
    const gl = L.geoJSON(c.stradario, { style: f => ({ color: f.properties && f.properties.lotto && /^M/.test(f.properties.lotto) ? '#25292d' : '#8c9196', weight: f.properties && /^M/.test(f.properties.lotto || '') ? 3 : 1.5, opacity: .7 }), interactive: false }).addTo(map);
    try { map.fitBounds(gl.getBounds(), { padding: [10, 10] }); } catch (e) { }
  }
  const pts = [];
  seg.forEach(x => {
    if (x.lat == null) return;
    const m = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html: `<div class="pin" style="background:${catColor(x.categoria)}">${x.n}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
    m.on('click', () => { location.hash = `#/segnalazione/${id}/${x.id}`; }); pts.push([x.lat, x.lon]);
  });
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 18 });
  const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 });
  GPS.start();
  cleanup.push(GPS.on(p => { if (p) { me.setLatLng([p.lat, p.lon]); if (!map.hasLayer(me)) me.addTo(map); } }));
  cleanup.push(gpsBox($('#gps')));
  cleanup.push(() => map.remove());
  // elenco
  const sl = $('#sl');
  if (!seg.length) sl.innerHTML = '<div class="empty">Nessuna segnalazione. Usa il pulsante in basso per scattare la prima foto.</div>';
  for (const x of seg) {
    const nf = (await DB.by('foto', 'segnalazione', x.id)).length;
    const b = document.createElement('button'); b.className = 'item';
    b.innerHTML = `<span class="badge" style="background:${catColor(x.categoria)}">${esc(x.categoria)}</span><div class="grow"><div class="t">${x.n}. ${esc(x.via)}${x.lotto ? ' · ' + esc(x.lotto) : ''}</div>
      <div class="s">${fTime(new Date(x.ts))} · ${nf} foto${x.gravita === 'Alta' ? ' · <span class="tag alta">gravità alta</span>' : ''} ${esc((x.descrizione || '').slice(0, 60))}</div></div><span class="chev">›</span>`;
    b.onclick = () => { location.hash = `#/segnalazione/${id}/${x.id}`; }; sl.appendChild(b);
  }
  $('#dati').onclick = () => { location.hash = `#/sopralluogo/${id}/dati`; };
  if ($('#chiudi')) $('#chiudi').onclick = async () => { s.chiuso = Date.now(); await DB.put('sopralluoghi', s); route(); };
  if ($('#riapri')) $('#riapri').onclick = async () => { s.chiuso = null; await DB.put('sopralluoghi', s); route(); };
  $('#rep').onclick = () => reportDialog(s, c);
  $('#bk').onclick = () => exportBackup(s, c);
  $('#del').onclick = async () => { if (confirm('Eliminare il sopralluogo con tutte le segnalazioni e le foto?')) { await deleteSopralluogo(id); location.hash = '#/cantiere/' + c.id; } };
  if (!s.chiuso) setDock('<button class="btn accent">📷  Scatta e segnala</button>', () => { location.hash = `#/segnalazione/${id}/nuova`; });
}
async function viewSopralluogoEdit(v, id) {
  const s = await DB.get('sopralluoghi', id); setBar('Dati del sopralluogo', '#/sopralluogo/' + id);
  const d = new Date(s.inizio), e = s.chiuso ? new Date(s.chiuso) : null;
  v.innerHTML = `<div class="card">
    <label class="f" for="d">Data</label><input type="date" id="d" value="${isoDay(d)}">
    <div class="row"><div style="flex:1"><label class="f" for="hi">Ora di inizio</label><input type="time" id="hi" value="${fTime(d)}"></div>
    <div style="flex:1"><label class="f" for="hf">Ora di fine</label><input type="time" id="hf" value="${e ? fTime(e) : ''}"></div></div>
    <label class="f" for="pa">Partecipanti</label><input type="text" id="pa" value="${esc(s.partecipanti)}" placeholder="Es. DEC; per l'Appaltatore: responsabile di cantiere">
    <label class="f" for="me">Condizioni meteo</label><input type="text" id="me" value="${esc(s.meteo)}" placeholder="Es. sereno, asciutto">
    <label class="f" for="no">Note del sopralluogo</label><textarea id="no">${esc(s.note)}</textarea></div>
    <div class="btns"><button class="btn primary" id="save">Salva</button></div>`;
  $('#save').onclick = async () => {
    const [y, m, dd] = $('#d').value.split('-').map(Number); const [h1, m1] = ($('#hi').value || '00:00').split(':').map(Number);
    s.inizio = new Date(y, m - 1, dd, h1, m1).getTime();
    if ($('#hf').value) { const [h2, m2] = $('#hf').value.split(':').map(Number); s.chiuso = new Date(y, m - 1, dd, h2, m2).getTime(); }
    s.partecipanti = $('#pa').value.trim(); s.meteo = $('#me').value.trim(); s.note = $('#no').value.trim();
    await DB.put('sopralluoghi', s); toast('Dati salvati'); location.hash = '#/sopralluogo/' + id;
  };
}

// ---------- segnalazione ----------
async function viewSegnalazione(v, sopId, segId) {
  const s = await DB.get('sopralluoghi', sopId); const c = await DB.get('cantieri', s.cantiereId);
  const nuova = segId === 'nuova';
  let x = nuova ? null : await DB.get('segnalazioni', segId);
  const all = await DB.by('segnalazioni', 'sopralluogo', sopId);
  if (nuova) x = { id: uid(), sopralluogoId: sopId, n: all.reduce((m, y) => Math.max(m, y.n), 0) + 1, ts: Date.now(), lat: null, lon: null, acc: null, via: '', lotto: '', dist: null, categoria: '', gravita: 'Media', descrizione: '', _new: true };
  setBar(nuova ? `Nuova segnalazione n. ${x.n}` : `Segnalazione n. ${x.n}`, '#/sopralluogo/' + sopId);
  let fotos = nuova ? [] : await DB.by('foto', 'segnalazione', x.id);
  const pending = []; // foto nuove non ancora salvate
  const cats = c.categorie && c.categorie.length ? c.categorie : DEF_CATS;
  v.innerHTML = `
    <div class="card"><b>Foto</b><div class="photos" id="ph"></div></div>
    <div class="card"><b>Posizione</b><div class="gps" id="gps" style="margin-top:8px"></div>
      <label class="f" for="via">Strada</label><input type="text" id="via" value="${esc(x.via)}" placeholder="Rilevata dallo stradario">
      <div class="row"><div style="flex:1"><label class="f" for="lot">Lotto</label><input type="text" id="lot" value="${esc(x.lotto)}"></div>
      <div style="flex:1"><label class="f">&nbsp;</label><button class="btn block" id="fix">Aggiorna posizione</button></div></div>
      <p class="muted" id="prg" style="margin:10px 0 0"></p></div>
    <div class="card"><b>Disservizio</b><div class="cats" id="cats" style="margin-top:8px" role="radiogroup" aria-label="Categoria"></div>
      <label class="f">Gravità</label><div class="seg" id="grv">${['Bassa', 'Media', 'Alta'].map(g => `<button aria-pressed="${x.gravita === g}" data-g="${g}">${g}</button>`).join('')}</div>
      <label class="f" for="ds">Descrizione</label><textarea id="ds" placeholder="Cosa si vede, estensione, eventuale riferimento contrattuale">${esc(x.descrizione)}</textarea></div>
    <div class="btns">${nuova ? '' : '<button class="btn danger" id="del">Elimina segnalazione</button>'}</div>`;
  // categorie
  const cw = $('#cats');
  cats.forEach(k => {
    const b = document.createElement('button'); b.className = 'cat'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-pressed', String(x.categoria === k.cod)); b.setAttribute('aria-checked', String(x.categoria === k.cod));
    b.innerHTML = `<span class="k" style="background:${catColor(k.cod)}">${esc(k.cod)}</span><span>${esc(k.nome)}</span>`;
    b.onclick = () => { x.categoria = k.cod; cw.querySelectorAll('.cat').forEach(y => { y.setAttribute('aria-pressed', String(y === b)); y.setAttribute('aria-checked', String(y === b)); }); };
    cw.appendChild(b);
  });
  $('#grv').querySelectorAll('button').forEach(b => b.onclick = () => { x.gravita = b.dataset.g; $('#grv').querySelectorAll('button').forEach(y => y.setAttribute('aria-pressed', String(y === b))); });
  // posizione
  GPS.start(); cleanup.push(gpsBox($('#gps')));
  const applyPos = p => {
    x.lat = p.lat; x.lon = p.lon; x.acc = p.acc;
    const ns = nearestStreet(c, p.lat, p.lon);
    if (ns && ns.dist <= 80) { x.via = ns.via; x.lotto = ns.lotto; x.dist = ns.dist; $('#via').value = ns.via; $('#lot').value = ns.lotto || ''; }
    showProg();
  };
  const showProg = () => {
    const lotto = $('#lot').value.trim(); const pp = programmaVicino(c, lotto, new Date(x.ts));
    $('#prg').innerHTML = lotto ? (pp.length ? 'Programma sul lotto ±7 giorni: ' + pp.map(y => `${esc(y.servizio)} ${y.data.split('-').reverse().join('/')}`).join('; ') : 'Nessun intervento programmato sul lotto nei 7 giorni prima o dopo.') : '';
  };
  $('#lot').oninput = showProg; showProg();
  if (nuova) {
    let first = true;
    cleanup.push(GPS.on(p => { if (p && (first || (x.acc && p.acc < x.acc))) { first = false; applyPos(p); } }));
  }
  $('#fix').onclick = () => { if (GPS.last) { applyPos(GPS.last); toast('Posizione aggiornata'); } else toast('Posizione non ancora disponibile'); };
  // foto
  const drawPh = () => {
    const ph = $('#ph'); ph.innerHTML = '';
    [...fotos.map(f => ({ f, saved: true })), ...pending.map(f => ({ f, saved: false }))].forEach(({ f, saved }) => {
      const fig = document.createElement('figure'); const url = URL.createObjectURL(f.blob);
      fig.innerHTML = `<img src="${url}" alt="Foto della segnalazione"><button aria-label="Rimuovi foto">✕</button>`;
      fig.querySelector('button').onclick = async () => {
        if (!confirm('Rimuovere questa foto?')) return;
        if (saved) { await DB.del('foto', f.id); fotos = fotos.filter(y => y !== f); } else pending.splice(pending.indexOf(f), 1);
        drawPh();
      };
      ph.appendChild(fig);
    });
    const add = document.createElement('button'); add.className = 'addph'; add.innerHTML = '📷<br>Aggiungi foto'; add.onclick = takePhoto; ph.appendChild(add);
  };
  const takePhoto = async () => {
    const file = await pickFile('image/*', true); if (!file) return;
    const ts = new Date(); const p = GPS.last;
    if (p && (x.lat == null || (pending.length + fotos.length) === 0)) applyPos(p);
    if (pending.length + fotos.length === 0) x.ts = ts.getTime();
    toast('Elaborazione della foto…', 1500);
    const r = await processPhoto(file, { via: $('#via').value || 'Strada non rilevata', lotto: $('#lot').value, lat: p ? p.lat : x.lat, lon: p ? p.lon : x.lon, acc: p ? p.acc : x.acc, ts, cantiere: c.nome });
    pending.push({ id: uid(), segnalazioneId: x.id, blob: r.blob, w: r.w, h: r.h, ts: ts.getTime(), lat: p ? p.lat : x.lat, lon: p ? p.lon : x.lon });
    drawPh();
  };
  drawPh();
  if (nuova) setTimeout(takePhoto, 250);
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm('Eliminare la segnalazione e le sue foto?')) return;
    for (const f of fotos) await DB.del('foto', f.id); await DB.del('segnalazioni', x.id); location.hash = '#/sopralluogo/' + sopId;
  };
  setDock('<button class="btn primary">Salva segnalazione</button>', async () => {
    if (!x.categoria) { toast('Scegli la categoria del disservizio'); return; }
    if (!fotos.length && !pending.length && !confirm('Salvare senza foto?')) return;
    x.via = $('#via').value.trim() || 'Strada non rilevata'; x.lotto = $('#lot').value.trim(); x.descrizione = $('#ds').value.trim();
    delete x._new; await DB.put('segnalazioni', x);
    for (const f of pending) await DB.put('foto', f);
    toast(`Segnalazione n. ${x.n} salvata`); location.hash = '#/sopralluogo/' + sopId;
  });
}

// ---------- impostazioni ----------
async function viewSettings(v) {
  setBar('Impostazioni', '#/'); const st = await settings();
  v.innerHTML = `<div class="card">
    <label class="f" for="in">Intestazione dei documenti (una riga per voce)</label><textarea id="in" rows="6">${esc(st.intestazione.join('\n'))}</textarea>
    <label class="f" for="fr">Firma – ruolo</label><input type="text" id="fr" value="${esc(st.firmaRuolo)}">
    <label class="f" for="fn">Firma – nome</label><input type="text" id="fn" value="${esc(st.firmaNome)}">
    <label class="f">Logo nel piè di pagina</label>
    <div class="row">${st.logo ? `<img src="data:image/png;base64,${st.logo}" alt="Logo attuale" style="height:40px;background:#fff">` : '<span class="muted">Nessun logo</span>'}<button class="btn" id="lg">Cambia logo</button></div></div>
    <div class="btns"><button class="btn primary" id="save">Salva</button></div>
    <h2>Archivio del telefono</h2><div class="card"><p class="muted" id="sp" style="margin:0">Calcolo dello spazio…</p></div>`;
  let logo = st.logo;
  $('#lg').onclick = async () => {
    const f = await pickFile('image/png,image/jpeg'); if (!f) return;
    const bmp = await createImageBitmap(f); const cv = document.createElement('canvas'); const sc = Math.min(1, 800 / bmp.width);
    cv.width = bmp.width * sc; cv.height = bmp.height * sc; cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    logo = cv.toDataURL('image/png').split(',')[1]; toast('Logo caricato. Premi Salva.');
  };
  $('#save').onclick = async () => {
    await DB.put('impostazioni', { id: 'main', intestazione: $('#in').value.split('\n').map(s => s.trim()).filter(Boolean), firmaRuolo: $('#fr').value.trim(), firmaNome: $('#fn').value.trim(), logo });
    toast('Impostazioni salvate');
  };
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { $('#sp').textContent = `Spazio usato: ${(e.usage / 1048576).toFixed(1)} MB su ${(e.quota / 1048576).toFixed(0)} MB disponibili.`; });
}

// ---------- planimetria (canvas, senza sfondo) ----------
function planimetria(c, seg, W = 1800, H = 1300) {
  const pts = seg.filter(x => x.lat != null);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.lon); maxX = Math.max(maxX, p.lon); minY = Math.min(minY, p.lat); maxY = Math.max(maxY, p.lat); });
  if (!pts.length && c.stradario) c.stradario.features.forEach(f => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(l => l.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); })));
  if (!isFinite(minX)) return null;
  const lat0 = (minY + maxY) / 2, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  let wm = (maxX - minX) * kx, hm = (maxY - minY) * ky; const padm = Math.max(120, Math.max(wm, hm) * 0.12);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2; wm += 2 * padm; hm += 2 * padm;
  const sc = Math.min((W - 80) / wm, (H - 80) / hm);
  const P = (lon, lat) => [W / 2 + (lon - cx) * kx * sc, H / 2 - (lat - cy) * ky * sc];
  if (c.stradario) c.stradario.features.forEach(f => {
    const man = /^M/.test((f.properties || {}).lotto || '');
    g.strokeStyle = man ? '#6d7278' : '#b8bcbf'; g.lineWidth = man ? 3 : 1.6;
    (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(l => { g.beginPath(); l.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); });
  });
  pts.forEach(p => {
    const [a, b] = P(p.lon, p.lat);
    g.beginPath(); g.arc(a, b, 20, 0, 2 * Math.PI); g.fillStyle = catColor(p.categoria); g.fill(); g.lineWidth = 4; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(p.n), a, b + 1);
  });
  // scala e nord
  const nice = [25, 50, 100, 200, 250, 500, 1000]; const target = (W * 0.18) / sc; const L = nice.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  g.strokeStyle = '#000'; g.lineWidth = 5; g.beginPath(); g.moveTo(50, H - 50); g.lineTo(50 + L * sc, H - 50); g.stroke();
  g.fillStyle = '#000'; g.font = '24px Arial'; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(`${L} m`, 50, H - 60);
  g.beginPath(); g.moveTo(W - 60, 40); g.lineTo(W - 75, 90); g.lineTo(W - 45, 90); g.closePath(); g.fill(); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText('N', W - 60, 96);
  g.strokeStyle = '#999'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
  return cv;
}
const canvasBytes = cv => new Promise(r => cv.toBlob(b => b.arrayBuffer().then(a => r(new Uint8Array(a))), 'image/png'));

// ---------- report ----------
function reportDialog(s, c) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<h3 style="margin:0 0 6px">Genera report</h3>
    <label class="f" for="rp">Protocollo</label><input type="text" id="rp" value="${esc(s.protocollo || '')}" placeholder="Es. Prot_DEC_13_02.10.2026">
    <label class="f" for="rd">Destinatari (uno per riga)</label><textarea id="rd" rows="4">${esc(s.destinatari || [c.appaltatore, c.comune, c.rup ? 'RUP: ' + c.rup : ''].filter(Boolean).join('\n'))}</textarea>
    <div class="btns"><button class="btn primary" id="go">Genera e scarica</button><button class="btn" id="an">Annulla</button></div>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.querySelector('#an').onclick = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('#go').onclick = async () => {
    s.protocollo = dlg.querySelector('#rp').value.trim(); s.destinatari = dlg.querySelector('#rd').value;
    await DB.put('sopralluoghi', s); dlg.close(); dlg.remove();
    try { await generaReport(s, c); } catch (e) { console.error(e); toast('Errore nella generazione: ' + e.message, 5000); }
  };
}
function progress(p) { const pg = $('#pg'); if (!pg) return; pg.hidden = p == null; if (p != null) pg.firstElementChild.style.width = Math.round(p * 100) + '%'; }
async function imgSize(blob) { const b = await createImageBitmap(blob); return [b.width, b.height]; }

async function generaReport(s, c) {
  progress(0.02);
  const st = await settings();
  const seg = (await DB.by('segnalazioni', 'sopralluogo', s.id)).sort((a, b) => a.n - b.n);
  const fotoBy = {}; for (const x of seg) fotoBy[x.id] = (await DB.by('foto', 'segnalazione', x.id)).sort((a, b) => a.ts - b.ts);
  const d = new Date(s.inizio), e = s.chiuso ? new Date(s.chiuso) : null;
  const base = `Sopralluogo_${slug(c.comune || c.nome)}_${isoDay(d)}`;
  const catName = k => ((c.categorie || DEF_CATS).find(x => x.cod === k) || { nome: k }).nome;
  const zip = new JSZip(); const fdir = zip.folder('foto');
  // nomi file foto
  const fname = {}; seg.forEach(x => fotoBy[x.id].forEach((f, i) => { fname[f.id] = `S${pad(x.n)}_${x.categoria}_${i + 1}.jpg`; fdir.file(fname[f.id], f.blob); }));
  progress(0.15);
  // planimetria
  const cv = planimetria(c, seg); let planBytes = null;
  if (cv) { planBytes = await canvasBytes(cv); zip.file('planimetria.png', planBytes); }
  progress(0.25);
  // ---------- Word ----------
  const X = docx; const FONT = 'Times New Roman', cm = v => Math.round(v * 567);
  const T = (text, o = {}) => new X.TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 22, bold: o.b, italics: o.i, underline: o.u ? {} : undefined, color: o.color });
  const Pp = (runs, o = {}) => new X.Paragraph({ children: Array.isArray(runs) ? runs : [T(runs, o)], alignment: o.al || X.AlignmentType.JUSTIFIED, spacing: { after: o.after ?? 120, before: o.before || 0, line: 276 }, keepNext: o.keepNext, indent: o.indent });
  const H = t => new X.Paragraph({ children: [T(t, { b: true })], spacing: { before: 240, after: 120 }, keepNext: true });
  const bd = { style: X.BorderStyle.SINGLE, size: 4, color: '808080' }, borders = { top: bd, bottom: bd, left: bd, right: bd };
  const cell = (txt, w, o = {}) => new X.TableCell({
    borders, width: { size: cm(w), type: X.WidthType.DXA }, verticalAlign: X.VerticalAlign.CENTER,
    shading: o.fill ? { fill: o.fill, type: X.ShadingType.CLEAR, color: 'auto' } : undefined, margins: { top: 40, bottom: 40, left: 70, right: 70 },
    children: (Array.isArray(txt) ? txt : [txt]).map(t => new X.Paragraph({ alignment: o.center ? X.AlignmentType.CENTER : X.AlignmentType.LEFT, spacing: { after: 0 }, children: [T(t, { size: 18, b: o.b })] }))
  });
  const table = (cols, widths, rows, center = []) => new X.Table({
    width: { size: cm(widths.reduce((a, b) => a + b, 0)), type: X.WidthType.DXA }, columnWidths: widths.map(cm), layout: X.TableLayoutType.FIXED,
    rows: [new X.TableRow({ tableHeader: true, children: cols.map((h, j) => cell(h, widths[j], { fill: 'D9D9D9', b: true, center: true })) }),
    ...rows.map(r => new X.TableRow({ cantSplit: true, children: r.map((v, j) => cell(v, widths[j], { center: center.includes(j) })) }))]
  });
  const kv = rows => new X.Table({
    width: { size: cm(16), type: X.WidthType.DXA }, columnWidths: [cm(4.2), cm(11.8)], layout: X.TableLayoutType.FIXED,
    rows: rows.map(([k, v]) => new X.TableRow({ cantSplit: true, children: [cell(k, 4.2, { fill: 'F2F2F2', b: true }), cell(v, 11.8)] }))
  });
  const header = new X.Header({ children: st.intestazione.map((l, i) => new X.Paragraph({ alignment: X.AlignmentType.CENTER, spacing: { after: 0 }, children: [T(l, { size: 18, b: i === 0, u: i === st.intestazione.length - 1 })] })) });
  const footKids = [];
  if (st.logo) {
    const lb = Uint8Array.from(atob(st.logo), ch => ch.charCodeAt(0)); const [lw, lh] = await imgSize(new Blob([lb], { type: 'image/png' }));
    footKids.push(new X.Paragraph({ alignment: X.AlignmentType.CENTER, spacing: { after: 0 }, children: [new X.ImageRun({ type: 'png', data: lb, transformation: { width: 159, height: Math.round(159 * lh / lw) } })] }));
  }
  footKids.push(new X.Paragraph({ alignment: X.AlignmentType.RIGHT, spacing: { after: 0 }, children: [new X.TextRun({ font: FONT, size: 14, color: '808080', children: ['pag. ', X.PageNumber.CURRENT, ' di ', X.PageNumber.TOTAL_PAGES] })] }));
  const footer = new X.Footer({ children: footKids });
  const body = [];
  body.push(new X.Paragraph({ tabStops: [{ type: X.TabStopType.RIGHT, position: cm(16) }], spacing: { after: 240 }, children: [T(s.protocollo || '', { b: true, i: true }), T(`\t${fDate(new Date())}`, { b: true, i: true })] }));
  (s.destinatari || '').split('\n').map(t => t.trim()).filter(Boolean).forEach(t => body.push(new X.Paragraph({ indent: { left: cm(9) }, spacing: { after: 0 }, children: [T(t, { size: 20, b: true, i: true })] })));
  body.push(Pp([T('OGGETTO: ', { b: true }), T(`${c.contratto || c.nome}${c.cig ? ' (CIG: ' + c.cig + ')' : ''} – VERBALE DI SOPRALLUOGO DEL ${fDate(d)}.`, { b: true })], { before: 360, after: 240 }));
  body.push(H('1. Dati del sopralluogo'));
  body.push(kv([['Ente', c.comune || ''], ['Contratto', c.contratto || ''], ['CIG', c.cig || ''], ['Appaltatore', c.appaltatore || ''], ['RUP', c.rup || ''],
  ['Data', `${GG[d.getDay()]} ${fDate(d)}`], ['Orario', `dalle ${fTime(d)}${e ? ' alle ' + fTime(e) : ''}`], ['Partecipanti', s.partecipanti || '—'], ['Condizioni meteo', s.meteo || '—'], ['Segnalazioni', String(seg.length)]]));
  if (s.note) { body.push(H('2. Esito del sopralluogo')); s.note.split('\n').filter(Boolean).forEach(t => body.push(Pp(t))); }
  let nsec = s.note ? 3 : 2;
  body.push(H(`${nsec++}. Sintesi per categoria`));
  const cnt = {}; seg.forEach(x => { cnt[x.categoria] = (cnt[x.categoria] || 0) + 1; });
  body.push(table(['Cat.', 'Descrizione', 'N.', 'Gravità alta'], [1.3, 10.7, 1.6, 2.4], Object.keys(cnt).sort().map(k => [k, catName(k), String(cnt[k]), String(seg.filter(x => x.categoria === k && x.gravita === 'Alta').length)]), [0, 2, 3]));
  if (planBytes) {
    body.push(H(`${nsec++}. Planimetria dei punti rilevati`));
    body.push(new X.Paragraph({ alignment: X.AlignmentType.CENTER, keepNext: true, children: [new X.ImageRun({ type: 'png', data: planBytes, transformation: { width: 600, height: Math.round(600 * 1300 / 1800) } })] }));
    body.push(Pp([T('Punti numerati secondo il registro; colore per categoria. Grafo: stradario del cantiere, senza sfondo cartografico. Coordinate WGS84 rilevate dal GPS del dispositivo.', { size: 18, i: true })]));
  }
  body.push(H(`${nsec++}. Registro delle segnalazioni`));
  body.push(table(['N.', 'Ora', 'Strada e lotto', 'Cat.', 'Gravità', 'Descrizione'], [0.8, 1.2, 4.6, 1.0, 1.6, 6.8],
    seg.map(x => [String(x.n), fTime(new Date(x.ts)), `${x.via}${x.lotto ? ' – ' + x.lotto : ''}`, x.categoria, x.gravita, x.descrizione || '']), [0, 1, 3, 4]));
  body.push(H(`${nsec++}. Documentazione fotografica`));
  body.push(Pp('Ogni foto riporta in sovrimpressione strada, coordinate WGS84 con precisione stimata, data e ora di scatto; gli stessi dati sono registrati nei metadati EXIF dei file allegati.'));
  let k = 0;
  for (const x of seg) {
    k++; progress(0.3 + 0.5 * k / seg.length);
    const when = new Date(x.ts); const pp = programmaVicino(c, x.lotto, when);
    body.push(new X.Paragraph({ keepNext: true, spacing: { before: 240, after: 80 }, children: [T(`Segnalazione n. ${x.n} – ${x.categoria}. ${catName(x.categoria)}`, { b: true })] }));
    for (const f of fotoBy[x.id]) {
      const bytes = new Uint8Array(await f.blob.arrayBuffer()); const wpx = f.h > f.w ? 330 : 480;
      body.push(new X.Paragraph({ alignment: X.AlignmentType.CENTER, keepNext: true, spacing: { after: 60 }, children: [new X.ImageRun({ type: 'jpg', data: bytes, transformation: { width: wpx, height: Math.round(wpx * f.h / f.w) } })] }));
      body.push(Pp([T(`File: ${fname[f.id]}`, { size: 16, i: true, color: '555555' })], { al: X.AlignmentType.CENTER, keepNext: true }));
    }
    body.push(kv([['Data e ora', `${fDate(when)} ${fTimeS(when)}`], ['Coordinate', x.lat != null ? `${x.lat.toFixed(6)}, ${x.lon.toFixed(6)} (±${x.acc} m)` : 'non rilevate'],
    ['Strada', x.via || ''], ['Lotto', x.lotto || '—'], ['Gravità', x.gravita], ['Descrizione', x.descrizione || '—'],
    ['Programma sul lotto', pp.length ? pp.map(y => `${y.servizio} ${y.data.split('-').reverse().join('/')}`).join('; ') : 'nessun intervento nei 7 giorni prima o dopo']]));
  }
  body.push(Pp('Cordiali Saluti', { before: 360, al: X.AlignmentType.LEFT }));
  [st.firmaRuolo, st.firmaNome, '(Documento firmato digitalmente)'].forEach((t, i) => body.push(new X.Paragraph({ alignment: X.AlignmentType.CENTER, indent: { left: cm(8) }, spacing: { after: 0 }, children: [T(t, { i: i === 2, b: i < 2 })] })));
  const doc = new X.Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: cm(2.5), left: cm(2.5), right: cm(2.5), bottom: cm(0.81), header: cm(0.9), footer: cm(2.0) } } }, headers: { default: header }, footers: { default: footer }, children: body }]
  });
  zip.file(`${base}_verbale.docx`, await X.Packer.toBlob(doc));
  progress(0.85);
  // ---------- Excel ----------
  const rows = seg.map(x => {
    const w = new Date(x.ts);
    return {
      'N.': x.n, 'Data': fDate(w), 'Ora': fTimeS(w), 'Strada': x.via, 'Lotto': x.lotto, 'Categoria': x.categoria, 'Descrizione categoria': catName(x.categoria),
      'Gravità': x.gravita, 'Descrizione': x.descrizione, 'Latitudine': x.lat, 'Longitudine': x.lon, 'Precisione (m)': x.acc,
      'Distanza dallo stradario (m)': x.dist, 'Foto': fotoBy[x.id].map(f => fname[f.id]).join(', '), 'Mappa': x.lat != null ? 'Apri' : ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  seg.forEach((x, i) => { if (x.lat != null) { const ref = XLSX.utils.encode_cell({ r: i + 1, c: 14 }); ws[ref].l = { Target: `https://www.google.com/maps?q=${x.lat},${x.lon}` }; } });
  ws['!cols'] = [4, 11, 9, 30, 7, 9, 36, 9, 50, 11, 11, 10, 12, 30, 8].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:O${rows.length + 1}` };
  const ws2 = XLSX.utils.aoa_to_sheet([['Cantiere', c.nome], ['Ente', c.comune], ['Contratto', c.contratto], ['CIG', c.cig], ['Appaltatore', c.appaltatore], ['RUP', c.rup],
  ['Data', fDate(d)], ['Inizio', fTime(d)], ['Fine', e ? fTime(e) : ''], ['Partecipanti', s.partecipanti], ['Meteo', s.meteo], ['Note', s.note]]);
  ws2['!cols'] = [{ wch: 14 }, { wch: 90 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Registro'); XLSX.utils.book_append_sheet(wb, ws2, 'Sopralluogo');
  zip.file(`${base}_registro.xlsx`, XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  // GeoJSON
  zip.file(`${base}_segnalazioni.geojson`, JSON.stringify({
    type: 'FeatureCollection', features: seg.filter(x => x.lat != null).map(x => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
      properties: { n: x.n, data: fDate(new Date(x.ts)), ora: fTimeS(new Date(x.ts)), strada: x.via, lotto: x.lotto, categoria: x.categoria, gravita: x.gravita, descrizione: x.descrizione, precisione_m: x.acc, foto: fotoBy[x.id].map(f => 'foto/' + fname[f.id]).join(';') }
    }))
  }, null, 1));
  progress(0.95);
  const out = await zip.generateAsync({ type: 'blob' });
  progress(null);
  const name = `${base}_report.zip`;
  const file = new File([out], name, { type: 'application/zip' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && confirm('Report pronto. Vuoi condividerlo (mail, Drive, WhatsApp come documento)? Annulla per scaricarlo.')) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { }
  }
  download(out, name); toast('Report scaricato');
}

// ---------- backup ----------
async function exportBackup(s, c) {
  const zip = new JSZip(); const seg = await DB.by('segnalazioni', 'sopralluogo', s.id); const foto = [];
  for (const x of seg) for (const f of await DB.by('foto', 'segnalazione', x.id)) { zip.file('foto/' + f.id + '.jpg', f.blob); foto.push(Object.assign({}, f, { blob: undefined })); }
  zip.file('dati.json', JSON.stringify({ formato: 'sopralluoghi-dec-backup/1', cantiere: c, sopralluogo: s, segnalazioni: seg, foto }));
  download(await zip.generateAsync({ type: 'blob' }), `Backup_${slug(c.nome)}_${isoDay(new Date(s.inizio))}.zip`); toast('Backup scaricato');
}
async function restoreBackup() {
  const f = await pickFile('.zip'); if (!f) return;
  try {
    const zip = await JSZip.loadAsync(f); const d = JSON.parse(await zip.file('dati.json').async('string'));
    if (!d.sopralluogo) throw new Error('backup non riconosciuto');
    if (!(await DB.get('cantieri', d.cantiere.id))) await DB.put('cantieri', d.cantiere);
    await DB.put('sopralluoghi', d.sopralluogo); for (const x of d.segnalazioni) await DB.put('segnalazioni', x);
    for (const m of d.foto) { const b = await zip.file('foto/' + m.id + '.jpg').async('blob'); await DB.put('foto', Object.assign(m, { blob: new Blob([b], { type: 'image/jpeg' }) })); }
    toast('Backup ripristinato'); location.hash = '#/sopralluogo/' + d.sopralluogo.id;
  } catch (e) { toast('Ripristino non riuscito: ' + e.message, 4000); }
}

// ---------- avvio ----------
(async () => {
  await DB.open(); persistStorage(); route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
