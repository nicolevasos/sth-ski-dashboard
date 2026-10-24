const CONFIG = {
  edgeCondition: 'yellow', // green | yellow | red; derived from the selected ski's service kilometers
  kmSinceService: 125,
  serviceThresholdKm: 200,
  serviceYellowRatio: 0.50,
  serviceRedRatio: 0.80,
  skillLevel: 'advanced',
  selectedSki: 'Atomic Redster S9'
};

const DEFAULT_SKIS = [
  {name:'Atomic Redster S9', type:'Slalom', radius:'12.5 m', length:'165 cm', edge:'YELLOW', km:125},
  {name:'Head Supershape e-Speed', type:'Piste', radius:'14.0 m', length:'170 cm', edge:'GREEN', km:38},
  {name:'Training Ski', type:'All-round', radius:'16.5 m', length:'172 cm', edge:'RED', km:214}
];

const SERVICE_STORAGE_KEY = 'ski-dashboard-service-state-v1';
const SKI_MODELS_STORAGE_KEY = 'ski-dashboard-ski-models-v1';
const SELECTED_SKI_STORAGE_KEY = 'ski-dashboard-selected-ski-v1';
const SERVICE_RESET_MAP_KEY = 'ski-dashboard-service-reset-map-v1';
const SERVICE_BASELINE_MAP_KEY = 'ski-dashboard-service-baseline-map-v1';

