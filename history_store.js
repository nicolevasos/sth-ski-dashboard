(() => {
  'use strict';
  const DB_NAME = 'ski-dashboard-history-v1';
  const STORE = 'uploads';
  let dbPromise;

  function openDb(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore(STORE, {keyPath:'hash'});
        store.createIndex('uploadedAt', 'uploadedAt');
        store.createIndex('skiModel', 'skiModel');
        store.createIndex('season', 'season');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function transaction(mode, callback){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = callback(store); } catch(error){ reject(error); return; }
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('History transaction aborted.'));
    });
  }

  async function sha256(file){
    const bytes = await file.arrayBuffer();
    if(!crypto?.subtle) return fallbackHash(new Uint8Array(bytes));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function fingerprint(file){
    const chunkSize = Math.min(1024 * 1024, file.size);
    const first = new Uint8Array(await file.slice(0, chunkSize).arrayBuffer());
    const tailStart = Math.max(0, file.size - chunkSize);
    const last = tailStart > 0
      ? new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
      : new Uint8Array(0);
    const metadata = new TextEncoder().encode(`${file.name}|${file.size}`);
    const combined = new Uint8Array(metadata.length + first.length + last.length);
    combined.set(metadata, 0);
    combined.set(first, metadata.length);
    combined.set(last, metadata.length + first.length);
    if(!crypto?.subtle) return `quick-${fallbackHash(combined)}`;
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return `quick-${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('')}`;
  }

  async function findDuplicateFile(file){
    const records = await all();
    const exactMetadata = records.find(record =>
      Number(record.fileSize) === Number(file.size)
      && Number(record.lastModified) === Number(file.lastModified)
      && String(record.archiveName || '') === String(file.name || '')
    );
    if(exactMetadata) return exactMetadata;
    const quick = await fingerprint(file);
    return records.find(record => record.hash === quick) || null;
  }

  function fallbackHash(bytes){
    let h1 = 2166136261, h2 = 16777619;
    for(const b of bytes){ h1 = Math.imul(h1 ^ b, 16777619); h2 = Math.imul(h2 + b, 2246822519); }
    return `fallback-${bytes.length}-${(h1>>>0).toString(16)}-${(h2>>>0).toString(16)}`;
  }

  async function has(hash){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(hash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(record){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function all(){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a,b)=>String(a.startDate||a.uploadedAt).localeCompare(String(b.startDate||b.uploadedAt))));
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll(){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('History clear transaction aborted.'));
    });
  }

  async function reassignUnassigned(skiName){
    const target = String(skiName || '').trim();
    if(!target) throw new Error('Select a ski model before assigning stored uploads.');
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      let changed = 0;
      request.onsuccess = event => {
        const cursor = event.target.result;
        if(!cursor) return;
        const record = cursor.value;
        if(!String(record?.skiModel || '').trim()){
          record.skiModel = target;
          record.summary = {...(record.summary || {}), selectedSkiModel: target};
          cursor.update(record);
          changed += 1;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(changed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('History reassignment transaction aborted.'));
    });
  }

  function dateFromPoints(points, pick='min'){
    const values = (points || []).map(p => Date.parse(p.phone_time)).filter(Number.isFinite);
    if(!values.length) return null;
    return new Date(pick === 'max' ? Math.max(...values) : Math.min(...values)).toISOString();
  }

  function seasonForDate(value){
    const d = new Date(value);
    if(Number.isNaN(d.getTime())) return 'Unknown season';
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const start = month >= 7 ? year : year - 1;
    return `Season ${start}/${String(start + 1).slice(-2)}`;
  }

  function filterRecords(records, filter={}){
    const skiModel = String(filter.skiModel || 'all').trim().toLocaleLowerCase();
    const season = filter.season || 'all';
    const fromMs = filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : -Infinity;
    const toMs = filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : Infinity;
    return records.filter(record => {
      const t = Date.parse(record.startDate || record.uploadedAt);
      const recordSki = String(record.skiModel || '').trim().toLocaleLowerCase();
      const skiMatches = skiModel === 'all' || recordSki === skiModel;
      const seasonMatches = season === 'all' || record.season === season;
      const dateMatches = !Number.isFinite(t) || (t >= fromMs && t <= toMs);
      return skiMatches && seasonMatches && dateMatches;
    });
  }

  async function buildRecord({hash, file, result, skiName}){
    const startDate = dateFromPoints(result.dashboardPoints, 'min') || new Date().toISOString();
    const endDate = dateFromPoints(result.dashboardPoints, 'max') || startDate;
    const uploadId = hash.slice(0, 16);
    const points = result.dashboardPoints.map(point => ({...point, upload_id: uploadId, archive_name: file.name}));
    return {
      hash,
      pipelineVersion:Number(result.summary.pipelineVersion)||1,
      uploadId,
      archiveName:file.name,
      fileSize:file.size,
      lastModified:file.lastModified,
      uploadedAt:new Date().toISOString(),
      startDate,
      endDate,
      season:seasonForDate(startDate),
      skiModel:skiName || result.summary.selectedSkiModel || '',
      totalDistanceKm:Number(result.summary.totalDistanceKm)||0,
      filesProcessed:Number(result.summary.filesProcessed)||0,
      rowsAfter:Number(result.summary.rowsAfter)||0,
      aoi:result.summary.aoi || null,
      acquisitionAnalytics:Array.isArray(result.acquisitionAnalytics) ? result.acquisitionAnalytics : [],
      points,
      summary:{...result.summary, archiveHash:hash, uploadId, startDate, endDate, season:seasonForDate(startDate)}
    };
  }

  window.SkiHistoryStore = {openDb, sha256, fingerprint, findDuplicateFile, has, put, all, clearAll, reassignUnassigned, filterRecords, buildRecord, seasonForDate};
})();