function normalizeSkiDimension(value, unit, fallback){
  const text = String(value ?? '').trim();
  if(!text) return fallback;
  if(new RegExp(`\\b${unit}\\b`, 'i').test(text)) return text;
  const numeric = Number(text.replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(numeric) ? `${numeric} ${unit}` : fallback;
}

function normalizeSkiModel(model, fallbackName = 'Ski model'){
  const name = String(model?.name || fallbackName).trim();
  const km = Math.max(0, Number(model?.km) || 0);
  return {
    name,
    type: String(model?.type || 'All-round').trim() || 'All-round',
    radius: normalizeSkiDimension(model?.radius, 'm', '14.0 m'),
    length: normalizeSkiDimension(model?.length, 'cm', '170 cm'),
    edge: String(model?.edge || 'GREEN').toUpperCase(),
    km
  };
}

function loadSavedSkiModels(){
  try{
    const stored = JSON.parse(localStorage.getItem(SKI_MODELS_STORAGE_KEY) || 'null');
    if(Array.isArray(stored) && stored.length){
      const unique = [];
      stored.forEach((model, index) => {
        const normalized = normalizeSkiModel(model, `Ski model ${index + 1}`);
        if(normalized.name && !unique.some(item => item.name.toLowerCase() === normalized.name.toLowerCase())) unique.push(normalized);
      });
      if(unique.length) return unique;
    }
  }catch(error){
    console.warn('Could not restore saved ski models.', error);
  }
  return DEFAULT_SKIS.map(model => ({...model}));
}

const SKIS = loadSavedSkiModels();

function persistSkiModels(){
  try{
    localStorage.setItem(SKI_MODELS_STORAGE_KEY, JSON.stringify(SKIS));
    localStorage.setItem(SELECTED_SKI_STORAGE_KEY, CONFIG.selectedSki);
  }catch(error){
    console.warn('Could not save ski models.', error);
  }
}

function restoreSelectedSki(){
  try{
    const storedName = localStorage.getItem(SELECTED_SKI_STORAGE_KEY);
    if(storedName && SKIS.some(ski => ski.name === storedName)) CONFIG.selectedSki = storedName;
  }catch(error){
    console.warn('Could not restore the selected ski.', error);
  }
  if(!SKIS.some(ski => ski.name === CONFIG.selectedSki)) CONFIG.selectedSki = SKIS[0]?.name || '';
}

restoreSelectedSki();

function restoreServiceState(){
  const selectedSki = SKIS.find(ski => ski.name === CONFIG.selectedSki) || SKIS[0];
  if(selectedSki){
    CONFIG.selectedSki = selectedSki.name;
    CONFIG.kmSinceService = Math.max(0, Number(selectedSki.km) || 0);
  }

  // Restore the previous single-ski service state when it belongs to the selected model.
  // Older dashboard versions incorrectly set the service counter to zero when the user
  // cleared visualization history. Detect that specific persisted state and repair it.
  try{
    const stored = JSON.parse(localStorage.getItem(SERVICE_STORAGE_KEY) || 'null');
    if(stored?.selectedSki === CONFIG.selectedSki){
      const km = Number(stored.kmSinceService);
      const resetRecorded = Boolean(getServiceResetAt(CONFIG.selectedSki));
      const legacyHistoryClear = stored.source === 'history-cleared' && Number.isFinite(km) && km === 0 && !resetRecorded;
      const configuredDefault = defaultSkiServiceKm(CONFIG.selectedSki);

      if(legacyHistoryClear && Number.isFinite(configuredDefault) && configuredDefault > 0){
        CONFIG.kmSinceService = configuredDefault;
        setServiceBaselineKm(CONFIG.selectedSki, configuredDefault, {
          source:'legacy-history-clear-recovery',
          recoveredFromVersion:'v10-v11'
        });
        localStorage.setItem(SERVICE_STORAGE_KEY, JSON.stringify({
          ...stored,
          kmSinceService:configuredDefault,
          edgeCondition:serviceStatusFromKm(configuredDefault),
          serviceStatus:serviceStatusFromKm(configuredDefault),
          source:'legacy-history-clear-recovery',
          updatedAt:new Date().toISOString()
        }));
      } else if(Number.isFinite(km) && km >= 0){
        CONFIG.kmSinceService = km;
      }
    }
  }catch(error){
    console.warn('Could not restore the saved service status.', error);
  }

  CONFIG.edgeCondition = serviceStatusFromKm(CONFIG.kmSinceService);
  if(selectedSki){
    selectedSki.km = CONFIG.kmSinceService;
    selectedSki.edge = CONFIG.edgeCondition.toUpperCase();
  }
  persistSkiModels();
}

function saveServiceState(metadata = {}){
  CONFIG.edgeCondition = serviceStatusFromKm(CONFIG.kmSinceService);
  const selectedSki = SKIS.find(ski => ski.name === CONFIG.selectedSki);
  if(selectedSki){
    selectedSki.km = Math.max(0, Number(CONFIG.kmSinceService) || 0);
    selectedSki.edge = CONFIG.edgeCondition.toUpperCase();
  }
  persistSkiModels();

  try{
    localStorage.setItem(SERVICE_STORAGE_KEY, JSON.stringify({
      selectedSki: CONFIG.selectedSki,
      kmSinceService: CONFIG.kmSinceService,
      edgeCondition: CONFIG.edgeCondition,
      serviceStatus: serviceStatusFromKm(CONFIG.kmSinceService),
      updatedAt: new Date().toISOString(),
      ...metadata
    }));
  }catch(error){
    console.warn('Could not save the service status.', error);
  }
}

function serviceStatusFromKm(kilometers){
  const km = Math.max(0, Number(kilometers) || 0);
  const threshold = Math.max(1, Number(CONFIG.serviceThresholdKm) || 200);
  const ratio = km / threshold;
  if(ratio >= CONFIG.serviceRedRatio) return 'red';
  if(ratio >= CONFIG.serviceYellowRatio) return 'yellow';
  return 'green';
}

function formatServiceKm(value){
  const km = Math.max(0, Number(value) || 0);
  return km >= 100 ? km.toFixed(0) : km.toFixed(1).replace(/\.0$/, '');
}


function refreshDashboardForSelectedSki(){
  if(!Array.isArray(points) || !points.length) return;
  metrics = computeMetrics(points);
  renderText();
  const activeMode = document.querySelector('.map-pill.active')?.dataset.mode;
  if(activeMode === 'service') drawMapLayer('service', ['run']);
}

function selectDashboardSki(name, options = {}){
  const selectedSki = SKIS.find(ski => ski.name === name);
  if(!selectedSki) throw new Error('Please select a saved ski model.');

  CONFIG.selectedSki = selectedSki.name;
  CONFIG.kmSinceService = Math.max(0, Number(selectedSki.km) || 0);
  CONFIG.edgeCondition = serviceStatusFromKm(CONFIG.kmSinceService);
  selectedSki.edge = CONFIG.edgeCondition.toUpperCase();
  saveServiceState({source: options.source || 'ski-selection'});
  if(options.render !== false){
    if(typeof window.refreshDashboardFromHistory === 'function') window.refreshDashboardFromHistory();
    else refreshDashboardForSelectedSki();
  }
  return {...selectedSki};
}

function createDashboardSki(model, options = {}){
  const name = String(model?.name || '').trim();
  if(!name) throw new Error('Enter a name for the new ski model.');
  if(SKIS.some(ski => ski.name.toLowerCase() === name.toLowerCase())){
    throw new Error('A ski model with this name is already saved. Select it from the existing models instead.');
  }

  const ski = normalizeSkiModel({
    ...model,
    name,
    km: Math.max(0, Number(model?.km) || 0),
    edge: serviceStatusFromKm(model?.km || 0).toUpperCase()
  }, name);
  SKIS.push(ski);
  setServiceBaselineKm(ski.name, ski.km, {source:'new-ski-model'});
  persistSkiModels();
  if(options.select !== false) selectDashboardSki(ski.name, {source: options.source || 'new-ski-model', render: options.render});
  else if(options.render !== false) refreshDashboardForSelectedSki();
  return {...ski};
}

window.getDashboardSkiModels = () => SKIS.map(ski => ({...ski}));
window.getSelectedDashboardSki = () => CONFIG.selectedSki;
window.selectDashboardSki = selectDashboardSki;
window.createDashboardSki = createDashboardSki;

function getServiceResetAt(skiName = CONFIG.selectedSki){
  try{
    const map = JSON.parse(localStorage.getItem(SERVICE_RESET_MAP_KEY) || '{}');
    return map?.[skiName] || null;
  }catch(error){ return null; }
}

function setServiceResetAt(skiName, isoDate){
  try{
    const map = JSON.parse(localStorage.getItem(SERVICE_RESET_MAP_KEY) || '{}');
    map[skiName] = isoDate;
    localStorage.setItem(SERVICE_RESET_MAP_KEY, JSON.stringify(map));
  }catch(error){ console.warn('Could not save service reset timestamp.', error); }
}

function serviceStorageNameKey(skiName){
  return normalizedSkiName(skiName || CONFIG.selectedSki);
}

function readServiceBaselineMap(){
  try{
    const parsed = JSON.parse(localStorage.getItem(SERVICE_BASELINE_MAP_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  }catch(error){
    console.warn('Could not restore service baseline values.', error);
    return {};
  }
}

function getServiceBaselineKm(skiName = CONFIG.selectedSki){
  const key = serviceStorageNameKey(skiName);
  const entry = readServiceBaselineMap()[key];
  const value = Number(entry && typeof entry === 'object' ? entry.km : entry);
  if(!Number.isFinite(value) || value < 0) return null;

  // v12 could preserve the already-corrupted zero created by v10/v11 history clearing.
  // Treat that exact metadata combination as migratable, unless an actual service reset exists.
  const resetRecorded = Boolean(getServiceResetAt(skiName));
  const legacyZeroBaseline = value === 0
    && !resetRecorded
    && entry && typeof entry === 'object'
    && ['history-cleared-preserve-service-km','legacy-history-clear-recovery'].includes(entry.source);
  if(legacyZeroBaseline){
    const configuredDefault = defaultSkiServiceKm(skiName);
    if(Number.isFinite(configuredDefault) && configuredDefault > 0){
      return setServiceBaselineKm(skiName, configuredDefault, {
        source:'legacy-zero-baseline-recovery',
        recoveredFrom:entry.source
      });
    }
  }
  return value;
}

function setServiceBaselineKm(skiName, kilometers, metadata = {}){
  const key = serviceStorageNameKey(skiName);
  if(!key) return 0;
  const km = Math.max(0, Number(kilometers) || 0);
  try{
    const map = readServiceBaselineMap();
    map[key] = {
      km: Math.round(km * 1000) / 1000,
      skiName: String(skiName || CONFIG.selectedSki || ''),
      updatedAt: new Date().toISOString(),
      ...metadata
    };
    localStorage.setItem(SERVICE_BASELINE_MAP_KEY, JSON.stringify(map));
  }catch(error){
    console.warn('Could not save service baseline values.', error);
  }
  return km;
}

function defaultSkiServiceKm(skiName){
  const key = serviceStorageNameKey(skiName);
  const model = DEFAULT_SKIS.find(item => serviceStorageNameKey(item.name) === key);
  const value = Number(model?.km);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveServiceBaselineKm(skiName, historyDistanceKm, options = {}){
  const stored = getServiceBaselineKm(skiName);
  if(Number.isFinite(stored)) return stored;

  const historyKm = Math.max(0, Number(historyDistanceKm) || 0);
  const ski = SKIS.find(item => serviceStorageNameKey(item.name) === serviceStorageNameKey(skiName));
  const currentlyDisplayedKm = Math.max(0, Number(ski?.km) || 0);
  const hasServiceReset = Boolean(options.hasServiceReset);
  let baselineKm = 0;
  let source = 'automatic-migration';

  if(hasServiceReset){
    baselineKm = 0;
    source = 'service-reset';
  } else if(historyKm <= 0.01){
    const configuredDefault = defaultSkiServiceKm(skiName);
    baselineKm = currentlyDisplayedKm > 0
      ? currentlyDisplayedKm
      : Number.isFinite(configuredDefault) ? configuredDefault : 0;
    source = currentlyDisplayedKm > 0
      ? 'existing-ski-kilometers'
      : Number.isFinite(configuredDefault) ? 'built-in-ski-initial-kilometers' : 'zero-baseline';
  } else if(currentlyDisplayedKm > historyKm + 0.05){
    baselineKm = currentlyDisplayedKm - historyKm;
    source = 'existing-total-minus-history';
  } else {
    // v10/v11 replaced the original model kilometres with history-only distance.
    // Restore the configured baseline for built-in skis when no service reset exists.
    const configuredDefault = defaultSkiServiceKm(skiName);
    baselineKm = Number.isFinite(configuredDefault) ? configuredDefault : 0;
    source = Number.isFinite(configuredDefault) ? 'v11-built-in-ski-recovery' : 'history-only-migration';
  }

  return setServiceBaselineKm(skiName, baselineKm, {source});
}

async function serviceHistoryDistanceForSki(skiName = CONFIG.selectedSki){
  if(!window.SkiHistoryStore) return 0;
  const records = await window.SkiHistoryStore.all();
  const skiKey = serviceStorageNameKey(skiName);
  const resetIso = getServiceResetAt(skiName);
  const resetAt = Date.parse(resetIso || '');
  const hasReset = Number.isFinite(resetAt);
  return records
    .filter(record => serviceStorageNameKey(record.skiModel) === skiKey)
    .filter(record => !hasReset || Date.parse(record.uploadedAt) >= resetAt)
    .reduce((sum, record) => sum + (Number(record.totalDistanceKm) || 0), 0);
}

window.captureServiceBaselineBeforeUpload = async function(skiName = CONFIG.selectedSki){
  const existing = getServiceBaselineKm(skiName);
  if(Number.isFinite(existing)) return existing;
  const historyKm = await serviceHistoryDistanceForSki(skiName);
  const resetAt = Date.parse(getServiceResetAt(skiName) || '');
  return resolveServiceBaselineKm(skiName, historyKm, {hasServiceReset:Number.isFinite(resetAt)});
};

function syncServiceTrackingFromRawDistance(totalDistanceKm, summary = {}){
  const totalKm = Number(totalDistanceKm);
  if(!Number.isFinite(totalKm) || totalKm < 0) return false;

  CONFIG.kmSinceService = Math.round(totalKm * 100) / 100;
  CONFIG.edgeCondition = serviceStatusFromKm(CONFIG.kmSinceService);
  const selectedSki = SKIS.find(ski => ski.name === CONFIG.selectedSki);
  if(selectedSki){
    selectedSki.km = CONFIG.kmSinceService;
    selectedSki.edge = CONFIG.edgeCondition.toUpperCase();
  }

  saveServiceState({
    source: 'raw-data-upload',
    archiveName: summary.archiveName || '',
    rawDistanceKm: CONFIG.kmSinceService
  });
  return true;
}

const SERVICE_PARTNER_LAST_LOOKUP_KEY = 'ski-dashboard-last-service-partner-lookup-v1';
let servicePartners = [];
let servicePartnerLookupMeta = null;

let visibleServicePartnerIds = null;
let selectedServicePartnerId = null;

function postServicePartnersToEquipmentMap(options = {}){
  const frame = $('equipmentMapFrame');
  if(!frame?.contentWindow) return;
  frame.contentWindow.postMessage({
    type:'SKI_SERVICE_PARTNERS_DATA',
    partners: servicePartners.map(partner => ({...partner})),
    fit: options.fit !== false
  }, '*');
}

function partnerInsideBbox(partner, bbox){
  if(!bbox) return true;
  const lat = Number(partner.latitude), lon = Number(partner.longitude);
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const latitudeMatch = lat >= Number(bbox.south) && lat <= Number(bbox.north);
  const longitudeMatch = Number(bbox.west) <= Number(bbox.east)
    ? lon >= Number(bbox.west) && lon <= Number(bbox.east)
    : lon >= Number(bbox.west) || lon <= Number(bbox.east);
  return latitudeMatch && longitudeMatch;
}

function renderVisibleServicePartners(){
  if(!servicePartners.length) return;
  const partners = visibleServicePartnerIds instanceof Set
    ? servicePartners.filter(partner => visibleServicePartnerIds.has(String(partner.id)))
    : servicePartners;
  const list = $('servicePartnersList');
  const pill = $('servicePartnerPill');
  if(!list) return;
  list.innerHTML = partners.length
    ? partners.map(servicePartnerCardHtml).join('')
    : '<div class="service-partners-empty">No repair partners are visible in the current map extent. Zoom out or pan the map.</div>';
  if(pill) pill.textContent = visibleServicePartnerIds instanceof Set
    ? `${partners.length} in view · ${servicePartners.length} total`
    : `${servicePartners.length} nearby`;
  applySelectedServicePartnerCard();
}

function applySelectedServicePartnerCard(){
  document.querySelectorAll('.service-partner-card[data-partner-id]').forEach(card => {
    const selected = card.dataset.partnerId === selectedServicePartnerId;
    card.classList.toggle('is-map-selected', selected);
    card.setAttribute('aria-selected', String(selected));
  });
}

function selectServicePartner(partnerId, options = {}){
  selectedServicePartnerId = String(partnerId || '');
  applySelectedServicePartnerCard();
  const card = document.querySelector(`.service-partner-card[data-partner-id="${CSS.escape(selectedServicePartnerId)}"]`);
  if(options.scroll !== false) card?.scrollIntoView({block:'nearest',behavior:'smooth'});
  $('equipmentMapFrame')?.contentWindow?.postMessage({
    type:'SKI_SERVICE_PARTNER_HIGHLIGHT',
    partnerId:selectedServicePartnerId,
    fly:options.fly !== false,
    openPopup:options.openPopup !== false
  }, '*');
}

function initializeServicePartnerInteractions(){
  const list = $('servicePartnersList');
  if(!list || list.dataset.interactiveBound === 'true') return;
  list.dataset.interactiveBound = 'true';
  list.addEventListener('click', event => {
    if(event.target.closest('a,button')) return;
    const card = event.target.closest('.service-partner-card[data-partner-id]');
    if(card) selectServicePartner(card.dataset.partnerId, {fly:true,openPopup:true,scroll:false});
  });
  list.addEventListener('keydown', event => {
    if(event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.service-partner-card[data-partner-id]');
    if(!card) return;
    event.preventDefault();
    selectServicePartner(card.dataset.partnerId, {fly:true,openPopup:true,scroll:false});
  });
}

function renderServicePartnerState(status = 'idle', payload = {}){
  const pill = $('servicePartnerPill');
  const context = $('servicePartnerContext');
  const list = $('servicePartnersList');
  const bookButton = $('bookServiceButton');
  if(!pill || !context || !list) return;

  pill.className = `service-partner-pill service-partner-pill-${status}`;
  if(status === 'loading'){
    pill.textContent = 'Searching…';
    context.textContent = 'Deriving the AOI from all cleaned GPS rows and searching OpenStreetMap for nearby ski-service businesses.';
    list.innerHTML = '<div class="service-partners-empty">Retrieving service partners around the uploaded route…</div>';
    if(bookButton) bookButton.disabled = true;
    return;
  }

  if(status === 'error'){
    pill.textContent = 'Lookup issue';
    context.textContent = payload.message || 'The partner lookup could not be completed. The raw data was still processed normally.';
    list.innerHTML = '<div class="service-partners-empty">No live partner information is available. Check the internet connection and upload the archive again.</div>';
    if(bookButton) bookButton.disabled = true;
    return;
  }

  if(status === 'empty'){
    pill.textContent = '0 nearby';
    const bufferKm = Number(payload.bufferKm);
    context.textContent = Number.isFinite(bufferKm)
      ? `No tagged ski-service businesses were found within the data AOI plus a ${bufferKm.toFixed(0)} km buffer.`
      : 'No tagged ski-service businesses were found around the uploaded data AOI.';
    list.innerHTML = '<div class="service-partners-empty">No matching OpenStreetMap listings were found. Generic businesses without ski-related tags are intentionally excluded.</div>';
    if(bookButton) bookButton.disabled = true;
    return;
  }

  if(status === 'ready'){
    const partners = Array.isArray(payload.partners) ? payload.partners : [];
    pill.textContent = `${partners.length} nearby`;
    const bufferKm = Number(payload.bufferKm);
    const sourceSuffix = payload.fromCache ? ' · cached result' : '';
    context.textContent = `Ranked by minimum distance to the uploaded route${Number.isFinite(bufferKm) ? ` within the AOI plus ${bufferKm.toFixed(0)} km` : ''} · © OpenStreetMap contributors${sourceSuffix}.`;
    visibleServicePartnerIds = null;
    list.innerHTML = partners.map(servicePartnerCardHtml).join('');
    initializeServicePartnerInteractions();
    applySelectedServicePartnerCard();
    postServicePartnersToEquipmentMap({fit:true});
    if(bookButton) bookButton.disabled = partners.length === 0;
    return;
  }

  pill.textContent = 'Upload data';
  context.textContent = 'Upload raw sensor data to search for ski-service businesses around the dataset AOI.';
  list.innerHTML = '<div class="service-partners-empty">No AOI-based lookup has been run yet.</div>';
  if(bookButton) bookButton.disabled = true;
}

function servicePartnerCardHtml(partner){
  const distance = Number.isFinite(Number(partner.distanceKm)) ? `${Number(partner.distanceKm).toFixed(1)} km` : 'Distance unavailable';
  const capabilities = Array.isArray(partner.capabilities) && partner.capabilities.length
    ? partner.capabilities.join(' · ')
    : 'Sports-service listing';
  const address = partner.address ? `<span class="partner-address">${escapeDashboardText(partner.address)}</span>` : '';
  const hours = partner.openingHours ? `<span class="partner-hours">Hours: ${escapeDashboardText(partner.openingHours)}</span>` : '';
  const actions = [
    partner.osmUrl ? `<a href="${escapeDashboardAttribute(partner.osmUrl)}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>` : '',
    partner.website ? `<a href="${escapeDashboardAttribute(partner.website)}" target="_blank" rel="noopener noreferrer">Website</a>` : '',
    partner.phone ? `<a href="tel:${escapeDashboardAttribute(partner.phone)}">Call</a>` : '',
    partner.email ? `<a href="mailto:${escapeDashboardAttribute(partner.email)}">Email</a>` : ''
  ].filter(Boolean).join('');
  const confidence = ['confirmed','likely','possible'].includes(partner.confidence) ? partner.confidence : 'possible';
  const confidenceText = confidence === 'confirmed' ? 'Confirmed ski-service tags' : confidence === 'likely' ? 'Likely ski service' : 'Possible service partner';

  return `<div class="partner service-partner-card" data-partner-id="${escapeDashboardAttribute(partner.id)}" role="option" tabindex="0" aria-selected="false">
    <div class="partner-topline"><b>${escapeDashboardText(partner.name || 'Service partner')}</b><span class="partner-distance">${distance}</span></div>
    <span class="partner-capabilities">${escapeDashboardText(capabilities)}</span>
    ${address}${hours}
    ${actions ? `<div class="partner-actions">${actions}</div>` : ''}
    <span class="partner-confidence partner-confidence-${confidence}">${confidenceText}</span>
  </div>`;
}

function escapeDashboardAttribute(value){
  return escapeDashboardText(String(value || '')).replace(/`/g, '&#96;');
}

async function retrieveServicePartnersForAoi(aoi, routePoints = [], options = {}){
  renderServicePartnerState('loading');
  if(!window.ServicePartnerFinder?.lookup){
    const message = 'The service-partner lookup module is unavailable.';
    renderServicePartnerState('error', {message});
    throw new Error(message);
  }

  try{
    // Preserve the original v44 retrieval lifecycle: one direct lookup that uses
    // the module's normal 24-hour cache and sequential Overpass fallback.
    const result = await window.ServicePartnerFinder.lookup(aoi, routePoints, options);
    applyServicePartnerLookupResult(result, {fit:true});
    return result;
  }catch(error){
    const message = error?.message || 'Service partners could not be retrieved.';
    visibleServicePartnerIds = null;
    servicePartnerLookupMeta = {error: message, aoi};
    postServicePartnersToEquipmentMap({fit:false});
    renderServicePartnerState('error', {message});
    throw error;
  }
}

function applyServicePartnerLookupResult(result, options = {}){
  servicePartners = Array.isArray(result?.partners) ? result.partners : [];
  servicePartnerLookupMeta = result || null;
  visibleServicePartnerIds = null;
  if(servicePartners.length) renderServicePartnerState('ready', result);
  else renderServicePartnerState('empty', result || {});
  persistLastServicePartnerLookup(result || {partners:[]});
  postServicePartnersToEquipmentMap({fit:options.fit !== false});
}


function persistLastServicePartnerLookup(result){
  try{
    localStorage.setItem(SERVICE_PARTNER_LAST_LOOKUP_KEY, JSON.stringify({
      savedAt: Date.now(),
      result: {
        partners: result.partners,
        aoi: result.aoi,
        searchBounds: result.searchBounds,
        bufferKm: result.bufferKm,
        fromCache: result.fromCache,
        retrievedAt: result.retrievedAt,
        sourceLabel: result.sourceLabel
      }
    }));
  }catch(error){
    console.warn('Could not save the latest service-partner lookup.', error);
  }
}

function restoreLastServicePartnerLookup(){
  try{
    const stored = JSON.parse(localStorage.getItem(SERVICE_PARTNER_LAST_LOOKUP_KEY) || 'null');
    if(!stored?.result || !Array.isArray(stored.result.partners)) return false;
    if(Date.now() - Number(stored.savedAt || 0) > 24 * 60 * 60 * 1000) return false;
    servicePartners = stored.result.partners;
    visibleServicePartnerIds = null;
    servicePartnerLookupMeta = {...stored.result, fromCache: true};
    if(servicePartners.length) renderServicePartnerState('ready', servicePartnerLookupMeta);
    else renderServicePartnerState('empty', servicePartnerLookupMeta);
    return true;
  }catch(error){
    console.warn('Could not restore the latest service-partner lookup.', error);
    return false;
  }
}

window.retrieveServicePartnersForAoi = retrieveServicePartnersForAoi;
window.getDashboardServicePartners = () => servicePartners.map(partner => ({...partner}));

restoreServiceState();

let points = [];
let maps = {};
let layers = {};
let metrics = {};
let exactDistanceKmOverride = null;
const $ = id => document.getElementById(id);

renderServicePartnerState('idle');
initializeServicePartnerInteractions();
restoreLastServicePartnerLookup();
loadData();

async function loadData(){
  try{
    const response = await fetch('sample.geojson', {cache:'no-store'});
    if(!response.ok) throw new Error(`sample.geojson not found (${response.status})`);
    const data = await response.json();
    points = parseGeoJson(data);
  }catch(err){
    console.warn('Could not load sample.geojson. Using embedded demo trajectory instead.', err);
    points = createDemoTrajectory();
    showMapNotice('Using embedded demo trajectory. To load the real GeoJSON, run the whole folder with VS Code Live Server.');
  }

  if(!points.length){
    points = createDemoTrajectory();
    showMapNotice('No valid coordinates found. Using embedded demo trajectory.');
  }

  metrics = computeMetrics(points);
  renderText();
  renderBars();
  renderRunCards();
  initMaps();
  drawMapLayer('technique');
  initChartsReactive();

  // Restore real browser history when it exists. The welcome prompt is reserved
  // for first use (or after stored history has been cleared), while sample.geojson
  // remains the visual fallback behind the prompt.
  let restoredHistory = false;
  try{
    if(window.SkiHistoryStore){
      const storedRecords = await window.SkiHistoryStore.all();
      if(storedRecords.length && typeof window.refreshDashboardFromHistory === 'function'){
        restoredHistory = await window.refreshDashboardFromHistory();
      }
    }
  }catch(error){
    console.warn('Could not inspect stored dashboard history during startup.', error);
  }
  if(!restoredHistory) showStartupDataPrompt();
}



function showStartupDataPrompt(){
  const modal = $('startupDataModal');
  if(!modal) return;
  modal.style.display = 'flex';
  document.body.classList.add('startup-data-prompt-open');
}

window.dismissStartupDataPrompt = function(mode = 'sample'){
  const modal = $('startupDataModal');
  if(modal) modal.style.display = 'none';
  document.body.classList.remove('startup-data-prompt-open');
  if(mode === 'sample'){
    showToast('Sample GeoJSON loaded · upload raw CSV + analytics JSON at any time for complete dashboard functionality');
  }
};

function initializeStartupDataPrompt(){
  const uploadButton = $('startupUploadRawData');
  const sampleButton = $('startupUseSampleData');
  uploadButton?.addEventListener('click', () => {
    const input = $('zipFileInput');
    if(!input){
      showToast('The raw-data upload control is unavailable.');
      return;
    }
    input.click();
  });
  sampleButton?.addEventListener('click', () => window.dismissStartupDataPrompt('sample'));
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeStartupDataPrompt);
else initializeStartupDataPrompt();

function postAnalyticsToMapLayers(options = {}){
  if(!Array.isArray(points) || !points.length) return;
  const message = {
    type:'SKI_DASHBOARD_ANALYTICS_DATA',
    points,
    fit: options.fit !== false,
    summary:{
      selectedSki: CONFIG.selectedSki,
      kmSinceService: CONFIG.kmSinceService,
      serviceStatus: serviceStatusFromKm(CONFIG.kmSinceService)
    }
  };
  ['mainMap','overviewMapFrame','runAnalysisMap'].forEach(id => {
    document.getElementById(id)?.contentWindow?.postMessage(message, '*');
  });
}

function selectMapLayersAnalyticalLayer(mode){
  document.getElementById('mainMap')?.contentWindow?.postMessage({type:'SKI_MAP_SELECT_LAYER', mode}, '*');
}

window.addEventListener('message', event => {
  const data = event.data || {};
  if(data.type === 'SKI_MAP_LAYERS_READY') postAnalyticsToMapLayers({fit:true});
  if(data.type === 'SKI_SERVICE_PARTNER_MAP_READY') postServicePartnersToEquipmentMap({fit:true});
  if(data.type === 'SKI_SERVICE_PARTNER_BBOX' && data.bbox){
    visibleServicePartnerIds = new Set(servicePartners.filter(partner => partnerInsideBbox(partner, data.bbox)).map(partner => String(partner.id)));
    renderVisibleServicePartners();
  }
  if(data.type === 'SKI_SERVICE_PARTNER_SELECTED' && data.partnerId){
    selectedServicePartnerId = String(data.partnerId);
    applySelectedServicePartnerCard();
    const card = document.querySelector(`.service-partner-card[data-partner-id="${CSS.escape(selectedServicePartnerId)}"]`);
    card?.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mainMap')?.addEventListener('load', () => {
    setTimeout(() => postAnalyticsToMapLayers({fit:true}), 100);
  });
  document.getElementById('overviewMapFrame')?.addEventListener('load', () => {
    setTimeout(() => postAnalyticsToMapLayers({fit:true}), 100);
  });
  document.getElementById('equipmentMapFrame')?.addEventListener('load', () => {
    setTimeout(() => postServicePartnersToEquipmentMap({fit:true}), 100);
  });
  document.getElementById('runAnalysisMap')?.addEventListener('load', () => {
    setTimeout(() => { postAnalyticsToMapLayers({fit:true}); selectMapLayersAnalyticalLayer(document.querySelector('.map-pill.active')?.dataset.mode || 'technique'); }, 150);
  });
});

window.applyProcessedDashboardData = function(newPoints, summary = {}){
  exactDistanceKmOverride = Number.isFinite(Number(summary.totalDistanceKm)) ? Number(summary.totalDistanceKm) : null;
  if(!Array.isArray(newPoints) || !newPoints.length){
    throw new Error('The processed dataset does not contain valid dashboard points.');
  }

  points = annotateFallCandidates([...newPoints]).sort((a, b) => {
    const uploadCompare = String(a.upload_id || '').localeCompare(String(b.upload_id || ''));
    if(uploadCompare) return uploadCompare;
    const fileCompare = String(a.source_file || '').localeCompare(String(b.source_file || ''));
    if(fileCompare) return fileCompare;
    const rowA = Number(a.source_row ?? 0), rowB = Number(b.source_row ?? 0);
    if(rowA !== rowB) return rowA - rowB;
    return new Date(a.phone_time).getTime() - new Date(b.phone_time).getTime();
  });
  selectedRunIndex = null;

  // Synchronize service tracking from the complete cleaned GPS dataset. The
  // processing summary is calculated before GeoJSON statistical downsampling.
  const preliminaryMetrics = computeMetrics(points);
  const cumulativeServiceDistanceKm = Number(summary.cumulativeServiceDistanceKm);
  const rawTotalDistanceKm = Number(summary.totalDistanceKm);
  const serviceDistanceKm = Number.isFinite(cumulativeServiceDistanceKm)
    ? cumulativeServiceDistanceKm
    : Number.isFinite(rawTotalDistanceKm)
      ? rawTotalDistanceKm
      : preliminaryMetrics.dist;
  syncServiceTrackingFromRawDistance(serviceDistanceKm, summary);
  metrics = computeMetrics(points);

  document.querySelectorAll('.data-notice').forEach(notice => notice.remove());
  renderText();
  renderBars();
  renderRunCards();
  updateChartsForPoints(points);
  updateRunSessionKpis(points);

  const activeMode = document.querySelector('.map-pill.active')?.dataset.mode || 'speed';
  drawMapLayer(activeMode);
  if(terrain3dActive) draw3dRibbonLayer();
  [maps.overview, maps.run].forEach(map => {
    if(map?.invalidateSize) setTimeout(() => map.invalidateSize(), 0);
  });

  postAnalyticsToMapLayers({fit:true});

  const processedFiles = Number(summary.filesProcessed ?? dashboardRunGroups(points).length) || 0;
  const serviceStatus = serviceStatusFromKm(CONFIG.kmSinceService).toUpperCase();
  const selectedSkiFiles = Number(summary.selectedSkiRunFiles) || 0;
  const selectedSkiName = summary.selectedSkiName || CONFIG.selectedSki || 'selected ski';
  if(summary.loadContext === 'history-restore'){
    if(selectedSkiFiles > 0){
      showToast(`↻ Restored ${processedFiles} historical run file(s) · ${selectedSkiFiles} assigned to ${selectedSkiName} · ${formatServiceKm(CONFIG.kmSinceService)} km since service`);
    } else {
      showToast(`↻ Restored ${processedFiles} historical run file(s) · none assigned to ${selectedSkiName} · service distance remains 0 km`);
    }
  } else if(summary.loadContext === 'new-upload'){
    const addedFiles = Number(summary.newUploadFiles) || 0;
    showToast(`✓ ${addedFiles} new run file(s) added · ${processedFiles} in history view · ${formatServiceKm(CONFIG.kmSinceService)} km since service · ${serviceStatus}`);
  } else {
    showToast(`✓ ${processedFiles} run file(s) loaded · ${formatServiceKm(CONFIG.kmSinceService)} km since service · ${serviceStatus}`);
  }
};

function parseGeoJson(data){
  return (data.features || []).map(f => ({
    ...(f.properties || {}),
    lon: Number(f.geometry?.coordinates?.[0]),
    lat: Number(f.geometry?.coordinates?.[1])
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

function createDemoTrajectory(){
  const baseLat = 47.3289, baseLon = 12.7369;
  return Array.from({length:140}, (_,i) => {
    const t = i/139;
    return {
      phone_time: new Date(Date.now()+i*9000).toISOString(),
      lat: baseLat + t*0.022 + Math.sin(i/7)*0.0018,
      lon: baseLon + Math.cos(i/8)*0.004 + t*0.018,
      alt: 1860 - t*520 + Math.sin(i/10)*18,
      speed: (6 + Math.sin(i/9)*3 + t*7) / 3.6,
      left_acc_x: Math.sin(i/4)*2, left_acc_y: 1.2, left_acc_z: 9.8 + Math.cos(i/6),
      right_acc_x: Math.sin(i/4+0.25)*2, right_acc_y: 1.15, right_acc_z: 9.8 + Math.cos(i/6+0.2),
      left_gyro_x: Math.sin(i/3)*18, left_gyro_y: Math.cos(i/5)*8, left_gyro_z: 4,
      right_gyro_x: Math.sin(i/3+0.15)*17, right_gyro_y: Math.cos(i/5+0.1)*8, right_gyro_z: 4
    };
  });
}

function showMapNotice(message){
  const notice = document.createElement('div');
  notice.className = 'data-notice';
  notice.textContent = message;
  document.body.appendChild(notice);
}

function groupPointsByRun(rows){
  const hasStructuredRuns = rows.some(p => p?.source_file || p?.run !== undefined && p?.run !== null && p?.run !== '');
  if(!hasStructuredRuns) return [];

  const groups = new Map();
  rows.forEach((point, index) => {
    const key = `${point.upload_id || point.archive_name || 'legacy'}:${point.source_file || `run:${point.run ?? index}`}`;
    if(!groups.has(key)){
      groups.set(key, {
        key,
        runNumber: point.run ?? groups.size + 1,
        sourceFile: point.source_file || null,
        edgeCondition: point.edge_condition || null,
        points: []
      });
    }
    groups.get(key).points.push(point);
  });
  return [...groups.values()];
}

function dashboardRunGroups(rows){
  const structured = groupPointsByRun(rows);
  if(structured.length) return structured;
  return splitIntoRuns(rows, 4).map((runPoints, index) => ({
    key: `demo:${index + 1}`,
    runNumber: index + 1,
    sourceFile: null,
    edgeCondition: index % 2 ? 'mixed' : 'icy',
    points: runPoints
  }));
}

function sumElevationGain(rows){
  const groups = groupPointsByRun(rows);
  const pointGroups = groups.length ? groups.map(group => group.points) : [rows];
  return pointGroups.reduce((total, groupRows) => total + groupRows.slice(1).reduce((sum, point, index) => {
    const delta = (+point.alt || 0) - (+groupRows[index].alt || 0);
    return sum + (delta > 0 ? delta : 0);
  }, 0), 0);
}

function escapeDashboardText(value){
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[character]);
}

function acquisitionRecordsFromRows(rows){
  const records = new Map();
  (rows || []).forEach(point => {
    const id = point?.analytics_id;
    if(!id) return;
    if(!records.has(id)){
      records.set(id, {
        id,
        count:0,
        expectedCount:Number(point.analytics_dashboard_point_count) || 0,
        distanceKm:Number(point.analytics_distance_km),
        skiingTimeSeconds:Number(point.analytics_skiing_time_s),
        stopsTimeSeconds:Number(point.analytics_stops_time_s),
        averageSpeedKmh:Number(point.analytics_avg_speed_kmh),
        maximumSpeedKmh:Number(point.analytics_max_speed_kmh),
        effectiveEdgingDegrees:Number(point.analytics_effective_edging_deg),
        carvingScore:Number(point.analytics_carving_score),
        maximumGForce:Number(point.analytics_max_g_force),
        carvedTurns:Number(point.analytics_carved_turns),
        turnCount:Number(point.analytics_turn_count),
        techniqueCounts:{
          Carving:Number(point.analytics_carving_turns) || 0,
          'Drifted turns':Number(point.analytics_drifted_turns) || 0,
          'Snowplow steered':Number(point.analytics_snowplow_turns) || 0,
          'Parallel turns':Number(point.analytics_parallel_turns) || 0,
          Gliding:Number(point.analytics_gliding_segments) || 0
        },
        verticalMeters:Number(point.analytics_vertical_m),
        resortName:point.analytics_resort_name || '',
        locationName:point.analytics_location_name || ''
      });
    }
    records.get(id).count += 1;
  });
  return [...records.values()].map(record => ({
    ...record,
    complete: record.expectedCount > 0 && record.count >= record.expectedCount
  }));
}

function rawGroupDistance(rows){
  return (rows || []).slice(1).reduce((sum, point, index) => sum + haversine(rows[index], point), 0);
}

function rawGroupDuration(rows){
  const times = (rows || []).map(point => new Date(point.phone_time).getTime()).filter(Number.isFinite);
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
}

function weightedMean(values){
  let numerator=0, denominator=0;
  values.forEach(({value,weight=1}) => {
    if(Number.isFinite(value) && Number.isFinite(weight) && weight > 0){ numerator += value * weight; denominator += weight; }
  });
  return denominator ? numerator / denominator : null;
}

function computeMetrics(rows){
  const safeRows = Array.isArray(rows) ? rows : [];
  const speeds = safeRows.map(p => kmh(+p.speed || 0));
  const alts = safeRows.map(p => +p.alt || 0);
  const leftAcc = safeRows.map(p => mag(p,'left_acc'));
  const rightAcc = safeRows.map(p => mag(p,'right_acc'));
  const leftGyro = safeRows.map(p => mag(p,'left_gyro'));
  const rightGyro = safeRows.map(p => mag(p,'right_gyro'));

  const structuredGroups = groupPointsByRun(safeRows);
  const metricGroups = structuredGroups.length ? structuredGroups.map(group => group.points) : [safeRows];
  const groupSummaries = metricGroups.map(groupRows => {
    const completeAnalytics = acquisitionRecordsFromRows(groupRows).filter(record => record.complete);
    const analytics = completeAnalytics[0] || null;
    const rawDurationMs = rawGroupDuration(groupRows);
    const rawAverageSpeed = mean(groupRows.map(point => kmh(+point.speed || 0)));
    const rawMaximumSpeed = Math.max(0, ...groupRows.map(point => kmh(+point.speed || 0)));
    return {
      analytics,
      distanceKm: analytics && Number.isFinite(analytics.distanceKm) ? analytics.distanceKm : rawGroupDistance(groupRows),
      durationMs: analytics && Number.isFinite(analytics.skiingTimeSeconds) ? analytics.skiingTimeSeconds * 1000 : rawDurationMs,
      averageSpeedKmh: analytics && Number.isFinite(analytics.averageSpeedKmh) ? analytics.averageSpeedKmh : rawAverageSpeed,
      maximumSpeedKmh: analytics && Number.isFinite(analytics.maximumSpeedKmh) ? analytics.maximumSpeedKmh : rawMaximumSpeed,
      pointCount: groupRows.length
    };
  });

  const dist = groupSummaries.reduce((sum, group) => sum + group.distanceKm, 0);
  const durationMs = groupSummaries.reduce((sum, group) => sum + group.durationMs, 0);
  const avgSpeedKmh = weightedMean(groupSummaries.map(group => ({value:group.averageSpeedKmh, weight:group.durationMs || group.pointCount}))) ?? mean(speeds);
  const maxSpeedKmh = Math.max(0, ...groupSummaries.map(group => group.maximumSpeedKmh));
  const allTimes = safeRows.map(p => new Date(p.phone_time)).filter(date => !isNaN(date));

  const symmetry = 100 - Math.min(100, Math.abs(mean(leftAcc)-mean(rightAcc)) / Math.max(mean(leftAcc), mean(rightAcc), 1) * 100);
  const fallbackEdgeAngle = clamp(24 + mean(speeds)*0.24 + mean(leftGyro.concat(rightGyro))*0.05, 18, 48);
  const analyticsRecords = groupSummaries.map(group => group.analytics).filter(Boolean);
  const edgeAngle = weightedMean(analyticsRecords.map(record => ({value:record.effectiveEdgingDegrees, weight:record.skiingTimeSeconds || record.turnCount || 1}))) ?? fallbackEdgeAngle;
  const fallbackCarving = clamp((mean(speeds)/7.2) + (symmetry/18) + (fallbackEdgeAngle/18), 0, 10);
  const analyticsCarving01 = weightedMean(analyticsRecords.map(record => ({value:record.carvingScore, weight:record.turnCount || record.skiingTimeSeconds || 1})));
  const carving = Number.isFinite(analyticsCarving01) ? clamp(analyticsCarving01 * 10, 0, 10) : fallbackCarving;
  const techScore = Number.isFinite(analyticsCarving01)
    ? clamp(analyticsCarving01 * 100, 0, 100)
    : clamp((fallbackCarving*8.5) + (symmetry*0.12), 0, 100);
  const techniques = safeRows.map(point => point.analytics_technique || classifyTechnique(point));
  const pointTechniqueCounts = techniques.reduce((accumulator, technique) => (accumulator[technique]=(accumulator[technique]||0)+1, accumulator), {});
  const techniqueCounts = analyticsRecords.length ? analyticsRecords.reduce((counts, record) => {
    Object.entries(record.techniqueCounts || {}).forEach(([technique, count]) => {
      counts[technique] = (counts[technique] || 0) + (Number(count) || 0);
    });
    return counts;
  }, {}) : pointTechniqueCounts;
  if(analyticsRecords.length){
    safeRows.filter(point => !point.analytics_id).forEach(point => {
      const technique = classifyTechnique(point);
      techniqueCounts[technique] = (techniqueCounts[technique] || 0) + 1;
    });
  }
  const mainTechnique = Object.entries(techniqueCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';
  const falls = detectFalls(safeRows);
  const serviceRemaining = Math.max(0, CONFIG.serviceThresholdKm - CONFIG.kmSinceService);
  const leftShare = clamp(50 - (mean(leftAcc)-mean(rightAcc))*0.6, 35, 65);
  const start = allTimes.length ? new Date(Math.min(...allTimes.map(date => date.getTime()))) : null;
  const end = allTimes.length ? new Date(Math.max(...allTimes.map(date => date.getTime()))) : null;
  const verticalDescent = metricGroups.reduce((total, groupRows) => total + groupRows.slice(1).reduce((sum, point, index) => {
    const previousAltitude = Number(groupRows[index]?.alt);
    const currentAltitude = Number(point?.alt);
    return sum + (Number.isFinite(previousAltitude) && Number.isFinite(currentAltitude) ? Math.max(0, previousAltitude - currentAltitude) : 0);
  }, 0), 0);
  const maxGForce = Math.max(0, ...analyticsRecords.map(record => Number(record.maximumGForce) || 0));
  const turnCount = analyticsRecords.reduce((sum, record) => sum + (Number(record.turnCount) || 0), 0);
  const carvedTurns = analyticsRecords.reduce((sum, record) => sum + (Number(record.carvedTurns) || 0), 0);
  const analyticsCoverage = metricGroups.length ? 100 * analyticsRecords.length / metricGroups.length : 0;
  const dataSource = analyticsRecords.length
    ? (analyticsRecords.length === metricGroups.length ? 'CSV + acquisition JSON' : 'Mixed JSON / CSV fallback')
    : 'CSV-derived fallback';
  return {speeds, alts, leftAcc, rightAcc, leftGyro, rightGyro, dist, avgSpeedKmh, maxSpeedKmh, verticalDescent, symmetry, edgeAngle, carving, techScore, techniques, techniqueCounts, mainTechnique, falls, serviceRemaining, leftShare, start, end, durationMs, maxGForce, turnCount, carvedTurns, analyticsCoverage, dataSource};
}

function setTopKpiCards(title, cards, secondaryHtml = ''){
  const titleEl = $('overallKpisTitle');
  const grid = $('sessionKpis');
  const secondary = $('overviewSecondarySummary');
  if(titleEl) titleEl.textContent = title;
  if(grid) grid.innerHTML = cards.map(([label,value]) =>
    `<div class="metric"><span>${escapeDashboardText(label)}</span><b>${escapeDashboardText(String(value))}</b></div>`
  ).join('');
  if(secondary){
    secondary.innerHTML = secondaryHtml;
    secondary.hidden = !secondaryHtml;
  }
}

function finiteMetric(value, fallback = 0){
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function renderOverviewTopKpis(){
  const m = metrics || {};
  const hasPoints = Array.isArray(points) && points.length > 0;
  setTopKpiCards('Overall KPIs', [
    ['Distance', hasPoints ? `${finiteMetric(m.dist).toFixed(1)} km` : '—'],
    ['Skiing time', hasPoints ? formatDuration(finiteMetric(m.durationMs)) : '—'],
    ['Vertical descent', hasPoints ? `${finiteMetric(m.verticalDescent).toFixed(0)} m` : '—'],
    ['Average speed', hasPoints ? `${finiteMetric(m.avgSpeedKmh).toFixed(1)} km/h` : '—'],
    ['Runs', hasPoints ? dashboardRunGroups(points).length : '—'],
    ['Turns', hasPoints && finiteMetric(m.turnCount) > 0 ? finiteMetric(m.turnCount).toFixed(0) : '—']
  ]);
}

function renderRunTopKpis(runPoints){
  const visible = Array.isArray(runPoints) && runPoints.length ? runPoints : points;
  if(!visible?.length){
    setTopKpiCards('Run Analysis KPIs', [
      ['Maximum speed','—'],['Falls','—'],['Runs in view','—'],
      ['Skiing time','—'],['Elevation gained','—'],['Dominant technique','—']
    ]);
    return;
  }
  const mm = computeMetrics(visible) || {};
  setTopKpiCards('Run Analysis KPIs', [
    ['Maximum speed', `${finiteMetric(mm.maxSpeedKmh).toFixed(1)} km/h`],
    ['Falls', Array.isArray(mm.falls) ? mm.falls.length : 0],
    ['Runs in view', dashboardRunGroups(visible).length],
    ['Skiing time', formatDuration(finiteMetric(mm.durationMs))],
    ['Elevation gained', `${finiteMetric(sumElevationGain(visible)).toFixed(0)} m`],
    ['Dominant technique', mm.mainTechnique || '—']
  ]);
}

function renderText(){
  const m = metrics;
  const sessionDate = m.start ? m.start.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}) : '—';
  $('sessionDate').textContent = sessionDate;
  if($('railSelectedSki')) $('railSelectedSki').textContent = CONFIG.selectedSki || '—';
  const displayedDistanceKm = m.dist;
  $('railDistance').textContent = `${displayedDistanceKm.toFixed(1)} km`;
  $('railDuration').textContent = formatDuration(m.durationMs);
  $('techScoreTop').textContent = `${m.techScore.toFixed(0)}/100`;
  $('techScoreRing').textContent = m.techScore.toFixed(0);
  const techniqueStatusColor = m.techScore >= 75 ? 'var(--green)' : m.techScore >= 50 ? 'var(--orange)' : 'var(--red)';
  const techniqueStatusSoft = m.techScore >= 75 ? '#e6f7e8' : m.techScore >= 50 ? '#fff3da' : '#fde9e7';
  $('techRing').style.setProperty('--score-color', techniqueStatusColor);
  $('techRing').style.setProperty('--score-soft', techniqueStatusSoft);
  $('techRing').style.background = `conic-gradient(${techniqueStatusColor} 0deg ${m.techScore*3.6}deg,#d9e7ef ${m.techScore*3.6}deg)`;
  $('techRing').dataset.status = m.techScore >= 75 ? 'good' : m.techScore >= 50 ? 'developing' : 'attention';
  $('techRing').setAttribute('aria-label', `Technique score ${m.techScore.toFixed(0)} out of 100. ${m.techScore >= 75 ? 'Strong consistency' : m.techScore >= 50 ? 'Developing consistency' : 'Needs attention'}.`);
  renderServiceStatus(m);
  if($('analyticsSourceBadge')) {
    const runCount = dashboardRunGroups(points).length;
    const analysedRuns = Math.round(runCount * m.analyticsCoverage / 100);
    $('analyticsSourceBadge').textContent = runCount && analysedRuns === runCount
      ? `✓ All ${runCount} runs fully analysed`
      : runCount
        ? `${analysedRuns} of ${runCount} runs include complete analytics`
        : 'Waiting for analysed runs';
    $('analyticsSourceBadge').classList.toggle('complete', Boolean(runCount && analysedRuns === runCount));
  }
  const runsViewActive = document.querySelector('.nav[data-view="runs"]')?.classList.contains('active');
  if(runsViewActive) renderRunTopKpis(activeRunBboxPoints?.length ? activeRunBboxPoints : points);
  else renderOverviewTopKpis();
  const techniqueTotal = Object.values(m.techniqueCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0) || 1;
  const carvingCount = Number(m.techniqueCounts?.Carving || m.techniqueCounts?.['Carved turns'] || 0);
  const carvingShare = Math.round(100 * carvingCount / techniqueTotal);
  const secondarySummary = $('overviewSecondarySummary');
  if(secondarySummary) secondarySummary.innerHTML = `
    <span><small>Maximum speed</small><b>${m.maxSpeedKmh.toFixed(1)} km/h</b></span>
    <i aria-hidden="true"></i>
    <span><small>Carved turns</small><b>${m.carvedTurns || '—'}</b></span>
    <i aria-hidden="true"></i>
    <span><small>Carving share</small><b>${carvingShare}%</b></span>`;
  if(secondarySummary) secondarySummary.hidden = runsViewActive;
  if($('overviewTechniqueLabel')) $('overviewTechniqueLabel').textContent = m.techScore >= 75 ? 'Strong technique consistency' : m.techScore >= 55 ? 'Developing technique consistency' : 'Technique consistency needs attention';
  const topTechniques = Object.entries(m.techniqueCounts || {}).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if($('overviewTechniqueSummary')) $('overviewTechniqueSummary').innerHTML = topTechniques.length
    ? topTechniques.map(([name,count])=>`<span><b>${escapeDashboardText(name)}</b> ${Math.round(100*count/techniqueTotal)}%</span>`).join('<i>·</i>')
    : 'Technique distribution unavailable';
  const serviceRecommendation = $('serviceRecommendation');
  const serviceRecommendationDetail = $('serviceRecommendationDetail');
  const serviceIsDue = m.serviceRemaining < 50 || CONFIG.edgeCondition === 'red';
  if(serviceRecommendation){
    serviceRecommendation.className = `overview-status-line ${serviceIsDue ? 'warn' : 'good'}`;
    serviceRecommendation.innerHTML = serviceIsDue
      ? `<span aria-hidden="true">!</span><div><b>Service recommended soon</b><small>${formatServiceKm(m.serviceRemaining)} km remaining</small></div>`
      : `<span aria-hidden="true">✓</span><div><b>No service required</b><small>${formatServiceKm(m.serviceRemaining)} km remaining</small></div>`;
  }
  if(serviceRecommendationDetail) serviceRecommendationDetail.textContent = serviceIsDue
    ? 'Check edge sharpness and schedule service before the configured threshold is reached.'
    : 'Continue monitoring kilometres and daily edge condition.';
  $('kmSkiedGauge').textContent = formatServiceKm(CONFIG.kmSinceService);
  $('kmRestGauge').textContent = formatServiceKm(m.serviceRemaining);
  $('edgeBadge').textContent = edgeText().toUpperCase();
  $('edgeBadge').className = `badge ${CONFIG.edgeCondition}`;
  // Animate SVG gauge arcs: full arc = 157 units (semicircle path length)
  const arcLength = 157;
  const kmArcFill = Math.min(1, CONFIG.kmSinceService / CONFIG.serviceThresholdKm) * arcLength;
  const restArcFill = Math.min(1, m.serviceRemaining / CONFIG.serviceThresholdKm) * arcLength;
  const kmArc = $('gaugeArcKm'); const restArc = $('gaugeArcRest');
  if(kmArc)   kmArc.setAttribute('stroke-dasharray',   `${kmArcFill.toFixed(1)} ${arcLength}`);
  if(restArc) restArc.setAttribute('stroke-dasharray', `${restArcFill.toFixed(1)} ${arcLength}`);
  // Color the km gauge red/yellow/green based on proximity to threshold
  if(kmArc) kmArc.setAttribute('stroke', CONFIG.kmSinceService > 160 ? '#d94b47' : CONFIG.kmSinceService > 100 ? '#e7c94f' : '#6bc46d');
  const selectedSki = SKIS.find(s => s.name === CONFIG.selectedSki) || SKIS[0];
  if($('skiProfileName'))    $('skiProfileName').textContent    = selectedSki.name;
  if($('skiProfileSubtitle')) $('skiProfileSubtitle').textContent = `${selectedSki.type} · radius ${selectedSki.radius} · ${selectedSki.length}`;
  $('skiModels').innerHTML = SKIS.map(s => `<div class="ski-row ${s.name === CONFIG.selectedSki ? 'selected-ski-row' : ''}"><b>${escapeDashboardText(s.name)}</b><span>${escapeDashboardText(s.type)} · Radius ${escapeDashboardText(s.radius)} · Length ${escapeDashboardText(s.length)} · Service ${escapeDashboardText(s.edge)} · ${formatServiceKm(s.km)} km since service</span></div>`).join('');
  $('runMaxSpeed').textContent = `${m.maxSpeedKmh.toFixed(1)} km/h`;
  $('runFalls').textContent = m.falls.length;
  $('runCount').textContent = dashboardRunGroups(points).length;
  $('runTotalTime').textContent = formatDuration(m.durationMs);
  // Elevation gained = sum of positive altitude deltas
  const elevGained = sumElevationGain(points);
  $('runElevGained').textContent = `${elevGained.toFixed(0)} m`;
  $('runDomTechnique').textContent = m.mainTechnique;
  $('leftSym').style.width = `${m.leftShare}%`;
  $('rightSym').style.width = `${100-m.leftShare}%`;
  $('coachNotes').innerHTML = [
    `Your main detected technique was ${m.mainTechnique.toLowerCase()}. This is descriptive feedback, not a digital skiing instructor.`,
    `Edge condition is shown as one stable session/day value. It should not switch turn-by-turn.`,
    `Falls are mapped with context such as location, time, speed and slope layer, without claiming injury mechanisms.`
  ].map(t=>`<div class="note">${t}</div>`).join('');

  // ── New Coach & History UI ──
  const leftPct  = Math.round(m.leftShare);
  const rightPct = 100 - leftPct;
  if ($('symLeftBar'))  { $('symLeftBar').style.width  = `${leftPct}%`;  $('symLeftPct').textContent  = `${leftPct}%`; }
  if ($('symRightBar')) { $('symRightBar').style.width = `${rightPct}%`; $('symRightPct').textContent = `${rightPct}%`; }

  // Technique distribution bars (sorted largest first)
  if ($('techDistRows')) {
    const total = points.length || 1;
    const techEntries = Object.entries(metrics.techniqueCounts).sort((a, b) => b[1] - a[1]);
    $('techDistRows').innerHTML = techEntries.map(([name, count]) => {
      const pct = Math.round(count / total * 100);
      return `<div class="tech-dist-row">
        <span class="tech-dist-name">${name}</span>
        <div class="tech-dist-track"><div class="tech-dist-fill" style="width:${pct}%"></div></div>
        <span class="tech-dist-pct">${pct}%</span>
      </div>`;
    }).join('');
  }

  // Falls table
  const snowConditions = ['Slushy', 'Icy', 'Powder', 'Groomed', 'Spring snow'];
  const slopes         = ['Piste 4', 'Piste 12', 'Piste 6', 'Piste 8', 'Piste 3'];
  const levels         = ['Intermediate', 'Advanced', 'Advanced', 'Beginner', 'Intermediate'];
  const fallRows       = m.falls.slice(0, 6);
  if ($('fallsCount'))     $('fallsCount').textContent = `${fallRows.length} this season`;
  if ($('fallsTableBody')) {
    $('fallsTableBody').innerHTML = fallRows.length
      ? fallRows.map((f, i) => {
          const d       = new Date((f.ts || Date.now()) - i * 864e5);
          const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          return `<tr>
            <td>${dateStr}</td>
            <td>${slopes[i % slopes.length]}</td>
            <td>${snowConditions[i % snowConditions.length]}</td>
            <td>${timeStr}</td>
            <td>${levels[i % levels.length]}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" style="color:var(--muted);padding:20px 0;text-align:center">No falls recorded this season</td></tr>`;
  }
}

function renderServiceStatus(currentMetrics = metrics){
  const status = serviceStatusFromKm(CONFIG.kmSinceService);
  const progress = Math.min(100, Math.max(0, CONFIG.kmSinceService / CONFIG.serviceThresholdKm * 100));
  const serviceBar = $('serviceBar');
  const statusBadge = $('serviceStatus');
  const trafficLight = $('serviceTrafficLight');

  if(serviceBar) serviceBar.style.width = `${progress}%`;
  if($('kmRemainText')) $('kmRemainText').textContent = `Kilometers remaining until service: ${formatServiceKm(currentMetrics.serviceRemaining)} km`;

  if(statusBadge){
    statusBadge.textContent = status.toUpperCase();
    statusBadge.className = `service-status-badge service-status-${status}`;
  }

  if(trafficLight){
    const yellowAt = CONFIG.serviceThresholdKm * CONFIG.serviceYellowRatio;
    const redAt = CONFIG.serviceThresholdKm * CONFIG.serviceRedRatio;
    trafficLight.dataset.status = status;
    trafficLight.setAttribute('aria-label', `Service status: ${status}. Green below ${yellowAt} km, yellow from ${yellowAt} km, red from ${redAt} km.`);
    trafficLight.title = `Automatically calculated from kilometers since service: green < ${yellowAt} km, yellow ${yellowAt}–<${redAt} km, red ≥ ${redAt} km.`;
  }
}

function resetServiceStatus(){
  const skiName = CONFIG.selectedSki || 'the selected ski';
  const confirmed = window.confirm(
    `Reset service tracking for ${skiName}?\n\nThis records a completed service, sets kilometers since service to 0, and changes the service status to GREEN.`
  );
  if(!confirmed) return;

  CONFIG.kmSinceService = 0;
  CONFIG.edgeCondition = 'green';

  const selectedSki = SKIS.find(ski => ski.name === CONFIG.selectedSki);
  if(selectedSki){
    selectedSki.km = 0;
    selectedSki.edge = 'GREEN';
  }

  const resetAt = new Date().toISOString();
  setServiceResetAt(CONFIG.selectedSki, resetAt);
  setServiceBaselineKm(CONFIG.selectedSki, 0, {source:'manual-service-reset', resetAt});
  saveServiceState({source: 'manual-service-reset', resetAt});
  metrics = computeMetrics(points);
  renderText();

  const activeMode = document.querySelector('.map-pill.active')?.dataset.mode;
  if(activeMode === 'service') drawMapLayer('service', ['run']);

  showToast(`✓ Service reset for ${skiName} · ${CONFIG.serviceThresholdKm} km until next service`);
}

async function correctServiceKilometers(){
  const skiName = CONFIG.selectedSki || 'selected ski';
  const entered = window.prompt(
    `Enter the current total kilometers since the last service for ${skiName}.\n\nUploaded run distance will be included in this total without being counted twice.`,
    formatServiceKm(CONFIG.kmSinceService)
  );
  if(entered === null) return;
  const desiredTotalKm = Number(String(entered).replace(',', '.').trim());
  if(!Number.isFinite(desiredTotalKm) || desiredTotalKm < 0){
    showToast('Enter a valid kilometer value of 0 or more.');
    return;
  }

  const historyKm = await serviceHistoryDistanceForSki(CONFIG.selectedSki);
  const baselineKm = Math.max(0, desiredTotalKm - historyKm);
  setServiceBaselineKm(CONFIG.selectedSki, baselineKm, {source:'manual-total-correction', historyKm});
  CONFIG.kmSinceService = Math.round(desiredTotalKm * 100) / 100;
  CONFIG.edgeCondition = serviceStatusFromKm(CONFIG.kmSinceService);
  const selectedSki = SKIS.find(ski => ski.name === CONFIG.selectedSki);
  if(selectedSki){
    selectedSki.km = CONFIG.kmSinceService;
    selectedSki.edge = CONFIG.edgeCondition.toUpperCase();
  }
  saveServiceState({source:'manual-total-correction', serviceBaselineKm:baselineKm, historyDistanceKm:historyKm});
  metrics = computeMetrics(points);
  renderText();
  const activeMode = document.querySelector('.map-pill.active')?.dataset.mode;
  if(activeMode === 'service') drawMapLayer('service', ['run']);
  showToast(`✓ ${skiName}: ${formatServiceKm(CONFIG.kmSinceService)} km since service · ${CONFIG.edgeCondition.toUpperCase()}`);
}

function renderBars(){
  const target = $('techniqueBars');
  if(!target) return;
  const entries = Object.entries(metrics.techniqueCounts || {}).sort((a,b)=>b[1]-a[1]);
  const total = entries.reduce((sum,[,count])=>sum + Number(count || 0),0) || 1;
  const palette = ['#59b96b','#ed9d42','#4d88c8','#8f75bd','#9aabb7','#d16b78'];
  const segments = entries.map(([name,count],index) => {
    const pct = Math.max(0, Math.round(Number(count || 0) / total * 100));
    return `<span class="technique-stack-segment" style="width:${pct}%;background:${palette[index % palette.length]}" title="${escapeDashboardText(name)}: ${pct}%"></span>`;
  }).join('');
  const legend = entries.map(([name,count],index) => {
    const pct = Math.max(0, Math.round(Number(count || 0) / total * 100));
    return `<div class="technique-legend-item"><i style="background:${palette[index % palette.length]}"></i><span>${escapeDashboardText(name)}</span><b>${pct}%</b></div>`;
  }).join('');
  target.innerHTML = `<div class="technique-stack" aria-label="Technique distribution">${segments}</div><div class="technique-legend-grid">${legend}</div>`;
}

// ── Run table state ──
let runTableData = [];
let runTableSort = {col: 'run', dir: 'asc'};
let selectedRunIndex = null; // null = all runs shown

function buildRunTableData(){
  const groups = dashboardRunGroups(points);
  runTableData = groups.map((group, index) => {
    const runPoints = group.points;
    const mm = computeMetrics(runPoints);
    const sourceLabel = group.sourceFile
      ? group.sourceFile.replace(/_cleaned\.csv$/i, '').replace(/\.csv$/i, '')
      : `Piste ${12 + index}`;
    return {
      run: index + 1,
      runLabel: group.runNumber ?? index + 1,
      piste: sourceLabel,
      condition: group.edgeCondition || (index % 2 ? 'mixed' : 'icy'),
      techScore: Math.round(mm.techScore),
      durationMs: Math.max(0, new Date(runPoints.at(-1)?.phone_time || runPoints.at(-1)?.timestamp || 0) - new Date(runPoints[0]?.phone_time || runPoints[0]?.timestamp || 0)),
      avgSpeed: mm.avgSpeedKmh,
      maxSpeed: mm.maxSpeedKmh,
      avgEdge: Math.round(mm.edgeAngle),
      falls: mm.falls.length,
      elevGained: Math.round(sumElevationGain(runPoints)),
      verticalDescent: Math.round(mm.verticalDescent || 0),
      technique: mm.mainTechnique,
      points: runPoints
    };
  });
}

function renderRunTable(){
  const cols = [
    {key:'run', label:'Run'},
    {key:'durationMs', label:'Duration'},
    {key:'condition', label:'Snow'},
    {key:'technique', label:'Technique'},
    {key:'techScore', label:'Score'},
    {key:'avgSpeed', label:'Avg Speed'},
    {key:'maxSpeed', label:'Max Speed'},
    {key:'avgEdge', label:'Edge Angle'},
    {key:'verticalDescent', label:'Vertical Descent'},
    {key:'falls', label:'Falls'}
  ];

  const sorted = [...runTableData].sort((a, b) => {
    const va = a[runTableSort.col], vb = b[runTableSort.col];
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return runTableSort.dir === 'asc' ? cmp : -cmp;
  });

  const arrow = dir => dir === 'asc' ? ' ↑' : ' ↓';

  const headerCells = cols.map(c => {
    const active = runTableSort.col === c.key;
    return `<th class="rt-th${active?' rt-th-active':''}" data-col="${c.key}">${c.label}${active ? arrow(runTableSort.dir) : ''}</th>`;
  }).join('');

  const rows = sorted.map(row => {
    const isSelected = selectedRunIndex === row.run;
    const techColor = row.techScore >= 85 ? '#29783b' : row.techScore >= 70 ? '#806300' : '#a33030';
    const techBg    = row.techScore >= 85 ? '#e5f8e7' : row.techScore >= 70 ? '#fff5c8' : '#fdeaea';
    const conditionText = String(row.condition || 'unknown');
    const isIcy = /ice|icy|hart|hard/i.test(conditionText);
    const condBadge = `<span class="rt-badge ${isIcy ? 'rt-badge-ice' : 'rt-badge-mix'}">${isIcy ? '❄ ' : '~ '}${escapeDashboardText(conditionText)}</span>`;
    const techBadge = `<span class="rt-technique-badge">${row.technique}</span>`;
    return `<tr class="rt-row${isSelected?' rt-selected':''}" data-run="${row.run}">
      <td><b class="rt-run-num">${escapeDashboardText(row.runLabel)}</b></td>
      <td>${formatDuration(row.durationMs)}</td>
      <td>${condBadge}</td>
      <td>${techBadge}</td>
      <td><span class="rt-score" style="background:${techBg};color:${techColor}">${row.techScore}</span></td>
      <td>${row.avgSpeed.toFixed(1)} km/h</td>
      <td>${row.maxSpeed.toFixed(1)} km/h</td>
      <td>${row.avgEdge}°</td>
      <td>${row.verticalDescent.toLocaleString()} m</td>
      <td>${row.falls > 0 ? `<span class="rt-falls">${row.falls}</span>` : row.falls}</td>
    </tr>`;
  }).join('');

  $('runCards').innerHTML = `
    <div class="run-table-wrap">
      <div class="run-table-header">
        <span class="run-table-title">All Runs</span>
        ${selectedRunIndex !== null
          ? `<button class="rt-clear-btn" id="clearRunFilter">✕ Clear filter</button>`
          : '<span class="rt-hint">Click a row to filter · Click header to sort</span>'}
      </div>
      <table class="run-table" id="runTable">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Header sort listeners
  document.querySelectorAll('.rt-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if(runTableSort.col === col){
        runTableSort.dir = runTableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        runTableSort.col = col;
        runTableSort.dir = 'asc';
      }
      renderRunTable();
    });
  });

  // Row select listeners
  document.querySelectorAll('.rt-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const runNum = parseInt(tr.dataset.run);
      if(selectedRunIndex === runNum){
        selectedRunIndex = null;
      } else {
        selectedRunIndex = runNum;
      }
      applyRunFilter();
      renderRunTable();
    });
  });

  // Clear filter button
  const clearBtn = $('clearRunFilter');
  if(clearBtn) clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedRunIndex = null;
    applyRunFilter();
    renderRunTable();
  });
}

function updateSelectedRunSummary(row){
  const all = row == null;
  const set = all ? points : row.points;
  const mm = computeMetrics(set);
  const title = $('selectedRunTitle'), subtitle = $('selectedRunSubtitle');
  if(title) title.textContent = all ? 'All runs' : `Run ${row.runLabel}`;
  if(subtitle) subtitle.textContent = all ? `${runTableData.length} runs in the current view` : `${row.piste} · ${row.condition || 'Condition unavailable'}`;
  if($('selectedRunDuration')) $('selectedRunDuration').textContent = all ? formatDuration(Math.max(0,new Date(set.at(-1)?.phone_time||0)-new Date(set[0]?.phone_time||0))) : formatDuration(row.durationMs);
  if($('selectedRunTechnique')) $('selectedRunTechnique').textContent = all ? mm.mainTechnique : row.technique;
  if($('selectedRunAvgSpeed')) $('selectedRunAvgSpeed').textContent = `${(all?mm.avgSpeedKmh:row.avgSpeed).toFixed(1)} km/h`;
  if($('selectedRunCondition')) $('selectedRunCondition').textContent = all ? 'Mixed' : row.condition;
}

let currentRunMapPoints = [];
let runMapViewportTimer = null;

function postRunAnalysisMapData(activePoints, fit=true){
  const frame = document.getElementById('runAnalysisMap');
  if(!frame || !Array.isArray(activePoints) || !activePoints.length) return;
  currentRunMapPoints = activePoints;
  frame.contentWindow?.postMessage({type:'SKI_DASHBOARD_ANALYTICS_DATA',points:activePoints,fit,summary:{selectedSki:CONFIG.selectedSki}},'*');
  frame.contentWindow?.postMessage({type:'SKI_MAP_SELECT_LAYER',mode:document.querySelector('.map-pill.active')?.dataset.mode||'technique'},'*');
  requestAnimationFrame(() => frame.contentWindow?.postMessage({type:'SKI_RUN_MAP_RESIZE'},'*'));
}

function applyRunFilter(){
  const row = selectedRunIndex === null ? null : runTableData.find(r => r.run === selectedRunIndex);
  const activePoints = row?.points || points;
  updateChartsForPoints(activePoints);
  updateRunSessionKpis(activePoints);
  updateSelectedRunSummary(row);
  postRunAnalysisMapData(activePoints, true);
}

function highlightRunOnMap(runPoints){
  if(maps.fallback) return;
  const mode = document.querySelector('.map-pill.active')?.dataset.mode || 'technique';
  if(layers.run) layers.run.remove();
  const group = L.featureGroup();

  // Dim the non-selected runs without connecting the end of one file to the next.
  const allGroups = groupPointsByRun(points);
  const fadedGroups = allGroups.length ? allGroups.map(item => item.points) : [points];
  fadedGroups.forEach(groupPoints => {
    if(groupPoints.length < 2) return;
    const runCoords = groupPoints.map(point => [point.lat, point.lon]);
    L.polyline(runCoords, {color:'#c8d8e0', weight:5, opacity:.35, lineCap:'round'}).addTo(group);
  });

  // Overlay selected run bright
  let selCoords = [[runPoints[0].lat, runPoints[0].lon]];
  let selColor = colorFor(mode, runPoints[1] || runPoints[0], 1);
  for(let i = 1; i < runPoints.length; i++){
    const color = colorFor(mode, runPoints[i], i);
    if(color === selColor){
      selCoords.push([runPoints[i].lat, runPoints[i].lon]);
    } else {
      L.polyline(selCoords, {color:selColor, weight:8, opacity:.98, lineCap:'round'}).addTo(group);
      selCoords = [[runPoints[i-1].lat,runPoints[i-1].lon],[runPoints[i].lat,runPoints[i].lon]];
      selColor = color;
    }
  }
  if(selCoords.length) L.polyline(selCoords, {color:selColor, weight:8, opacity:.98, lineCap:'round'}).addTo(group);

  layers.run = group.addTo(maps.run);
  if(group.getBounds().isValid()) maps.run.fitBounds(group.getBounds(), {padding:[30,30]});
  renderRunMapLegend(mode);
}

function renderRunCards(){
  buildRunTableData();
  renderRunTable();
}

// ── 3D terrain state ──
let terrain3dActive = false;
let canvasLayer3d = null;

function initMaps(){
  if(document.getElementById('runAnalysisMap')){ maps.runIframe = true; return; }
  if(!window.L){
    showMapNotice('Leaflet did not load. Check your internet connection, or keep the CDN script enabled. Showing a simplified SVG fallback.');
    maps.fallback = true;
    return;
  }

  // Tile providers — no API key required
  function makeTiles(map){
    // Base: OpenStreetMap standard (reliable, no key required)
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', opacity:1
    });
    // Ski piste overlay from OpenSnowMap (free, no key)
    const pistes = L.tileLayer('https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png',{
      maxZoom:18, attribution:'© <a href="https://www.opensnowmap.org">OpenSnowMap</a> CC-BY-SA', opacity:0.85
    });
    osm.addTo(map);
    pistes.addTo(map);
    return {osm, pistes};
  }


  maps.run = L.map('runMap', {zoomControl:true, attributionControl:false, preferCanvas:true});
  makeTiles(maps.run);
  maps.run.setView([points[0].lat, points[0].lon], 13);

  // Add terrain badge to run map
  const badge = document.createElement('div');
  badge.className = 'terrain-badge';
  badge.textContent = '⛷ OpenSnowMap Pistes';
  document.getElementById('runMap').appendChild(badge);

  // Add 3D toggle controls to run map container
  const ctrl3d = document.createElement('div');
  ctrl3d.className = 'map-3d-controls';
  ctrl3d.innerHTML = `
    <button class="map-3d-btn" id="btn3dToggle" title="Toggle 3D ribbon track">3D Ribbon ⛷</button>
    <button class="map-3d-btn" id="btnTiltUp" title="Increase tilt">▲ Tilt</button>
    <button class="map-3d-btn" id="btnTiltDown" title="Decrease tilt">▼ Flat</button>
  `;
  document.querySelector('.run-map-container').style.position = 'relative';
  document.querySelector('.run-map-container').appendChild(ctrl3d);

  document.getElementById('btn3dToggle').addEventListener('click', function(){
    terrain3dActive = !terrain3dActive;
    this.classList.toggle('active', terrain3dActive);
    draw3dRibbonLayer();
  });
  document.getElementById('btnTiltUp').addEventListener('click', () => {
    tiltAngle = Math.min(tiltAngle + 8, 40);
    draw3dRibbonLayer();
  });
  document.getElementById('btnTiltDown').addEventListener('click', () => {
    tiltAngle = Math.max(tiltAngle - 8, 0);
    draw3dRibbonLayer();
  });
}

// ── 3D Ribbon Canvas overlay ──
let tiltAngle = 20; // degrees

function draw3dRibbonLayer(){
  if(maps.fallback) return;
  // Remove existing canvas layer
  if(canvasLayer3d){ maps.run.removeLayer(canvasLayer3d); canvasLayer3d = null; }
  if(!terrain3dActive) return;

  const activeRunPoints = (selectedRunIndex !== null)
    ? (runTableData.find(r => r.run === selectedRunIndex)?.points || points)
    : points;

  canvasLayer3d = L.Layer.extend({
    onAdd(map){
      this._map = map;
      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:650;';
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend zoomend resize', this._redraw, this);
      this._redraw();
    },
    onRemove(map){
      map.getPanes().overlayPane.removeChild(this._canvas);
      map.off('moveend zoomend resize', this._redraw, this);
    },
    _redraw(){
      const map = this._map;
      const size = map.getSize();
      const canvas = this._canvas;
      canvas.width  = size.x;
      canvas.height = size.y;
      const origin = map.getPixelOrigin();
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size.x, size.y);

      const pts = activeRunPoints;
      if(pts.length < 2) return;

      // Altitude range
      const alts = pts.map(p => +p.alt || 0);
      const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
      const altRange = maxAlt - minAlt || 1;

      // Tilt projection: compress y by cos(tilt), shift higher alts upward
      const tiltRad = tiltAngle * Math.PI / 180;
      const yCompress = Math.cos(tiltRad);
      const maxLift = 60 * Math.sin(tiltRad); // max pixel lift for highest alt

      function project(p){
        const lp = map.project(L.latLng(p.lat, p.lon));
        const x = Math.round(lp.x - origin.x);
        const baseY = Math.round(lp.y - origin.y);
        const altNorm = ((+p.alt || minAlt) - minAlt) / altRange;
        const yTilted = baseY * yCompress + (size.y * (1 - yCompress) * 0.5);
        const lift = altNorm * maxLift;
        return { x, y: yTilted - lift, altNorm };
      }

      // Slope gradient color
      function slopeColor(dAlt, speed){
        const sp = speed * 3.6;
        if(dAlt < -3) return '#d94b47'; // steep descent = red
        if(dAlt < -1) return '#f4a340'; // moderate = orange
        return '#6bc46d';               // flat/ascent = green
      }

      // Draw shadow/extrusion first
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#173e64';
      if(tiltAngle > 5){
        ctx.beginPath();
        const p0 = project(pts[0]);
        ctx.moveTo(p0.x, p0.y);
        for(let i = 1; i < pts.length; i++){
          const p = project(pts[i]);
          ctx.lineTo(p.x, p.y);
        }
        for(let i = pts.length - 1; i >= 0; i--){
          const p = project(pts[i]);
          ctx.lineTo(p.x + 4, p.y + 8 * Math.sin(tiltRad));
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Draw ribbon: each segment as a thick stroke colored by slope steepness
      const ribbonWidth = 10;
      for(let i = 1; i < pts.length; i++){
        const prev = project(pts[i-1]);
        const curr = project(pts[i]);
        const dAlt = (+pts[i].alt || 0) - (+pts[i-1].alt || 0);
        const sp   = +pts[i].speed || 0;

        // Perpendicular vector for ribbon
        const dx = curr.x - prev.x, dy = curr.y - prev.y;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        const nx = -dy/len, ny = dx/len;
        const hw = ribbonWidth / 2;

        // Top edge (lifted by altitude)
        const topPrev = { x: prev.x + nx*hw, y: prev.y + ny*hw };
        const topCurr = { x: curr.x + nx*hw, y: curr.y + ny*hw };
        const botPrev = { x: prev.x - nx*hw, y: prev.y - ny*hw };
        const botCurr = { x: curr.x - nx*hw, y: curr.y - ny*hw };

        const color = slopeColor(dAlt, sp);

        // Ribbon face
        const grad = ctx.createLinearGradient(prev.x, prev.y, curr.x, curr.y);
        grad.addColorStop(0, color + 'cc');
        grad.addColorStop(1, color + 'ee');

        ctx.beginPath();
        ctx.moveTo(topPrev.x, topPrev.y);
        ctx.lineTo(topCurr.x, topCurr.y);
        ctx.lineTo(botCurr.x, botCurr.y);
        ctx.lineTo(botPrev.x, botPrev.y);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Top highlight edge
        ctx.beginPath();
        ctx.moveTo(topPrev.x, topPrev.y);
        ctx.lineTo(topCurr.x, topCurr.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Bottom shadow edge
        ctx.beginPath();
        ctx.moveTo(botPrev.x, botPrev.y);
        ctx.lineTo(botCurr.x, botCurr.y);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Draw start/end pins
      function drawPin(p, color, label){
        const {x, y} = project(p);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI*2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = 'white';
        ctx.font = 'bold 8px Inter,Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y);
      }
      drawPin(pts[0], '#1f7fbd', 'S');
      drawPin(pts[pts.length-1], '#d94b47', 'F');

      // Position canvas correctly
      const topLeft = map.containerPointToLayerPoint([0,0]);
      L.DomUtil.setPosition(canvas, topLeft);
    }
  });

  const LayerClass = canvasLayer3d;
  canvasLayer3d = new LayerClass();
  maps.run.addLayer(canvasLayer3d);
}

function drawMapLayer(mode, targets){
  if(maps.fallback){
    drawSvgMap('overviewMap', mode);
    // mainMap is now an OpenSkiMap iframe — skip SVG fallback for it
    const activeLayerLabel = $('activeLayerLabel');
    const mapHint = $('mapHint');
    if(activeLayerLabel) activeLayerLabel.textContent = labelFor(mode);
    if(mapHint) mapHint.textContent = labelFor(mode);
    renderLegend(mode);
    return;
  }
  const keys = targets || ['overview','main','run'];
  keys.forEach(key => {
    if(!maps[key]) return;
    if(layers[key]) layers[key].remove();
    const group = L.featureGroup();

    // Batch consecutive same-color segments, keeping each uploaded run as an independent trajectory.
    const structuredGroups = groupPointsByRun(points);
    const mapGroups = structuredGroups.length ? structuredGroups.map(item => item.points) : [points];
    mapGroups.forEach(groupPoints => {
      if(groupPoints.length < 2) return;
      let runCoords = [[groupPoints[0].lat, groupPoints[0].lon]];
      let runColor  = colorFor(mode, groupPoints[1] || groupPoints[0], 1);
      for(let i=1;i<groupPoints.length;i++){
        const color = colorFor(mode, groupPoints[i], i);
        if(color === runColor){
          runCoords.push([groupPoints[i].lat, groupPoints[i].lon]);
        } else {
          L.polyline(runCoords, {color:runColor, weight:key==='overview'?5:7, opacity:.92, lineCap:'round'}).addTo(group);
          runCoords = [[groupPoints[i-1].lat,groupPoints[i-1].lon],[groupPoints[i].lat,groupPoints[i].lon]];
          runColor  = color;
        }
      }
      if(runCoords.length > 1) L.polyline(runCoords, {color:runColor, weight:key==='overview'?5:7, opacity:.92, lineCap:'round'}).addTo(group);
    });

    if(mode === 'falls') metrics.falls.forEach(p =>
      L.circleMarker([p.lat,p.lon], {radius:9,color:'#d94b47',fillColor:'#d94b47',fillOpacity:.9})
       .bindPopup(`<b>Fall candidate</b><br>${p.phone_time||''}<br>Speed: ${kmh(+p.speed||0).toFixed(1)} km/h`)
       .addTo(group));

    layers[key] = group.addTo(maps[key]);
    if(group.getBounds().isValid()) maps[key].fitBounds(group.getBounds(), {padding:[20,20]});
  });
  const activeLayerLabel = $('activeLayerLabel');
  const mapHint = $('mapHint');
  if(activeLayerLabel) activeLayerLabel.textContent = labelFor(mode);
  if(mapHint) mapHint.textContent = labelFor(mode);
  renderLegend(mode);
  renderRunMapLegend(mode);
}


function drawSvgMap(targetId, mode){
  const el = $(targetId);
  const minLat = Math.min(...points.map(p=>p.lat)), maxLat = Math.max(...points.map(p=>p.lat));
  const minLon = Math.min(...points.map(p=>p.lon)), maxLon = Math.max(...points.map(p=>p.lon));
  const w = 900, h = 520, pad = 36;
  const xy = p => [pad + ((p.lon-minLon)/(maxLon-minLon || 1))*(w-pad*2), h-pad - ((p.lat-minLat)/(maxLat-minLat || 1))*(h-pad*2)];
  let segs = '';
  const structuredGroups = groupPointsByRun(points);
  const svgGroups = structuredGroups.length ? structuredGroups.map(item => item.points) : [points];
  svgGroups.forEach(groupPoints => {
    for(let i=1;i<groupPoints.length;i++){
      const [x1,y1]=xy(groupPoints[i-1]), [x2,y2]=xy(groupPoints[i]);
      segs += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colorFor(mode,groupPoints[i],i)}" stroke-width="10" stroke-linecap="round" opacity=".92"/>`;
    }
  });
  const fallDots = mode === 'falls' ? metrics.falls.map(p=>{const [x,y]=xy(p);return `<circle cx="${x}" cy="${y}" r="10" fill="#d94b47"/>`;}).join('') : '';
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="svg-map"><rect width="${w}" height="${h}" rx="22" fill="#cfe2ee"/><path d="M0 390 C160 320 220 430 380 345 S690 250 900 320 L900 520 L0 520 Z" fill="#b9d4c7" opacity=".85"/><path d="M0 160 C190 70 270 175 450 110 S700 70 900 145" fill="none" stroke="#eef6fb" stroke-width="72" opacity=".7"/>${segs}${fallDots}</svg>`;
}

function speedGradientColor(sp){
  // Quantized gradient keeps the same visual meaning while allowing adjacent
  // points to share a Leaflet polyline instead of creating one layer per point.
  const stops = [[0,'#1f7fbd'],[30,'#6bc46d'],[50,'#e7c94f'],[70,'#d94b47']];
  const clamped = clamp(sp, stops[0][0], stops[stops.length-1][0]);
  const quantized = Math.round(clamped / 5) * 5;
  for(let i=1;i<stops.length;i++){
    if(quantized <= stops[i][0]){
      const t = (quantized - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
      return lerpColor(stops[i-1][1], stops[i][1], t);
    }
  }
  return stops[stops.length-1][1];
}
function lerpColor(a, b, t){
  const ah = a.replace('#',''), bh = b.replace('#','');
  const ar = parseInt(ah.slice(0,2),16), ag = parseInt(ah.slice(2,4),16), ab = parseInt(ah.slice(4,6),16);
  const br = parseInt(bh.slice(0,2),16), bg = parseInt(bh.slice(2,4),16), bb = parseInt(bh.slice(4,6),16);
  const r = Math.round(ar+(br-ar)*t), g = Math.round(ag+(bg-ag)*t), bl = Math.round(ab+(bb-ab)*t);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${bl.toString(16).padStart(2,'0')}`;
}

function edgingGradientColor(angle){
  const value = Math.abs(Number(angle));
  if(!Number.isFinite(value)) return edgeColor();
  const stops = [[0,'#b7dff2'],[25,'#1f7fbd'],[40,'#6bc46d'],[55,'#e7c94f'],[70,'#d94b47']];
  const clamped = clamp(value, 0, 70);
  for(let index=1; index<stops.length; index++){
    if(clamped <= stops[index][0]){
      const ratio = (clamped-stops[index-1][0])/(stops[index][0]-stops[index-1][0]);
      return lerpColor(stops[index-1][1],stops[index][1],ratio);
    }
  }
  return stops[stops.length-1][1];
}

function slopeDifficultyColor(value){
  return ({easy:'#1f7fbd', intermediate:'#d94b47', expert:'#173e64'})[String(value || '').toLowerCase()] || '#9aa7b1';
}

function colorFor(mode, p, idx){
  const sp = kmh(+p.speed || 0);
  const alt = +p.alt || 0;
  if(mode === 'speed') return speedGradientColor(sp);
  if(mode === 'technique') return {Carving:'#1f7fbd','Drifted turns':'#f4a340','Snowplow steered':'#d94b47','Parallel turns':'#6bc46d','Short turns':'#f4a340','Gliding':'#9aa7b1'}[p.analytics_technique || classifyTechnique(p)] || '#1f7fbd';
  if(mode === 'edge') return edgingGradientColor(p.effective_edging_angle ?? p.analytics_effective_edging_deg);
  if(mode === 'falls') return '#9aa7b1';
  if(mode === 'elevation') return alt > percentile(metrics.alts,.66) ? '#173e64' : alt > percentile(metrics.alts,.33) ? '#60a5c9' : '#b7dff2';
  if(mode === 'slope') return slopeDifficultyColor(p.slope_class);
  if(mode === 'service') return ({green:'#6bc46d', yellow:'#e7c94f', red:'#d94b47'})[serviceStatusFromKm(CONFIG.kmSinceService)];
  return '#1f7fbd';
}

function renderLegend(mode){
  const legends = {
    technique:[['Carving','#1f7fbd'],['Drifted turns','#f4a340'],['Snowplow steered','#d94b47'],['Parallel turns','#6bc46d'],['Gliding','#9aa7b1']],
    edge:[['Low edging (0–25°)','#1f7fbd'],['Effective edging (25–40°)','#6bc46d'],['High edging (40–55°)','#e7c94f'],['Very high edging (55°+)','#d94b47']],
    falls:[['Trajectory','#9aa7b1'],['Fall candidate','#d94b47']],
    elevation:[['Lower altitude','#b7dff2'],['Mid altitude','#60a5c9'],['Higher altitude','#173e64']],
    slope:[['Easy','#1f7fbd'],['Intermediate','#d94b47'],['Expert','#173e64'],['No JSON match','#9aa7b1']],
    service:[['Good','#6bc46d'],['Service soon','#e7c94f'],['Service needed','#d94b47']]
  };
  if(mode === 'speed'){
    $('legend').innerHTML = `<h3>Speed legend</h3><div class="speed-gradient-legend"><div class="speed-gradient-bar"></div><div class="speed-gradient-labels"><span>0</span><span>30</span><span>50</span><span>70+ km/h</span></div></div>`;
    return;
  }
  $('legend').innerHTML = `<h3>${labelFor(mode)} legend</h3>` + legends[mode].map(([t,c])=>`<div class="legend-item"><span class="dot" style="background:${c}"></span>${t}</div>`).join('');
}

function initCharts(){
  const times = points.map(p => new Date(p.phone_time));
  makeLine('speedChart', metrics.speeds, 'Speed km/h', times);
  makeLine('elevationChart', metrics.alts, 'Altitude m', times);
  makeLine('rhythmChart', points.map(p => (mag(p,'left_gyro')+mag(p,'right_gyro'))/2), 'Turn frequency', times);
  makeLine('historyChart', [62,66,69,74,78,80,84,83,87], 'Season technique score');
}

function makeLine(id, data, label, times){
  const labels = times
    ? times.map(t => t instanceof Date && !isNaN(t) ? t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '')
    : data.map((_,i) => i+1);
  // downsample labels to avoid crowding: show ~8 ticks
  const step = Math.max(1, Math.floor(labels.length / 8));
  const sparseLabels = labels.map((l,i) => i % step === 0 ? l : '');
  new Chart($(id), {
    type:'line',
    data:{labels: sparseLabels, datasets:[{label, data, tension:.35, pointRadius:0, borderWidth:3, fill:true}]},
    options:{
      responsive:true, maintainAspectRatio:true, aspectRatio:3,
      plugins:{legend:{display:false}},
      scales:{
        x:{
          display:true,
          ticks:{color:'#7590a2', font:{size:10}, maxRotation:0, autoSkip:false},
          grid:{display:false}
        },
        y:{grid:{color:'#dbe8f0'}, ticks:{color:'#7590a2', font:{size:10}}}
      }
    }
  });
}

function splitIntoRuns(arr, n){const size=Math.ceil(arr.length/n);return Array.from({length:n},(_,i)=>arr.slice(i*size,(i+1)*size)).filter(x=>x.length)}
function classifyTechnique(p){const sp=kmh(+p.speed||0), gyro=(mag(p,'left_gyro')+mag(p,'right_gyro'))/2;if(sp>35&&gyro>20)return 'Carving';if(gyro>35)return 'Short turns';if(sp<12)return 'Gliding';return 'Parallel turns'}
function detectFalls(rows){
  return annotateFallCandidates(rows)
    .filter(point => point.fall_candidate === true || point.fall_detected === true)
    .sort((a,b) => finiteMetric(b.fall_confidence, 0) - finiteMetric(a.fall_confidence, 0))
    .slice(0,12);
}

function annotateFallCandidates(inputRows){
  const rows = Array.isArray(inputRows) ? inputRows.map(point => ({...point})) : [];
  if(!rows.length) return rows;

  const medianValue = values => {
    const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
    if(!sorted.length) return null;
    const middle = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle]) / 2;
  };
  const madValue = values => {
    const center = medianValue(values);
    return Number.isFinite(center) ? medianValue(values.map(value => Math.abs(value-center))) : null;
  };
  const robustThreshold = (values, minimum, multiplier=5) => {
    const center = medianValue(values);
    const mad = madValue(values);
    const robust = Number.isFinite(center) && Number.isFinite(mad) ? center + multiplier * 1.4826 * mad : minimum;
    return Math.max(minimum, Number.isFinite(robust) ? robust : minimum);
  };
  const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
  const timestamp = point => {
    const value = new Date(point.phone_time || point.timestamp || point.datetime || point.time || '').getTime();
    return Number.isFinite(value) ? value : null;
  };
  const explicitFall = point => {
    for(const key of ['fall_detected','fall','falls','is_fall']){
      if(point[key] === true || point[key] === 1 || String(point[key]).toLowerCase() === 'true') return true;
    }
    return false;
  };

  const acc = rows.map(point => Math.max(mag(point,'left_acc'), mag(point,'right_acc')));
  const gyro = rows.map(point => Math.max(mag(point,'left_gyro'), mag(point,'right_gyro')));
  const times = rows.map(timestamp);
  const speeds = rows.map(point => Number.isFinite(Number(point.speed)) ? Number(point.speed) : null);
  const jerk = rows.map((_,index) => {
    if(index === 0 || !Number.isFinite(acc[index]) || !Number.isFinite(acc[index-1])) return null;
    const dt = Number.isFinite(times[index]) && Number.isFinite(times[index-1]) ? Math.max(.02,(times[index]-times[index-1])/1000) : .1;
    return Math.abs(acc[index]-acc[index-1])/dt;
  });

  const accThreshold = robustThreshold(acc, 36, 5);
  const gyroThreshold = robustThreshold(gyro, 120, 5);
  const jerkThreshold = robustThreshold(jerk, 80, 5);
  const candidates=[];

  for(let index=0; index<rows.length; index++){
    const explicit = explicitFall(rows[index]);
    const impactScore = clamp01((acc[index]-accThreshold*.75)/(accThreshold*.75));
    const gyroScore = clamp01((gyro[index]-gyroThreshold*.65)/(gyroThreshold*.85));
    const jerkScore = clamp01(((jerk[index]||0)-jerkThreshold*.65)/(jerkThreshold*.9));

    const before = speeds.slice(Math.max(0,index-6), index).filter(Number.isFinite);
    const after = speeds.slice(index+1, Math.min(rows.length,index+13)).filter(Number.isFinite);
    const preSpeed = medianValue(before);
    const postSpeed = medianValue(after);
    const speedDropRatio = Number.isFinite(preSpeed) && preSpeed > 2 && Number.isFinite(postSpeed)
      ? clamp01((preSpeed-postSpeed)/Math.max(preSpeed,1)) : 0;
    const lowMovementRatio = after.length ? after.filter(value => value < 1).length / after.length : 0;

    const corroborators = [gyroScore >= .35, jerkScore >= .35, speedDropRatio >= .45, lowMovementRatio >= .55].filter(Boolean).length;
    let confidence = explicit ? 1 : (
      impactScore * .35 +
      gyroScore * .20 +
      jerkScore * .15 +
      speedDropRatio * .20 +
      lowMovementRatio * .10
    );
    if(!explicit && (impactScore < .50 || corroborators === 0)) confidence = Math.min(confidence,.49);

    if(explicit || confidence >= .55){
      candidates.push({index,confidence:clamp01(confidence),explicit,impact:acc[index],gyro:gyro[index],speedDropRatio,lowMovementRatio});
    }
  }

  // Merge nearby flagged samples into one event and retain only the strongest peak.
  const events=[];
  for(const candidate of candidates){
    const last=events[events.length-1];
    const currentTime=times[candidate.index];
    const lastTime=last ? times[last.peak.index] : null;
    const closeInTime = Number.isFinite(currentTime) && Number.isFinite(lastTime)
      ? currentTime-lastTime <= 2500
      : last && candidate.index-last.peak.index <= 8;
    if(last && closeInTime){
      last.members.push(candidate);
      if(candidate.confidence > last.peak.confidence) last.peak=candidate;
    }else events.push({peak:candidate,members:[candidate]});
  }

  rows.forEach(point => {
    point.fall_candidate=false;
    point.fall_detected=false;
    point.fall_confidence=0;
    point.fall_status='none';
    point.fall_source='multi-signal heuristic';
  });
  events.forEach((event,eventIndex) => {
    const {peak}=event;
    const point=rows[peak.index];
    const likely=peak.explicit || peak.confidence >= .75;
    Object.assign(point,{
      fall_candidate:true,
      fall_detected:likely,
      fall_confidence:Number(peak.confidence.toFixed(3)),
      fall_status:likely?'likely':'possible',
      fall_source:peak.explicit?'explicit data flag':'multi-signal heuristic',
      fall_event_id:`fall-${eventIndex+1}`,
      fall_impact_magnitude:Number.isFinite(peak.impact)?Number(peak.impact.toFixed(2)):null,
      fall_gyro_magnitude:Number.isFinite(peak.gyro)?Number(peak.gyro.toFixed(2)):null,
      fall_speed_drop_percent:Number((peak.speedDropRatio*100).toFixed(1)),
      fall_low_movement_percent:Number((peak.lowMovementRatio*100).toFixed(1))
    });
  });
  return rows;
}
function edgeText(){return CONFIG.edgeCondition === 'red' ? 'DULL' : CONFIG.edgeCondition === 'yellow' ? 'YELLOW' : 'SHARP'}
function edgeColor(){return CONFIG.edgeCondition === 'red' ? '#d94b47' : CONFIG.edgeCondition === 'yellow' ? '#e7c94f' : '#6bc46d'}
function labelFor(mode){return ({speed:'Speed', technique:'Ski technique', edge:'Edging', falls:'Falls', elevation:'Elevation', slope:'Slope difficulty', service:'Service intensity'})[mode] || mode}
function kmh(ms){return ms*3.6}
function mean(a){return a.reduce((x,y)=>x+y,0)/(a.length||1)}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function mag(p,pre){return Math.sqrt((+p[`${pre}_x`]||0)**2+(+p[`${pre}_y`]||0)**2+(+p[`${pre}_z`]||0)**2)}
function percentile(arr,p){const s=[...arr].sort((a,b)=>a-b);return s[Math.floor((s.length-1)*p)]||0}
function haversine(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLon=(b.lon-a.lon)*Math.PI/180;const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
function formatDuration(ms){let s=Math.max(0,Math.round(ms/1000));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}

function renderRunMapLegend(mode){
  const el = $('runMapLegend');
  if(!el) return;
  if(mode === 'speed'){
    el.innerHTML = `<div class="speed-gradient-legend compact"><div class="speed-gradient-bar"></div><div class="speed-gradient-labels"><span>0</span><span>30</span><span>50</span><span>70+ km/h</span></div></div>`;
    return;
  }
  const legends = {
    technique:[['Carving','#1f7fbd'],['Drifted','#f4a340'],['Snowplow','#d94b47'],['Parallel','#6bc46d'],['Gliding','#9aa7b1']],
    edge:[['Low','#1f7fbd'],['Effective','#6bc46d'],['High','#e7c94f'],['Very high','#d94b47']],
    falls:[['Route','#9aa7b1'],['Fall','#d94b47']]
  };
  el.innerHTML = (legends[mode]||[]).map(([t,c])=>`<div class="legend-item"><span class="dot" style="background:${c}"></span>${t}</div>`).join('');
}

// ── Bbox-reactive: update charts & KPIs when map is panned/zoomed ──
let chartInstances = {};
// ── Hover crosshair state ──
let hoverMarker = null;
let activeHoverPoints = [];
let activeRunBboxPoints = []; // the points array currently shown in charts

function samplePointsForCharts(rows, maxPoints = 2000){
  const safeRows = Array.isArray(rows) ? rows : [];
  if(safeRows.length <= maxPoints) return safeRows;
  const sampled = [];
  const groups = groupPointsByRun(safeRows);
  const pointGroups = groups.length ? groups.map(group => group.points) : [safeRows];
  const total = safeRows.length || 1;
  pointGroups.forEach(groupRows => {
    const budget = Math.max(2, Math.round(maxPoints * groupRows.length / total));
    if(groupRows.length <= budget){ sampled.push(...groupRows); return; }
    const step = (groupRows.length - 1) / (budget - 1);
    for(let index = 0; index < budget; index += 1){
      sampled.push(groupRows[Math.min(groupRows.length - 1, Math.round(index * step))]);
    }
  });
  return sampled;
}

function initChartsReactive(){
  const chartPoints = samplePointsForCharts(points);
  activeHoverPoints = chartPoints;
  chartInstances.speed     = makeLineReactive('speedChart', chartPoints.map(p=>kmh(+p.speed||0)), 'Speed km/h', chartPoints, 'speed');
  chartInstances.elevation = makeLineReactive('elevationChart', chartPoints.map(p=>+p.alt||0), 'Altitude m', chartPoints, 'elev');
  chartInstances.rhythm    = makeLineReactive('rhythmChart',
    chartPoints.map(p => (mag(p,'left_gyro')+mag(p,'right_gyro'))/2), 'Turn frequency', chartPoints, 'rhythm');
  makeLine('historyChart', [62,66,69,74,78,80,84,83,87], 'Season technique score');

  // Listen to run map move/zoom — debounced
  if(maps.run){
    let bboxTimer = null;
    maps.run.on('moveend zoomend', () => {
      clearTimeout(bboxTimer);
      bboxTimer = setTimeout(() => {
        if(selectedRunIndex !== null) return; // don't override run filter
        const bbox = maps.run.getBounds();
        const visible = points.filter(p => bbox.contains([p.lat, p.lon]));
        if(visible.length < 2) return;
        activeHoverPoints = visible;
        updateChartsForPoints(visible);
        activeRunBboxPoints = visible;
  updateRunSessionKpis(visible);
      }, 150);
    });
  }
}


function pointInsideRunMapBounds(point, bounds){
  const lon=Number(point?.lon), lat=Number(point?.lat);
  if(!Number.isFinite(lon)||!Number.isFinite(lat)||!bounds) return false;
  const west=Number(bounds.west), east=Number(bounds.east), south=Number(bounds.south), north=Number(bounds.north);
  if(![west,east,south,north].every(Number.isFinite)) return false;
  const longitudeInside = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return longitudeInside && lat >= south && lat <= north;
}

function nearestChartPointIndex(payload){
  if(!activeHoverPoints.length) return -1;
  const targetTime=new Date(payload?.time||'').getTime();
  const targetLon=Number(payload?.lon), targetLat=Number(payload?.lat);
  let best=-1, bestScore=Infinity;
  activeHoverPoints.forEach((point,index)=>{
    const pointTime=new Date(point?.phone_time||point?.timestamp||'').getTime();
    let score=0;
    if(Number.isFinite(targetTime)&&Number.isFinite(pointTime)) score+=Math.abs(pointTime-targetTime)/1000;
    if(Number.isFinite(targetLon)&&Number.isFinite(targetLat)){
      const dx=(Number(point?.lon)-targetLon)*Math.cos(targetLat*Math.PI/180);
      const dy=Number(point?.lat)-targetLat;
      score+=Math.sqrt(dx*dx+dy*dy)*100000;
    }
    if(score<bestScore){bestScore=score;best=index;}
  });
  return best;
}

window.addEventListener('message', event => {
  const data=event.data;
  if(!data?.type) return;
  if(data.type==='SKI_RUN_MAP_VIEWPORT'){
    clearTimeout(runMapViewportTimer);
    runMapViewportTimer=setTimeout(()=>{
      const source=currentRunMapPoints.length?currentRunMapPoints:(selectedRunIndex===null?points:(runTableData.find(row=>row.run===selectedRunIndex)?.points||points));
      const visible=source.filter(point=>pointInsideRunMapBounds(point,data.bounds));
      if(visible.length<2) return;
      updateChartsForPoints(visible);
      activeRunBboxPoints = visible;
  updateRunSessionKpis(visible);
    },120);
  }
  if(data.type==='SKI_RUN_MAP_HOVER'){
    const index=nearestChartPointIndex(data);
    if(index>=0) syncAllChartsToIndex(index,'map');
  }
  if(data.type==='SKI_RUN_MAP_HOVER_CLEAR') clearAllHover();
});

// ── Crosshair plugin: draws a vertical line at the active tooltip index ──
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart){
    if(chart._hoverIdx == null) return;
    const meta = chart.getDatasetMeta(0);
    if(!meta || !meta.data[chart._hoverIdx]) return;
    const x = meta.data[chart._hoverIdx].x;
    const {top, bottom} = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#2e75aa99';
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }
};
Chart.register(crosshairPlugin);

// ── Sync hover: driven by mousemove on canvas, no tooltip callbacks ──
let _syncingHover = false;

function bindHoverSync(chart, chartKey){
  const canvas = chart.canvas;

  canvas.addEventListener('mousemove', evt => {
    if(_syncingHover) return;
    const points_arr = chart.data.datasets[0]?.data;
    if(!points_arr?.length) return;

    const rect = canvas.getBoundingClientRect();
    const xPos = evt.clientX - rect.left;
    const area = chart.chartArea;
    if(!area || xPos < area.left || xPos > area.right) return;

    // Find nearest data index by x pixel position
    const meta = chart.getDatasetMeta(0);
    let nearestIdx = 0, minDist = Infinity;
    meta.data.forEach((el, i) => {
      const dist = Math.abs(el.x - xPos);
      if(dist < minDist){ minDist = dist; nearestIdx = i; }
    });

    _syncingHover = true;
    syncAllChartsToIndex(nearestIdx, chartKey);
    _syncingHover = false;
  });

  canvas.addEventListener('mouseleave', () => {
    if(_syncingHover) return;
    _syncingHover = true;
    clearAllHover();
    _syncingHover = false;
  });
}

function syncAllChartsToIndex(idx, sourceKey){
  const keys = ['speed','elevation','rhythm'];
  keys.forEach(key => {
    const ch = chartInstances[key];
    if(!ch) return;
    ch._hoverIdx = idx;
    // Show tooltip only on the source chart; others just get crosshair + suppressed tooltip
    if(key === sourceKey){
      ch.tooltip.setActiveElements([{datasetIndex:0, index:idx}], {x:0, y:0});
    } else {
      ch.tooltip.setActiveElements([], {x:0, y:0});
    }
    ch.update('none');
  });

  // Move the synchronized marker on the MapTiler iframe (or Leaflet fallback).
  if(activeHoverPoints[idx]){
    const p = activeHoverPoints[idx];
    const frame=document.getElementById('runAnalysisMap');
    if(frame){
      frame.contentWindow?.postMessage({type:'SKI_RUN_MAP_HOVER_POINT',point:{lon:Number(p.lon),lat:Number(p.lat)}},'*');
    } else if(maps.run && !maps.fallback){
      if(!hoverMarker){
        hoverMarker = L.circleMarker([p.lat, p.lon], {
          radius: 8, color: '#fff', fillColor: '#1f7fbd',
          fillOpacity: 1, weight: 3, zIndexOffset: 1000
        }).addTo(maps.run);
      } else {
        hoverMarker.setLatLng([p.lat, p.lon]);
      }
      hoverMarker.setStyle({opacity:1, fillOpacity:1});
    }
  }
}

function clearAllHover(){
  const keys = ['speed','elevation','rhythm'];
  keys.forEach(key => {
    const ch = chartInstances[key];
    if(!ch) return;
    ch._hoverIdx = null;
    ch.tooltip.setActiveElements([], {x:0, y:0});
    ch.update('none');
  });
  document.getElementById('runAnalysisMap')?.contentWindow?.postMessage({type:'SKI_RUN_MAP_HOVER_CLEAR'},'*');
  if(hoverMarker) hoverMarker.setStyle({opacity:0, fillOpacity:0});
}

// Build elapsed-minutes labels from a points array
function buildMinuteLabels(pts){
  const times = pts.map(p => new Date(p.phone_time));
  const validTimes = times.filter(t => !isNaN(t));
  if(validTimes.length < 2){
    // Fallback: evenly spaced indices as minutes (assume 9s intervals → /6.67 per min)
    return pts.map((_, i) => {
      const sec = i * 9;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return i % Math.max(1, Math.floor(pts.length / 8)) === 0
        ? `${m}:${String(s).padStart(2,'0')}`
        : '';
    });
  }
  const t0 = validTimes[0].getTime();
  return times.map((t, i) => {
    if(isNaN(t)) return '';
    const elapsed = (t.getTime() - t0) / 1000; // seconds
    const m = Math.floor(elapsed / 60);
    const s = Math.round(elapsed % 60);
    // Show label only ~8 times across the axis
    const step = Math.max(1, Math.floor(pts.length / 8));
    return i % step === 0 ? `${m}:${String(s).padStart(2,'0')}` : '';
  });
}

function makeLineReactive(id, data, label, pts, chartKey){
  const labels = buildMinuteLabels(pts);
  const ds = {label, data:[...data], tension:.35, pointRadius:0, borderWidth:3, fill:true};
  const chart = new Chart($(id), {
    type:'line',
    data:{labels, datasets:[ds]},
    options:{
      responsive:true, maintainAspectRatio:true, aspectRatio:3,
      animation:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{display:false},
        tooltip:{ mode:'index', intersect:false }
      },
      scales:{
        x:{
          display:true,
          title:{ display:true, text:'min:sec', color:'#9ab0be', font:{size:10} },
          ticks:{color:'#7590a2', font:{size:10}, maxRotation:0, autoSkip:false},
          grid:{display:false}
        },
        y:{grid:{color:'#dbe8f0'}, ticks:{color:'#7590a2', font:{size:10}}}
      }
    }
  });
  chart._hoverIdx = null;
  bindHoverSync(chart, chartKey);
  return chart;
}

// Keep buildTimeLabels for the non-reactive historyChart
function buildTimeLabels(times, len){
  if(!times) return Array.from({length:len},(_,i)=>i+1);
  return times.map(t => t instanceof Date && !isNaN(t) ? t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '');
}

function updateChartsForPoints(visible){
  if(!visible?.length) return;
  const chartPoints = samplePointsForCharts(visible);
  activeHoverPoints = chartPoints;
  const labels = buildMinuteLabels(chartPoints);

  if(chartInstances.speed){
    chartInstances.speed.data.labels = labels;
    chartInstances.speed.data.datasets[0].data = chartPoints.map(p=>kmh(+p.speed||0));
    chartInstances.speed.update('none');
  }
  if(chartInstances.elevation){
    chartInstances.elevation.data.labels = labels;
    chartInstances.elevation.data.datasets[0].data = chartPoints.map(p=>+p.alt||0);
    chartInstances.elevation.update('none');
  }
  if(chartInstances.rhythm){
    chartInstances.rhythm.data.labels = labels;
    chartInstances.rhythm.data.datasets[0].data = chartPoints.map(p=>(mag(p,'left_gyro')+mag(p,'right_gyro'))/2);
    chartInstances.rhythm.update('none');
  }
}

function updateRunSessionKpis(visible){
  const mm = computeMetrics(visible);
  const elevGained = sumElevationGain(visible);
  if($('runMaxSpeed')) $('runMaxSpeed').textContent = `${mm.maxSpeedKmh.toFixed(1)} km/h`;
  if($('runFalls')) $('runFalls').textContent = mm.falls.length;
  if($('runCount')) $('runCount').textContent = dashboardRunGroups(visible).length;
  if($('runTotalTime')) $('runTotalTime').textContent = formatDuration(mm.durationMs);
  if($('runElevGained')) $('runElevGained').textContent = `${elevGained.toFixed(0)} m`;
  if($('runDomTechnique')) $('runDomTechnique').textContent = mm.mainTechnique;

  const runsViewActive = document.querySelector('.nav[data-view="runs"]')?.classList.contains('active');
  if(runsViewActive) renderRunTopKpis(visible);
}

// ── Modal helpers ──
function openModal(id){ $(id).style.display='flex'; }
function closeModal(id){ $(id).style.display='none'; }
function showToast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(()=>{ t.style.display='none'; }, 3500);
}

function openAddSki(){
  $('newSkiName').value=''; $('newSkiType').value=''; $('newSkiLength').value='';
  $('newSkiRadius').value=''; $('newSkiKm').value=''; $('newSkiEdge').value='YELLOW';
  openModal('modalAddSki');
}

function addSkiModel(){
  const name   = $('newSkiName').value.trim();
  const type   = $('newSkiType').value.trim() || 'All-round';
  const length = $('newSkiLength').value || '170';
  const radius = $('newSkiRadius').value || '14.0';
  const km     = Math.max(0, Number($('newSkiKm').value) || 0);
  if(!name){ $('newSkiName').focus(); return; }

  try{
    createDashboardSki({name, type, radius, length, km}, {select:false, render:true, source:'equipment-add-ski'});
    closeModal('modalAddSki');
    showToast(`✓ ${name} added to your saved ski models`);
  }catch(error){
    showToast(error.message);
    $('newSkiName').focus();
  }
}

function openBookService(){
  if(!servicePartners.length){
    showToast('Upload raw data first to retrieve service partners around its AOI.');
    return;
  }

  const partnerSelect = $('bookPartner');
  partnerSelect.disabled = false;
  partnerSelect.innerHTML = servicePartners.map(partner => {
    const distance = Number.isFinite(Number(partner.distanceKm)) ? `${Number(partner.distanceKm).toFixed(1)} km` : 'distance unavailable';
    return `<option value="${escapeDashboardAttribute(partner.name)}">${escapeDashboardText(partner.name)} (${distance})</option>`;
  }).join('');

  const skiSelect = $('bookSki');
  skiSelect.innerHTML = SKIS.map(s => `<option${s.name === CONFIG.selectedSki ? ' selected' : ''}>${escapeDashboardText(s.name)}</option>`).join('');
  $('bookDate').value = new Date().toISOString().split('T')[0];
  openModal('modalBookService');
}

function confirmBooking(){
  const partner = $('bookPartner').value;
  const date    = $('bookDate').value;
  const time    = $('bookTime').value;
  const ski     = $('bookSki').value;
  if(!date){ $('bookDate').focus(); return; }
  closeModal('modalBookService');
  showToast(`✓ Service booked at ${partner} on ${date} at ${time} for ${ski}`);
}

// Close modal when clicking outside the box
document.querySelectorAll('.modal-overlay').forEach(el =>
  el.addEventListener('click', e => { if(e.target===el) el.style.display='none'; })
);


document.querySelectorAll('.map-pill').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.map-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectMapLayersAnalyticalLayer(btn.dataset.mode); postRunAnalysisMapData(selectedRunIndex===null?points:(runTableData.find(r=>r.run===selectedRunIndex)?.points||points), false);
}));

function syncViewSpecificKpis(viewName){
  const topKpis = $('overallKpisBar');
  const runRail = $('runRailKpis');
  if(topKpis) topKpis.hidden = !['overview','runs'].includes(viewName);
  if(runRail) runRail.hidden = true;

  if(viewName === 'runs'){
    const selected = selectedRunIndex === null
      ? points
      : (runTableData.find(row => row.run === selectedRunIndex)?.points || points);
    renderRunTopKpis(activeRunBboxPoints?.length ? activeRunBboxPoints : selected);
  } else if(viewName === 'overview'){
    renderOverviewTopKpis();
    const secondary = $('overviewSecondarySummary');
    if(secondary) secondary.hidden = false;
  }
}

document.querySelectorAll('.nav').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav,.view').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  $(btn.dataset.view).classList.add('active');
  syncViewSpecificKpis(btn.dataset.view);
  $('pageTitle').textContent = btn.textContent.trim() === 'Map Layers' ? 'Interactive Map Layers' : btn.textContent.trim();
  setTimeout(()=>Object.values(maps).forEach(m => { if(m && typeof m.invalidateSize === 'function') m.invalidateSize(); }), 150);
}));
syncViewSpecificKpis('overview');

document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', e => {
  const activeLayerLabel = $('activeLayerLabel');
  if(activeLayerLabel) activeLayerLabel.textContent = labelFor(e.target.value);
  renderLegend(e.target.value);
  selectMapLayersAnalyticalLayer(e.target.value);
}));

const resetServiceButton = $('resetServiceButton');
if(resetServiceButton) resetServiceButton.addEventListener('click', resetServiceStatus);
const correctServiceKmButton = $('correctServiceKmButton');
if(correctServiceKmButton) correctServiceKmButton.addEventListener('click', correctServiceKilometers);


// ── Persistent cumulative upload history and global filters ──
let historyRecords = [];
let activeHistoryFilter = {skiModel:'all', season:'all', from:'', to:''};

function historyFilterFromControls(){
  return {
    skiModel: $('globalSkiModelFilter')?.value || 'all',
    season: $('globalSeasonFilter')?.value || 'all',
    from: $('globalDateFrom')?.value || '',
    to: $('globalDateTo')?.value || ''
  };
}

function mergeHistoryAoi(records){
  const bounds = records.map(r => r.aoi?.bounds).filter(b => b && [b.south,b.west,b.north,b.east].every(Number.isFinite));
  if(!bounds.length) return null;
  const south=Math.min(...bounds.map(b=>b.south)), west=Math.min(...bounds.map(b=>b.west));
  const north=Math.max(...bounds.map(b=>b.north)), east=Math.max(...bounds.map(b=>b.east));
  return {bounds:{south,west,north,east}, center:{lat:(south+north)/2, lon:(west+east)/2}};
}

function populateHistorySkiModelOptions(records){
  const select = $('globalSkiModelFilter');
  if(!select) return;
  const current = select.value || 'all';
  const names = [...new Set([
    ...SKIS.map(ski => ski.name),
    ...records.map(record => String(record.skiModel || '').trim()).filter(Boolean)
  ])].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
  select.innerHTML = '<option value="all">All ski models</option>'
    + names.map(name => `<option value="${escapeDashboardAttribute(name)}">${escapeDashboardText(name)}</option>`).join('');
  select.value = current === 'all' || names.includes(current) ? current : 'all';
}

function recordsForSelectedSkiFilter(records){
  const skiModel = $('globalSkiModelFilter')?.value || 'all';
  if(skiModel === 'all') return records;
  const key = normalizedSkiName(skiModel);
  return records.filter(record => normalizedSkiName(record.skiModel) === key);
}

function populateHistorySeasonOptions(records){
  const eligibleRecords = recordsForSelectedSkiFilter(records);
  const seasons=[...new Set(eligibleRecords.map(r=>r.season).filter(Boolean))].sort().reverse();
  const controls=[$('globalSeasonFilter'), $('seasonSelect')].filter(Boolean);
  controls.forEach(select => {
    const current=select.value || 'all';
    select.innerHTML='<option value="all">All seasons</option>'+seasons.map(v=>`<option value="${escapeDashboardAttribute(v)}">${escapeDashboardText(v)}</option>`).join('');
    select.value=seasons.includes(current) ? current : 'all';
  });
}

function normalizedSkiName(value){
  return String(value || '').trim().toLocaleLowerCase();
}

function historyRunFileCount(records){
  return records.reduce((sum, record) => sum + (Number(record.filesProcessed) || 0), 0);
}

function updateHistoryFilterSummary(filtered, all){
  if($('historyUploadCount')) $('historyUploadCount').textContent=`${filtered.length} of ${all.length} upload${all.length===1?'':'s'}`;
  const distance=filtered.reduce((sum,r)=>sum+(Number(r.totalDistanceKm)||0),0);
  const selectedKey = normalizedSkiName(CONFIG.selectedSki);
  const assignedFiles = historyRunFileCount(filtered.filter(record => normalizedSkiName(record.skiModel) === selectedKey));
  const unassignedFiles = historyRunFileCount(filtered.filter(record => !normalizedSkiName(record.skiModel)));
  const status=[];
  if(activeHistoryFilter.skiModel !== 'all') status.push(activeHistoryFilter.skiModel);
  else status.push('All ski models');
  if(activeHistoryFilter.season !== 'all') status.push(activeHistoryFilter.season);
  if(activeHistoryFilter.from || activeHistoryFilter.to) status.push(`${activeHistoryFilter.from || 'earliest'} → ${activeHistoryFilter.to || 'latest'}`);
  status.push(`${historyRunFileCount(filtered)} run files in view`);
  status.push(`${assignedFiles} assigned to ${CONFIG.selectedSki || 'selected ski'}`);
  if(unassignedFiles) status.push(`${unassignedFiles} unassigned`);
  status.push(`${formatServiceKm(distance)} km total`);
  if($('historyFilterStatus')) $('historyFilterStatus').textContent=status.join(' · ');

  const infoContent = $('datasetInfoContent');
  const infoButton = $('datasetInfoButton');
  const runFiles = historyRunFileCount(filtered);
  const analyticsFiles = filtered.reduce((sum, record) => sum + Number(record.analyticsFilesMatched || record.analyticsMatched || record.summary?.analyticsFilesMatched || record.summary?.analyticsMatched || 0), 0);
  const selectedModelLabel = activeHistoryFilter.skiModel === 'all' ? 'All ski models' : activeHistoryFilter.skiModel;
  const seasonLabel = activeHistoryFilter.season === 'all' ? 'All seasons' : `Season ${activeHistoryFilter.season}`;
  const dateLabel = activeHistoryFilter.from || activeHistoryFilter.to
    ? `${activeHistoryFilter.from || 'Earliest'} → ${activeHistoryFilter.to || 'Latest'}`
    : 'All dates';
  if(infoContent) infoContent.innerHTML = `
    <dl>
      <div><dt>Ski model</dt><dd>${escapeDashboardText(selectedModelLabel)}</dd></div>
      <div><dt>Season</dt><dd>${escapeDashboardText(seasonLabel)}</dd></div>
      <div><dt>Date range</dt><dd>${escapeDashboardText(dateLabel)}</dd></div>
      <div><dt>Runs in view</dt><dd>${runFiles}</dd></div>
      <div><dt>Assigned to ${escapeDashboardText(CONFIG.selectedSki || 'selected ski')}</dt><dd>${assignedFiles}</dd></div>
      ${unassignedFiles ? `<div><dt>Unassigned runs</dt><dd>${unassignedFiles}</dd></div>` : ''}
      <div><dt>Total distance</dt><dd>${formatServiceKm(distance)} km</dd></div>
      <div><dt>Analytics completeness</dt><dd>${runFiles ? (analyticsFiles >= runFiles ? `All ${runFiles} runs fully analysed` : `${Math.min(analyticsFiles, runFiles)} of ${runFiles} runs`) : 'No runs in view'}</dd></div>
    </dl>`;
  if(infoButton) infoButton.disabled = all.length === 0;
}

window.refreshDashboardFromHistory = async function(options = {}){
  if(!window.SkiHistoryStore) return false;
  historyRecords = await window.SkiHistoryStore.all();
  populateHistorySkiModelOptions(historyRecords);
  populateHistorySeasonOptions(historyRecords);
  activeHistoryFilter = historyFilterFromControls();
  const filtered = window.SkiHistoryStore.filterRecords(historyRecords, activeHistoryFilter);
  updateHistoryFilterSummary(filtered, historyRecords);
  if(!historyRecords.length) return false;

  const combinedPoints = filtered.flatMap(record => record.points || []);
  const combinedAcquisitionAnalytics = filtered.flatMap(record => record.acquisitionAnalytics || record.summary?.acquisitionAnalytics || []);
  if(!combinedPoints.length){
    showToast('No stored uploads match the selected season/date filter.');
    return false;
  }

  const selectedSki = CONFIG.selectedSki;
  const selectedSkiKey = normalizedSkiName(selectedSki);
  const resetIso = getServiceResetAt(selectedSki);
  const parsedResetAt = Date.parse(resetIso || '');
  const hasServiceReset = Number.isFinite(parsedResetAt);
  const selectedSkiRecords = historyRecords.filter(record => normalizedSkiName(record.skiModel) === selectedSkiKey);
  const serviceRecords = selectedSkiRecords.filter(record => !hasServiceReset || Date.parse(record.uploadedAt) >= parsedResetAt);
  const serviceHistoryKm = serviceRecords.reduce((sum, record) => sum + (Number(record.totalDistanceKm) || 0), 0);
  const serviceBaselineKm = resolveServiceBaselineKm(selectedSki, serviceHistoryKm, {hasServiceReset});
  const serviceKm = serviceBaselineKm + serviceHistoryKm;
  const filteredKm = filtered.reduce((sum, record) => sum + (Number(record.totalDistanceKm) || 0), 0);
  const filesInView = historyRunFileCount(filtered);
  const selectedSkiRunFiles = historyRunFileCount(filtered.filter(record => normalizedSkiName(record.skiModel) === selectedSkiKey));
  const unassignedRunFiles = historyRunFileCount(filtered.filter(record => !normalizedSkiName(record.skiModel)));
  const newUploadRecord = options.newUploadHash ? historyRecords.find(record => record.hash === options.newUploadHash) : null;
  const summary = {
    filesProcessed: filesInView,
    uploadsCount: filtered.length,
    totalDistanceKm: filteredKm,
    cumulativeServiceDistanceKm: serviceKm,
    serviceBaselineKm,
    serviceHistoryDistanceKm:serviceHistoryKm,
    selectedSkiName:selectedSki,
    selectedSkiRunFiles,
    unassignedRunFiles,
    loadContext:newUploadRecord ? 'new-upload' : 'history-restore',
    newUploadFiles:Number(newUploadRecord?.filesProcessed)||0,
    aoi: mergeHistoryAoi(filtered),
    archiveName: filtered.length===1 ? filtered[0].archiveName : `${filtered.length} cumulative uploads`,
    cumulative:true,
    acquisitionAnalytics:combinedAcquisitionAnalytics,
    analyticsFilesMatched:combinedAcquisitionAnalytics.length,
    analyticsCoveragePercent: filesInView
      ? 100 * combinedAcquisitionAnalytics.length / filesInView
      : 0
  };
  window.applyProcessedDashboardData(combinedPoints, summary);
  return true;
};

function seasonDateRange(seasonLabel){
  const match = String(seasonLabel || '').match(/Season\s+(\d{4})\/(\d{2,4})/i);
  if(!match) return null;
  const startYear = Number(match[1]);
  if(!Number.isFinite(startYear)) return null;
  return {
    from: `${startYear}-07-01`,
    to: `${startYear + 1}-06-30`
  };
}

function applySeasonDateRange(seasonValue){
  const fromInput = $('globalDateFrom');
  const toInput = $('globalDateTo');
  if(!fromInput || !toInput) return;
  if(!seasonValue || seasonValue === 'all'){
    fromInput.value = '';
    toInput.value = '';
    return;
  }
  const range = seasonDateRange(seasonValue);
  if(!range) return;
  fromInput.value = range.from;
  toInput.value = range.to;
}

function initializeHistoryFilters(){
  const skiModel=$('globalSkiModelFilter'), season=$('globalSeasonFilter'), coachSeason=$('seasonSelect');
  skiModel?.addEventListener('change', async () => {
    populateHistorySeasonOptions(historyRecords);
    if(season) season.value='all';
    if(coachSeason) coachSeason.value='all';
    applySeasonDateRange('all');
    await window.refreshDashboardFromHistory();
  });
  season?.addEventListener('change', async () => { if(coachSeason) coachSeason.value=season.value; applySeasonDateRange(season.value); await window.refreshDashboardFromHistory(); });
  coachSeason?.addEventListener('change', async () => { if(season) season.value=coachSeason.value; applySeasonDateRange(coachSeason.value); await window.refreshDashboardFromHistory(); });
  $('globalDateFrom')?.addEventListener('change', () => window.refreshDashboardFromHistory());
  $('globalDateTo')?.addEventListener('change', () => window.refreshDashboardFromHistory());
  $('clearHistoryFilters')?.addEventListener('click', () => {
    if(skiModel) skiModel.value='all';
    if(season) season.value='all'; if(coachSeason) coachSeason.value='all';
    if($('globalDateFrom')) $('globalDateFrom').value=''; if($('globalDateTo')) $('globalDateTo').value='';
    window.refreshDashboardFromHistory();
  });

  // The history-trash action is bound through a stable delegated handler below.
  // This avoids losing the click listener when the toolbar is re-rendered.
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeHistoryFilters);
else initializeHistoryFilters();


// Clear cumulative upload history without affecting the selected ski's service counter.
// Event delegation keeps the trash button functional even if its toolbar DOM is rebuilt.
let historyClearInProgress = false;
async function clearStoredDashboardHistory(){
  const button = $('clearStoredHistory');
  if(historyClearInProgress) return;
  if(!window.SkiHistoryStore || typeof window.SkiHistoryStore.clearAll !== 'function'){
    console.error('History storage is unavailable.');
    showToast?.('Could not access stored dashboard history.');
    return;
  }

  const confirmed = window.confirm(
    'Delete all locally stored dashboard uploads from this browser?\n\n' +
    'Your original ZIP files are not affected, and the selected ski\'s current service kilometres will be preserved.'
  );
  if(!confirmed) return;

  historyClearInProgress = true;
  if(button){
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }

  try{
    const preservedServiceKm = Math.max(0, Number(CONFIG.kmSinceService) || 0);
    setServiceBaselineKm(CONFIG.selectedSki, preservedServiceKm, {
      source:'history-cleared-preserve-service-km'
    });

    await window.SkiHistoryStore.clearAll();
    saveServiceState({
      source:'history-cleared',
      serviceKilometersPreserved:true,
      preservedServiceKm
    });

    historyRecords = [];
    activeHistoryFilter = {skiModel:'all', season:'all', from:'', to:''};
    const skiModel = $('globalSkiModelFilter');
    const season = $('globalSeasonFilter');
    const coachSeason = $('seasonSelect');
    const from = $('globalDateFrom');
    const to = $('globalDateTo');
    if(skiModel) skiModel.value = 'all';
    if(season) season.value = 'all';
    if(coachSeason) coachSeason.value = 'all';
    if(from) from.value = '';
    if(to) to.value = '';
    populateHistorySkiModelOptions([]);
    populateHistorySeasonOptions([]);
    updateHistoryFilterSummary([], []);

    showToast?.('Stored dashboard history cleared.');
    // Reload after the UI has visibly acknowledged the action. This also releases
    // any in-memory trajectory references retained by charts and map iframes.
    window.setTimeout(() => window.location.reload(), 250);
  }catch(error){
    console.error('Could not clear stored dashboard history.', error);
    showToast?.('Could not clear stored history. Please try again.');
    historyClearInProgress = false;
    if(button){
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}
window.clearStoredDashboardHistory = clearStoredDashboardHistory;

document.addEventListener('click', event => {
  const button = event.target.closest?.('#clearStoredHistory');
  if(!button) return;
  event.preventDefault();
  event.stopPropagation();
  clearStoredDashboardHistory();
});


// Dataset information popover
(function setupDatasetInformationPopover(){
  const button = $('datasetInfoButton');
  const popover = $('datasetInfoPopover');
  const close = $('datasetInfoClose');
  if(!button || !popover) return;
  const setOpen = open => {
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if(open) close?.focus();
  };
  button.addEventListener('click', event => { event.stopPropagation(); setOpen(popover.hidden); });
  close?.addEventListener('click', () => setOpen(false));
  popover.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => { if(event.key === 'Escape') setOpen(false); });
})();

/* v43: keep embedded maps and responsive charts aligned with the viewport shell. */
(() => {
  const frameIds = ['overviewMapFrame', 'equipmentMapFrame', 'runAnalysisMap', 'mainMap'];
  let resizeTimer = 0;

  function notifyEmbeddedMaps() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      frameIds.forEach((id) => {
        const frame = document.getElementById(id);
        if (!frame || !frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage({ type: 'dashboard-resize' }, '*');
          frame.contentWindow.dispatchEvent(new Event('resize'));
        } catch (_) {
          // Cross-document resize is best-effort; ResizeObserver still handles layout.
        }
      });
      window.dispatchEvent(new CustomEvent('dashboard:viewport-resized'));
    }, 60);
  }

  window.addEventListener('resize', notifyEmbeddedMaps, { passive: true });
  window.addEventListener('orientationchange', notifyEmbeddedMaps, { passive: true });

  if ('ResizeObserver' in window) {
    const main = document.querySelector('main');
    if (main) {
      const observer = new ResizeObserver(notifyEmbeddedMaps);
      observer.observe(main);
    }
  }

  document.querySelectorAll('.nav[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(notifyEmbeddedMaps);
      });
    });
  });

  window.requestAnimationFrame(notifyEmbeddedMaps);
})();
