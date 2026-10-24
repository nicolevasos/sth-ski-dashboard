(() => {
  'use strict';

  const PHONE_GPS_COLUMNS = [
    'phone_time', 'lat', 'lon', 'alt', 'ref_alt', 'speed'
  ];

  const BOOT_SENSOR_COLUMNS = [
    'tick', 'time', 'acc_x', 'acc_y', 'acc_z',
    'gyro_x', 'gyro_y', 'gyro_z',
    'forefoot_outer', 'forefoot_inner', 'heel',
    'tibia_upper', 'tibia_lower', 'calf_upper', 'calf_lower'
  ];

  const SOURCE_AND_PHONE_COLUMNS = [
    'left_boot_source', 'right_boot_source',
    'phone_acc_x', 'phone_acc_y', 'phone_acc_z',
    'phone_gyro_x', 'phone_gyro_y', 'phone_gyro_z'
  ];

  const STABLE_COLUMNS = [
    ...PHONE_GPS_COLUMNS,
    ...BOOT_SENSOR_COLUMNS.map(column => `left_${column}`),
    ...BOOT_SENSOR_COLUMNS.map(column => `right_${column}`),
    ...SOURCE_AND_PHONE_COLUMNS
  ];

  const OUTPUT_COLUMNS = [...STABLE_COLUMNS, 'run', 'edge_condition', 'source_file', 'ski_model'];
  const DATETIME_COLUMNS = new Set(['phone_time', 'left_time', 'right_time']);
  const DASHBOARD_COLUMNS = [
    'phone_time', 'lat', 'lon', 'alt', 'speed',
    'left_acc_x', 'left_acc_y', 'left_acc_z',
    'right_acc_x', 'right_acc_y', 'right_acc_z',
    'left_gyro_x', 'left_gyro_y', 'left_gyro_z',
    'right_gyro_x', 'right_gyro_y', 'right_gyro_z'
  ];

  const STABLE_COLUMN_INDEX = Object.freeze(Object.fromEntries(STABLE_COLUMNS.map((column, index) => [column, index])));
  const DASHBOARD_COLUMN_INDEXES = Object.freeze(DASHBOARD_COLUMNS.map(column => [column, STABLE_COLUMN_INDEX[column]]));

  const PIPELINE_VERSION = 3;
  const APPLE_REFERENCE_EPOCH_SECONDS = 978307200;

  const OPTIMIZATION_CONFIG = Object.freeze({
    method: 'adaptive_statistical_fidelity_v2',
    minPoints: 160,
    maxPoints: 600,
    basePoints: 120,
    squareRootScale: 3.0,
    complexityBonus: 220,
    robustZThreshold: 3.5,
    minimumTurnDegrees: 10,
    fidelityTargetPercent: 2.0,
    maxIterations: 4,
    growthFactor: 1.45
  });
  const state = {
    csvBlob: null,
    geojsonBlob: null,
    reportBlob: null,
    baseName: 'ski_sensor_data',
    pendingFile: null,
    pendingAssignment: null,
    pendingHash: null,
    sourceFile: null,
    sourceAssignment: null,
    csvGenerating: false,
    geojsonGenerating: false,
    lastDashboardPoints: null,
    lastGeojsonProperties: null
  };

  function byId(id) {
    return document.getElementById(id);
  }


  function setTechnicalDetailsExpanded(expanded) {
    const toggle = byId('pipelineTechnicalToggle');
    const content = byId('pipelineTechnicalContent');
    if (!toggle || !content) return;
    const isExpanded = Boolean(expanded);
    toggle.setAttribute('aria-expanded', String(isExpanded));
    content.hidden = !isExpanded;
  }

  function initDataPipeline() {
    const uploadButton = byId('uploadZipButton');
    const fileInput = byId('zipFileInput');
    const closeButton = byId('closePipelineModal');
    const chooseAgainButton = byId('chooseAnotherZip');
    const openDashboardButton = byId('openDashboardAfterProcessing');
    const modal = byId('dataPipelineModal');
    const assignmentModal = byId('skiAssignmentModal');
    const closeAssignmentButton = byId('closeSkiAssignment');
    const cancelAssignmentButton = byId('cancelSkiAssignment');
    const confirmAssignmentButton = byId('confirmSkiAssignment');

    if (!uploadButton || !fileInput || !modal || !assignmentModal) return;

    uploadButton.addEventListener('click', () => fileInput.click());
    chooseAgainButton?.addEventListener('click', () => fileInput.click());
    closeButton?.addEventListener('click', () => closePipelineModal());
    openDashboardButton?.addEventListener('click', () => closePipelineModal());
    modal.addEventListener('click', event => {
      if (event.target === modal && !modal.classList.contains('is-processing')) closePipelineModal();
    });

    fileInput.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      window.dismissStartupDataPrompt?.('upload');
      await requestSkiAssignment(file);
    });

    document.querySelectorAll('input[name="skiAssignmentMode"]').forEach(input => {
      input.addEventListener('change', () => setSkiAssignmentMode(input.value));
    });
    byId('uploadExistingSki')?.addEventListener('change', updateExistingSkiPreview);
    closeAssignmentButton?.addEventListener('click', cancelSkiAssignment);
    cancelAssignmentButton?.addEventListener('click', cancelSkiAssignment);
    confirmAssignmentButton?.addEventListener('click', confirmSkiAssignment);
    byId('pipelineTechnicalToggle')?.addEventListener('click', () => {
      const toggle = byId('pipelineTechnicalToggle');
      setTechnicalDetailsExpanded(toggle?.getAttribute('aria-expanded') !== 'true');
    });
    assignmentModal.addEventListener('click', event => {
      if (event.target === assignmentModal) cancelSkiAssignment();
    });

    byId('pipelineDownloadCsv')?.addEventListener('click', async () => {
      if (state.csvBlob) {
        downloadBlob(state.csvBlob, `${state.baseName}_all_runs_cleaned.csv`);
        return;
      }
      await generateMergedCsvOnDemand();
    });
    byId('pipelineDownloadGeojson')?.addEventListener('click', async () => {
      if (state.geojsonBlob) {
        downloadBlob(state.geojsonBlob, `${state.baseName}_ALL_runs.dashboard.geojson`);
        return;
      }
      await generateGeojsonOnDemand();
    });
    byId('pipelineDownloadReport')?.addEventListener('click', () => {
      if (state.reportBlob) downloadBlob(state.reportBlob, `${state.baseName}_cleaning_report.csv`);
    });
  }

  async function requestSkiAssignment(file) {
    if (!/\.zip$/i.test(file.name)) {
      showPipelineError('Please select a .zip archive containing the raw sensor CSV files.');
      return;
    }
    if (!window.JSZip) {
      showPipelineError('The ZIP processing library did not load. Check the internet connection and reload the dashboard.');
      return;
    }

    if (!window.SkiHistoryStore) {
      showPipelineError('The cumulative-history module did not load. Reload the dashboard and try again.');
      return;
    }

    try {
      const existing = typeof window.SkiHistoryStore.findDuplicateFile === 'function'
        ? await window.SkiHistoryStore.findDuplicateFile(file)
        : null;
      if (existing && Number(existing.pipelineVersion || 1) >= PIPELINE_VERSION) {
        const uploaded = existing.uploadedAt ? new Date(existing.uploadedAt).toLocaleString() : 'an earlier session';
        const message = `This ZIP is already stored as “${existing.archiveName || file.name}” from ${uploaded}. It was not processed again.`;
        if (typeof window.showToast === 'function') window.showToast(message);
        else alert(message);
        return;
      }
      if (existing) console.info('Reprocessing an older history record with the faster pipeline.');
      state.pendingHash = existing?.hash || (typeof window.SkiHistoryStore.fingerprint === 'function'
        ? await window.SkiHistoryStore.fingerprint(file)
        : await window.SkiHistoryStore.sha256(file));
    } catch (error) {
      showPipelineError(`The ZIP identity check failed: ${error?.message || error}`);
      return;
    }

    state.pendingFile = file;
    state.pendingAssignment = null;
    if (byId('skiAssignmentFileName')) byId('skiAssignmentFileName').textContent = file.name;
    if (byId('skiAssignmentError')) byId('skiAssignmentError').textContent = '';
    populateExistingSkiOptions();
    clearNewSkiFields();

    const models = getSavedSkiModels();
    setSkiAssignmentMode(models.length ? 'existing' : 'new');
    const modal = byId('skiAssignmentModal');
    if (modal) modal.style.display = 'flex';
  }

  function getSavedSkiModels() {
    return typeof window.getDashboardSkiModels === 'function'
      ? window.getDashboardSkiModels()
      : [];
  }

  function populateExistingSkiOptions() {
    const select = byId('uploadExistingSki');
    if (!select) return;
    const models = getSavedSkiModels();
    const selectedName = typeof window.getSelectedDashboardSki === 'function'
      ? window.getSelectedDashboardSki()
      : '';
    select.innerHTML = models.map(model => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`).join('');
    if (models.some(model => model.name === selectedName)) select.value = selectedName;
    updateExistingSkiPreview();
  }

  function updateExistingSkiPreview() {
    const selectedName = byId('uploadExistingSki')?.value;
    const model = getSavedSkiModels().find(item => item.name === selectedName);
    const preview = byId('uploadExistingSkiPreview');
    if (!preview) return;
    preview.innerHTML = model
      ? `<b>${escapeHtml(model.name)}</b>${escapeHtml(model.type)} · Radius ${escapeHtml(model.radius)} · Length ${escapeHtml(model.length)}<br>${Number(model.km || 0).toFixed(1).replace(/\.0$/, '')} km currently recorded since service.`
      : 'No saved ski models are available. Choose “Brand-new ski” to create one.';
  }

  function setSkiAssignmentMode(mode) {
    const normalized = mode === 'new' ? 'new' : 'existing';
    document.querySelectorAll('input[name="skiAssignmentMode"]').forEach(input => {
      input.checked = input.value === normalized;
      input.closest('.assignment-mode')?.classList.toggle('active', input.checked);
    });
    const existingFields = byId('existingSkiAssignmentFields');
    const newFields = byId('newSkiAssignmentFields');
    if (existingFields) existingFields.hidden = normalized !== 'existing';
    if (newFields) newFields.hidden = normalized !== 'new';
    if (byId('skiAssignmentError')) byId('skiAssignmentError').textContent = '';
    if (normalized === 'new') setTimeout(() => byId('uploadNewSkiName')?.focus(), 0);
  }

  function clearNewSkiFields() {
    ['uploadNewSkiName', 'uploadNewSkiType', 'uploadNewSkiLength', 'uploadNewSkiRadius'].forEach(id => {
      if (byId(id)) byId(id).value = '';
    });
  }

  function cancelSkiAssignment() {
    const modal = byId('skiAssignmentModal');
    if (modal) modal.style.display = 'none';
    state.pendingFile = null;
    state.pendingAssignment = null;
    state.pendingHash = null;
  }

  async function confirmSkiAssignment() {
    const file = state.pendingFile;
    if (!file) return;
    const errorElement = byId('skiAssignmentError');
    if (errorElement) errorElement.textContent = '';
    const mode = document.querySelector('input[name="skiAssignmentMode"]:checked')?.value || 'existing';

    try {
      let ski;
      if (mode === 'new') {
        const name = byId('uploadNewSkiName')?.value.trim() || '';
        if (!name) {
          byId('uploadNewSkiName')?.focus();
          throw new Error('Enter a name for the new ski model.');
        }
        if (typeof window.createDashboardSki !== 'function') throw new Error('The ski-model manager is unavailable. Reload the dashboard and try again.');
        ski = window.createDashboardSki({
          name,
          type: byId('uploadNewSkiType')?.value.trim() || 'All-round',
          length: byId('uploadNewSkiLength')?.value || '170',
          radius: byId('uploadNewSkiRadius')?.value || '14.0',
          km: 0
        }, {select:true, render:true, source:'raw-upload-new-ski'});
      } else {
        const selectedName = byId('uploadExistingSki')?.value;
        if (!selectedName) throw new Error('Select one of the saved ski models.');
        if (typeof window.selectDashboardSki !== 'function') throw new Error('The ski-model manager is unavailable. Reload the dashboard and try again.');
        ski = window.selectDashboardSki(selectedName, {render:true, source:'raw-upload-existing-ski'});
      }

      const assignment = {skiName: ski.name, isNew: mode === 'new'};
      if(typeof window.captureServiceBaselineBeforeUpload === 'function'){
        await window.captureServiceBaselineBeforeUpload(ski.name);
      }
      state.pendingAssignment = assignment;
      const modal = byId('skiAssignmentModal');
      if (modal) modal.style.display = 'none';
      await processSelectedZip(file, assignment);
      state.pendingFile = null;
      state.pendingHash = null;
    } catch (error) {
      if (errorElement) errorElement.textContent = error?.message || 'The ski information could not be saved.';
    }
  }

  async function processSelectedZip(file, assignment = {}) {
    if (!/\.zip$/i.test(file.name)) {
      showPipelineError('Please select a .zip archive containing the raw sensor CSV files.');
      return;
    }
    if (!window.JSZip) {
      showPipelineError('The ZIP processing library did not load. Check the internet connection and reload the dashboard.');
      return;
    }

    openPipelineModal();
    setProcessingState(true);
    resetPipelineResults(file.name, assignment.skiName || '');
    state.baseName = safeBaseName(file.name.replace(/\.zip$/i, '')) || 'ski_sensor_data';

    try {
      state.sourceFile = file;
      state.sourceAssignment = {...assignment};
      const result = await processSensorZip(file, updatePipelineProgress, {
        selectedSki: assignment.skiName || '',
        includeFullCsv: false,
        includeFullGeojson: false
      });
      state.csvBlob = result.csvBlob;
      state.geojsonBlob = result.geojsonBlob;
      state.reportBlob = result.reportBlob;
      state.lastDashboardPoints = result.dashboardPoints;
      state.lastGeojsonProperties = result.geojsonProperties;

      updatePipelineProgress(96, 'Saving the optimized dashboard data to cumulative history…');
      const archiveHash = state.pendingHash || (typeof window.SkiHistoryStore.fingerprint === 'function'
        ? await window.SkiHistoryStore.fingerprint(file)
        : await window.SkiHistoryStore.sha256(file));
      const duplicate = await window.SkiHistoryStore.has(archiveHash);
      if (duplicate && Number(duplicate.pipelineVersion || 1) >= PIPELINE_VERSION) {
        throw new Error('This identical ZIP was already stored while processing. No duplicate data were added.');
      }
      const historyRecord = await window.SkiHistoryStore.buildRecord({
        hash: archiveHash, file, result, skiName: assignment.skiName || result.summary.selectedSkiModel || ''
      });
      await window.SkiHistoryStore.put(historyRecord);
      result.summary.archiveHash = archiveHash;
      result.summary.season = historyRecord.season;
      result.summary.historyUploadId = historyRecord.uploadId;

      populatePipelineResults(result.summary, result.report);

      if (typeof window.refreshDashboardFromHistory === 'function') {
        await window.refreshDashboardFromHistory({newUploadHash: archiveHash});
      } else if (typeof window.applyProcessedDashboardData === 'function') {
        window.applyProcessedDashboardData(historyRecord.points, result.summary);
      }

      updatePipelineProgress(100, `Dashboard ready: ${result.summary.filesProcessed} run file(s) assigned to ${result.summary.selectedSkiModel || 'the selected ski'}. Service-partner lookup continues separately.`);
      setProcessingState(false, true);

      if (typeof window.retrieveServicePartnersForAoi === 'function') {
        void window.retrieveServicePartnersForAoi(
          result.summary.aoi,
          result.dashboardPoints,
          {archiveName: result.summary.archiveName}
        ).then(partnerLookup => {
          result.summary.servicePartnersFound = partnerLookup?.partners?.length || 0;
          result.summary.servicePartnerSearchBufferKm = partnerLookup?.bufferKm || null;
          result.summary.servicePartnerLookupError = partnerLookup?.error || '';
          populatePipelineResults(result.summary, result.report);
        }).catch(error => console.warn('Background service-partner lookup failed:', error));
      }
    } catch (error) {
      console.error('ZIP data processing failed:', error);
      showPipelineError(error?.message || 'The ZIP could not be processed.');
      setProcessingState(false, false);
    }
  }

  async function processSensorZip(file, onProgress, context = {}) {
    const selectedSkiModel = String(context.selectedSki || '').trim();
    const includeFullCsv = context.includeFullCsv === true;
    const includeFullGeojson = context.includeFullGeojson === true;
    onProgress(2, `Opening ZIP archive${selectedSkiModel ? ` for ${selectedSkiModel}` : ''}…`);
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(entry => !entry.dir && !isIgnoredArchiveEntry(entry.name));

    const spreadsheetEntry = entries.find(entry =>
      /(?:timestamps|field.?measurements).*\.xlsx$/i.test(entry.name) ||
      /TimeStamps_FieldMeasurements\.xlsx$/i.test(entry.name)
    );

    let fieldMeasurements = [];
    if (spreadsheetEntry) {
      onProgress(7, 'Reading edge-condition timestamps…');
      try {
        const workbookBuffer = await spreadsheetEntry.async('arraybuffer');
        fieldMeasurements = window.XLSX
          ? parseFieldMeasurements(workbookBuffer)
          : await parseFieldMeasurementsFromXlsxZip(workbookBuffer);
      } catch (error) {
        console.warn('Could not parse field measurement workbook:', error);
      }
    }

    const analyticsEntries = entries.filter(entry => isSupportedAnalyticsEntry(entry.name));
    const acquisitionAnalytics = await loadAcquisitionAnalytics(analyticsEntries, onProgress);
    const matchedAnalyticsIds = new Set();

    const csvEntries = entries.filter(entry => /\.csv$/i.test(entry.name));
    if (!csvEntries.length) {
      throw new Error('No CSV files were found inside the ZIP archive.');
    }

    const csvParts = includeFullCsv ? [`${OUTPUT_COLUMNS.map(csvEscape).join(',')}\n`] : null;
    const mergedFeatures = includeFullGeojson ? [] : null;
    const dashboardPoints = [];
    const report = [];

    let filesProcessed = 0;
    let rowsBefore = 0;
    let rowsAfter = 0;
    let duplicatesRemoved = 0;
    let invalidGpsRows = 0;
    let truncatedValues = 0;
    let totalDistanceKm = 0;
    let mergedAoiBounds = null;
    const optimizationDiagnostics = [];

    for (let index = 0; index < csvEntries.length; index += 1) {
      const entry = csvEntries[index];
      const progressStart = 10 + Math.round((index / csvEntries.length) * 78);
      onProgress(progressStart, `Reading ${shortName(entry.name)}…`);

      const text = await entry.async('string');
      let cleaned;
      try {
        cleaned = cleanSensorText(text, entry.name, fieldMeasurements, filesProcessed + 1, selectedSkiModel, {
          includeCsv: includeFullCsv,
          includeGeojson: includeFullGeojson
        });
      } catch (error) {
        if (!/No sensor table header/.test(String(error?.message || error))) throw error;
        report.push({
          file: entry.name,
          status: 'skipped',
          rows_before: 0,
          rows_after: 0,
          duplicates_removed: 0,
          dashboard_points: 0,
          run: '',
          edge_condition: '',
          ski_model: selectedSkiModel,
          note: "No header beginning with 'Time;Lat;Lon'"
        });
        await yieldToBrowser();
        continue;
      }
      const analyticsMatch = matchAcquisitionAnalytics(cleaned, acquisitionAnalytics, matchedAnalyticsIds);
      if (analyticsMatch) {
        applyAcquisitionAnalytics(cleaned, analyticsMatch);
        matchedAnalyticsIds.add(analyticsMatch.id);
        cleaned.reportRow.analytics_file = analyticsMatch.sourceFile;
        cleaned.reportRow.analytics_status = 'matched';
      } else {
        cleaned.reportRow.analytics_file = '';
        cleaned.reportRow.analytics_status = acquisitionAnalytics.length ? 'not matched' : 'not supplied';
      }
      filesProcessed += 1;
      rowsBefore += cleaned.stats.rowsBefore;
      rowsAfter += cleaned.stats.rowsAfter;
      duplicatesRemoved += cleaned.stats.duplicatesRemoved;
      invalidGpsRows += cleaned.stats.invalidGpsRows;
      truncatedValues += cleaned.stats.truncatedValues;
      totalDistanceKm += cleaned.stats.routeDistanceKm;
      mergedAoiBounds = mergeAoiBounds(mergedAoiBounds, cleaned.stats.aoi);
      optimizationDiagnostics.push(cleaned.optimization);

      if (includeFullCsv && csvParts) csvParts.push(cleaned.csvText.join(''));
      if (includeFullGeojson && mergedFeatures) mergedFeatures.push(...cleaned.features);
      dashboardPoints.push(...cleaned.dashboardPoints);
      report.push(cleaned.reportRow);

      const progressEnd = 10 + Math.round(((index + 1) / csvEntries.length) * 78);
      onProgress(progressEnd, `Cleaned ${shortName(entry.name)} · ${cleaned.stats.rowsAfter.toLocaleString()} rows`);
      await yieldToBrowser();
    }

    if (!filesProcessed) {
      throw new Error("CSV files were found, but none contained the expected raw sensor header 'Time;Lat;Lon'.");
    }
    if (!dashboardPoints.length) {
      throw new Error('The files were cleaned, but no valid latitude/longitude records were available for the dashboard.');
    }

    const matchedAcquisitionAnalytics = acquisitionAnalytics.filter(item => matchedAnalyticsIds.has(item.id));
    const analyticsSummary = summarizeAcquisitionAnalytics(matchedAcquisitionAnalytics);
    const aoi = finalizeAoiBounds(mergedAoiBounds);
    onProgress(91, 'Finalizing optimized dashboard data…');
    const geojsonProperties = {
        generated_at: new Date().toISOString(),
        files_processed: filesProcessed,
        rows_before_cleaning: rowsBefore,
        rows_after_cleaning: rowsAfter,
        point_count_exported: dashboardPoints.length,
        total_route_distance_km: roundNumber(totalDistanceKm, 3),
        acquisition_analytics: analyticsSummary,
        analytics_files_found: analyticsEntries.length,
        analytics_files_matched: matchedAcquisitionAnalytics.length,
        aoi,
        selected_ski_model: selectedSkiModel || null,
        export_type: 'dashboard_optimized',
        optimization_method: OPTIMIZATION_CONFIG.method,
        fidelity_target_percent: OPTIMIZATION_CONFIG.fidelityTargetPercent,
        robust_z_threshold: OPTIMIZATION_CONFIG.robustZThreshold,
        minimum_points_per_run: OPTIMIZATION_CONFIG.minPoints,
        maximum_points_per_run: OPTIMIZATION_CONFIG.maxPoints,
        run_optimization: optimizationDiagnostics.map(item => ({
          run: item.run,
          source_file: item.sourceFile,
          cleaned_rows: item.originalCount,
          exported_points: item.exportedCount,
          adaptive_budget: item.adaptiveBudget,
          events_preserved: item.eventsPreserved,
          distance_error_percent: item.distanceErrorPercent,
          statistical_error_percent: item.statisticalErrorPercent,
          fidelity_error_percent: item.fidelityErrorPercent,
          quality_grade: item.qualityGrade
        }))
    };
    const geojsonBlob = includeFullGeojson && mergedFeatures
      ? buildGeojsonBlob(dashboardPoints, geojsonProperties)
      : null;

    const reportCsv = buildReportCsv(report);
    const csvBlob = includeFullCsv && csvParts
      ? new Blob(csvParts, {type: 'text/csv;charset=utf-8'})
      : null;
    const reportBlob = new Blob([reportCsv], {type: 'text/csv;charset=utf-8'});

    const summary = {
      archiveName: file.name,
      selectedSkiModel,
      filesFound: csvEntries.length,
      filesProcessed,
      filesSkipped: csvEntries.length - filesProcessed,
      rowsBefore,
      rowsAfter,
      duplicatesRemoved,
      invalidGpsRows,
      truncatedValues,
      dashboardPoints: dashboardPoints.length,
      totalDistanceKm: roundNumber(totalDistanceKm, 3),
      aoi,
      reductionPercent: rowsAfter ? Math.max(0, 100 * (1 - dashboardPoints.length / rowsAfter)) : 0,
      edgeConditionRecords: fieldMeasurements.length,
      csvBytes: csvBlob?.size || 0,
      csvDeferred: !includeFullCsv,
      geojsonBytes: geojsonBlob?.size || 0,
      geojsonDeferred: !includeFullGeojson,
      optimizationMethod: OPTIMIZATION_CONFIG.method,
      eventsPreserved: optimizationDiagnostics.reduce((sum, item) => sum + item.eventsPreserved, 0),
      robustOutliers: optimizationDiagnostics.reduce((sum, item) => sum + item.robustOutliers, 0),
      turnEvents: optimizationDiagnostics.reduce((sum, item) => sum + item.turnEvents, 0),
      gpsJumpFlags: optimizationDiagnostics.reduce((sum, item) => sum + item.gpsJumpFlags, 0),
      worstDistanceErrorPercent: maximumFinite(optimizationDiagnostics.map(item => item.distanceErrorPercent)),
      worstStatisticalErrorPercent: maximumFinite(optimizationDiagnostics.map(item => item.statisticalErrorPercent)),
      worstFidelityErrorPercent: maximumFinite(optimizationDiagnostics.map(item => item.fidelityErrorPercent)),
      optimizationQuality: qualityGrade(maximumFinite(optimizationDiagnostics.map(item => item.fidelityErrorPercent))),
      runsAboveFidelityTarget: optimizationDiagnostics.filter(item => !item.targetMet).length,
      pipelineVersion: PIPELINE_VERSION,
      analyticsFilesFound: analyticsEntries.length,
      analyticsFilesParsed: acquisitionAnalytics.length,
      analyticsFilesMatched: matchedAcquisitionAnalytics.length,
      analyticsCoveragePercent: filesProcessed ? roundNumber(100 * matchedAcquisitionAnalytics.length / filesProcessed, 1) : 0,
      analyticsDistanceKm: analyticsSummary.distanceKm,
      analyticsSkiingTimeSeconds: analyticsSummary.skiingTimeSeconds,
      analyticsAverageSpeedKmh: analyticsSummary.averageSpeedKmh,
      analyticsMaximumSpeedKmh: analyticsSummary.maximumSpeedKmh,
      analyticsEffectiveEdgingDegrees: analyticsSummary.effectiveEdgingDegrees,
      analyticsCarvingScore: analyticsSummary.carvingScore,
      analyticsMaximumGForce: analyticsSummary.maximumGForce,
      analyticsTurnCount: analyticsSummary.turnCount,
      analyticsCarvedTurns: analyticsSummary.carvedTurns,
      acquisitionAnalytics: matchedAcquisitionAnalytics
    };

    onProgress(97, 'Refreshing dashboard KPIs and maps…');
    return {csvBlob, geojsonBlob, reportBlob, dashboardPoints, geojsonProperties, acquisitionAnalytics: matchedAcquisitionAnalytics, summary, report};
  }

  async function generateGeojsonOnDemand() {
    if (state.geojsonGenerating || !Array.isArray(state.lastDashboardPoints) || !state.lastGeojsonProperties) return;
    state.geojsonGenerating = true;
    const button = byId('pipelineDownloadGeojson');
    if (button) button.textContent = 'Generating GeoJSON…';
    try {
      await yieldToBrowser();
      state.geojsonBlob = buildGeojsonBlob(state.lastDashboardPoints, state.lastGeojsonProperties);
      if (button) button.textContent = 'Download merged GeoJSON';
      downloadBlob(state.geojsonBlob, `${state.baseName}_ALL_runs.dashboard.geojson`);
    } catch (error) {
      showPipelineError(error?.message || 'The optimized GeoJSON could not be generated.');
    } finally {
      state.geojsonGenerating = false;
      setProcessingState(false, true);
    }
  }

  function buildGeojsonBlob(dashboardPoints, properties = {}) {
    const geojson = {
      type: 'FeatureCollection',
      properties,
      features: (dashboardPoints || []).map(dashboardPointToFeature)
    };
    return new Blob([JSON.stringify(geojson)], {type: 'application/geo+json;charset=utf-8'});
  }

  function dashboardPointToFeature(point) {
    const properties = {...point};
    const lon = Number(properties.lon);
    const lat = Number(properties.lat);
    delete properties.lon;
    delete properties.lat;
    delete properties.upload_id;
    delete properties.archive_name;
    return {
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [lon, lat]},
      properties
    };
  }

  async function generateMergedCsvOnDemand() {
    if (state.csvGenerating || !state.sourceFile) return;
    state.csvGenerating = true;
    openPipelineModal();
    setProcessingState(true);
    const button = byId('pipelineDownloadCsv');
    if (button) button.textContent = 'Generating CSV…';
    try {
      const skiName = state.sourceAssignment?.skiName || '';
      const blob = await buildMergedCleanedCsv(state.sourceFile, updatePipelineProgress, skiName);
      state.csvBlob = blob;
      if (button) button.textContent = 'Download merged CSV';
      updatePipelineProgress(100, 'Cleaned CSV generated. Download starting…');
      setProcessingState(false, true);
      downloadBlob(blob, `${state.baseName}_all_runs_cleaned.csv`);
    } catch (error) {
      showPipelineError(error?.message || 'The cleaned CSV could not be generated.');
      setProcessingState(false, false);
      if (button) button.textContent = 'Generate cleaned CSV';
    } finally {
      state.csvGenerating = false;
    }
  }

  async function buildMergedCleanedCsv(file, onProgress, selectedSkiModel = '') {
    onProgress(2, 'Opening ZIP for on-demand cleaned CSV export…');
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(entry => !entry.dir && !isIgnoredArchiveEntry(entry.name));
    const spreadsheetEntry = entries.find(entry =>
      /(?:timestamps|field.?measurements).*\.xlsx$/i.test(entry.name) ||
      /TimeStamps_FieldMeasurements\.xlsx$/i.test(entry.name)
    );
    let fieldMeasurements = [];
    if (spreadsheetEntry) {
      try {
        const workbookBuffer = await spreadsheetEntry.async('arraybuffer');
        fieldMeasurements = window.XLSX
          ? parseFieldMeasurements(workbookBuffer)
          : await parseFieldMeasurementsFromXlsxZip(workbookBuffer);
      } catch (error) {
        console.warn('Could not parse field measurement workbook for CSV export:', error);
      }
    }
    const csvEntries = entries.filter(entry => /\.csv$/i.test(entry.name));
    if (!csvEntries.length) throw new Error('No CSV files were found inside the ZIP archive.');
    const parts = [`${OUTPUT_COLUMNS.map(csvEscape).join(',')}\n`];
    let processed = 0;
    for (let index = 0; index < csvEntries.length; index += 1) {
      const entry = csvEntries[index];
      onProgress(5 + Math.round(index / csvEntries.length * 90), `Generating cleaned CSV: ${shortName(entry.name)}…`);
      const text = await entry.async('string');
      try {
        const exported = cleanSensorTextForCsv(text, entry.name, fieldMeasurements, processed + 1, selectedSkiModel);
        parts.push(exported.csvText.join(''));
        processed += 1;
      } catch (error) {
        if (!/No sensor table header/.test(String(error?.message || error))) throw error;
      }
      await yieldToBrowser();
    }
    if (!processed) throw new Error('No compatible raw sensor CSV tables were found.');
    return new Blob(parts, {type: 'text/csv;charset=utf-8'});
  }

  function cleanSensorTextForCsv(text, sourceName, fieldMeasurements, fallbackRun, selectedSkiModel = '') {
    const lines = text.split(/\r?\n/);
    const headerIndex = lines.findIndex(line => line.replace(/^\uFEFF/, '').trimStart().startsWith('Time;Lat;Lon'));
    if (headerIndex < 0) throw new Error(`No sensor table header found in ${sourceName}`);
    const runInfo = parseRunInfoFromFilename(sourceName, fallbackRun);
    const edgeCondition = resolveEdgeCondition(runInfo.runStartMs, fieldMeasurements);
    const seen = new Set();
    const csvText = [];
    for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line || !line.trim()) continue;
      const rawCells = line.split(';').map(stripTrailingCommaArtifacts);
      if (!rawCells.some(value => value !== '')) continue;
      const duplicateKey = rawCells.slice(0, STABLE_COLUMNS.length).join('\u001F');
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const values = new Array(STABLE_COLUMNS.length);
      for (let columnIndex = 0; columnIndex < STABLE_COLUMNS.length; columnIndex += 1) {
        const column = STABLE_COLUMNS[columnIndex];
        const rawValue = rawCells[columnIndex] ?? '';
        values[columnIndex] = DATETIME_COLUMNS.has(column)
          ? normalizeTimestamp(rawValue)
          : parseNumeric(rawValue);
      }
      csvText.push(`${[...values, runInfo.runNumber, edgeCondition, shortName(sourceName), selectedSkiModel].map(csvEscape).join(',')}\n`);
    }
    return {csvText};
  }

  function isIgnoredArchiveEntry(path = '') {
    const normalized = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = normalized.split('/').filter(Boolean);
    const baseName = parts.at(-1) || '';

    return parts.includes('__MACOSX')
      || parts.some(part => part.startsWith('._'))
      || baseName === '.DS_Store'
      || baseName === 'Thumbs.db';
  }

  function isSupportedAnalyticsEntry(path = '') {
    if (isIgnoredArchiveEntry(path)) return false;
    const baseName = String(path).replace(/\\/g, '/').split('/').pop() || '';
    return /(?:_runDetails|_dayStats)\.json$/i.test(baseName);
  }

async function loadAcquisitionAnalytics(entries, onProgress) {
    const analytics = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || !isSupportedAnalyticsEntry(entry.name)) continue;
      try {
        const text = await entry.async('string');
        const payload = JSON.parse(text);
        if (!isAcquisitionAnalytics(payload)) continue;
        analytics.push(normalizeAcquisitionAnalytics(payload, shortName(entry.name), analytics.length + 1));
      } catch (error) {
        console.warn(`Skipping unreadable analytics JSON ${entry.name}:`, error);
      }
      if (typeof onProgress === 'function' && entries.length) {
        onProgress(8, `Read ${analytics.length} acquisition analytics JSON file(s)…`);
      }
      await yieldToBrowser();
    }
    return analytics;
  }

  function isAcquisitionAnalytics(payload) {
    return Boolean(payload && typeof payload === 'object' && Array.isArray(payload.turns)
      && [payload.distance, payload.skiingTime, payload.carvingScore, payload.effectiveEdging]
        .some(value => Number.isFinite(Number(value))));
  }

  function normalizeAcquisitionAnalytics(payload, sourceFile, fallbackIndex) {
    const location = Array.isArray(payload.location) && payload.location.length >= 2
      ? {lon: Number(payload.location[0]), lat: Number(payload.location[1])}
      : null;
    const startMs = appleReferenceSecondsToUnixMs(payload.startTime ?? payload.recordingStartTime);
    const turns = (payload.turns || []).map((turn, index) => normalizeAnalyticsTurn(turn, index)).filter(Boolean);
    const techniqueCounts = turns.reduce((counts, turn) => {
      counts[turn.technique] = (counts[turn.technique] || 0) + 1;
      return counts;
    }, {});
    const idBase = `${sourceFile}:${Number.isFinite(startMs) ? Math.round(startMs) : fallbackIndex}`;
    return {
      id: idBase,
      sourceFile,
      location: location && isValidCoordinate(location.lat, location.lon) ? location : null,
      startMs,
      endMs: appleReferenceSecondsToUnixMs(payload.endTime),
      distanceKm: finiteOrNull(Number(payload.distance) / 1000),
      skiingTimeSeconds: finiteOrNull(payload.skiingTime),
      stopsTimeSeconds: finiteOrNull(payload.stopsTime),
      averageSpeedKmh: finiteOrNull(Number(payload.avgSpeed) * 3.6),
      maximumSpeedKmh: finiteOrNull(Number(payload.maxSpeed) * 3.6),
      effectiveEdgingDegrees: finiteOrNull(Math.abs(Number(payload.effectiveEdging))),
      carvingScore: finiteOrNull(payload.carvingScore),
      maximumGForce: finiteOrNull(payload.maxGForce),
      averageGForce: finiteOrNull(payload.gForce),
      carvedTurns: finiteOrNull(payload.carvedTurns),
      turnCount: turns.length,
      techniqueCounts,
      averageTurnSizeMeters: finiteOrNull(payload.turnSize),
      skiParallelAngleDegrees: finiteOrNull(payload.skiParallelAngle),
      verticalMeters: finiteOrNull(payload.vertical),
      resortName: String(payload.resortName || '').trim(),
      locationName: String(payload.locationName || '').trim(),
      slopeDistribution: normalizeSlopeDistribution(payload.slopeDistribution),
      turns
    };
  }

  function normalizeAnalyticsTurn(turn, fallbackIndex) {
    if (!turn || typeof turn !== 'object') return null;
    const props = turn.turnProps || {};
    const startMs = unixSecondsToMs(props.startTimestamp);
    const endMs = unixSecondsToMs(props.endTimestamp);
    return {
      index: Number.isFinite(Number(props.turnIndex)) ? Number(props.turnIndex) : fallbackIndex,
      sequenceId: finiteOrNull(props.turnSequenceId),
      startMs,
      endMs,
      side: String(props.side || '').toLowerCase(),
      isProper: Boolean(props.isProper),
      rawType: String(turn.turnType || '').trim(),
      technique: normalizeTurnType(turn.turnType),
      speedKmh: finiteOrNull(Number(turn.speed) * 3.6),
      gForce: finiteOrNull(turn.gForce),
      turnSizeMeters: finiteOrNull(turn.turnSize),
      carvingScore: finiteOrNull(turn.carvingScore),
      steepness: finiteOrNull(turn.steepness),
      slopeClass: slopeClassFromSteepness(turn.steepness),
      effectiveEdgingDegrees: deriveTurnEdgingAngle(turn.edging),
      averageParallelAngleDegrees: finiteOrNull(turn.edging?.avgParallelAngle)
    };
  }

  function normalizeTurnType(value) {
    const key = String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
    if (key === 'carved' || key === 'carving') return 'Carving';
    if (key === 'drifted') return 'Drifted turns';
    if (key === 'snowplowsteered') return 'Snowplow steered';
    if (key === 'parallel' || key === 'parallelturns') return 'Parallel turns';
    if (!key) return 'Gliding';
    return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase());
  }

  function deriveTurnEdgingAngle(edging) {
    const values = [];
    for (const side of ['left', 'right']) {
      const sideData = edging?.[side];
      if (!sideData) continue;
      for (const phase of ['begin', 'middle', 'end']) {
        const angle = Math.abs(Number(sideData?.[phase]?.maxEdgingAngle));
        if (Number.isFinite(angle)) values.push(angle);
      }
    }
    return values.length ? roundNumber(Math.max(...values), 2) : null;
  }

  function normalizeSlopeDistribution(value) {
    const result = {easy: 0, intermediate: 0, expert: 0};
    for (const key of Object.keys(result)) {
      const number = Number(value?.[key]);
      result[key] = Number.isFinite(number) ? number : 0;
    }
    return result;
  }

  function slopeClassFromSteepness(value) {
    const steepness = Math.abs(Number(value));
    if (!Number.isFinite(steepness)) return null;
    if (steepness >= 0.25) return 'expert';
    if (steepness >= 0.15) return 'intermediate';
    return 'easy';
  }

  function dominantSlopeClass(distribution) {
    return Object.entries(normalizeSlopeDistribution(distribution)).sort((a, b) => b[1] - a[1])[0]?.[0] || 'easy';
  }

  function appleReferenceSecondsToUnixMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? (number + APPLE_REFERENCE_EPOCH_SECONDS) * 1000 : null;
  }

  function unixSecondsToMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number * 1000 : null;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function matchAcquisitionAnalytics(cleaned, analytics, usedIds) {
    if (!cleaned?.stats || !analytics?.length) return null;
    const candidates = analytics.filter(item => !usedIds.has(item.id)).map(item => {
      const locationDistanceKm = item.location && cleaned.stats.firstPoint
        ? haversineMeters(item.location, cleaned.stats.firstPoint) / 1000
        : null;
      const distanceError = Number.isFinite(item.distanceKm) && item.distanceKm > 0
        ? Math.abs(item.distanceKm - cleaned.stats.routeDistanceKm) / item.distanceKm
        : null;
      const timeAdjustmentMs = Number.isFinite(item.startMs) && Number.isFinite(cleaned.stats.startTimeMs)
        ? bestTimezoneAdjustment(cleaned.stats.startTimeMs, item.startMs)
        : 0;
      const clockErrorMinutes = Number.isFinite(item.startMs) && Number.isFinite(cleaned.stats.startTimeMs)
        ? Math.abs(cleaned.stats.startTimeMs + timeAdjustmentMs - item.startMs) / 60000
        : null;
      const score = (Number.isFinite(locationDistanceKm) ? Math.min(locationDistanceKm, 50) * 2.5 : 8)
        + (Number.isFinite(distanceError) ? Math.min(distanceError, 2) * 8 : 4)
        + (Number.isFinite(clockErrorMinutes) ? Math.min(clockErrorMinutes, 180) / 15 : 4);
      return {item, score, locationDistanceKm, distanceError, clockErrorMinutes, timeAdjustmentMs};
    }).sort((a, b) => a.score - b.score);

    const best = candidates[0];
    if (!best) return null;
    const locationAcceptable = !Number.isFinite(best.locationDistanceKm) || best.locationDistanceKm <= 2;
    const distanceAcceptable = !Number.isFinite(best.distanceError) || best.distanceError <= 0.45;
    const timeAcceptable = !Number.isFinite(best.clockErrorMinutes) || best.clockErrorMinutes <= 20;
    return locationAcceptable && distanceAcceptable && timeAcceptable
      ? {...best.item, pointTimeOffsetMs: best.timeAdjustmentMs}
      : null;
  }

  function bestTimezoneAdjustment(firstMs, secondMs) {
    let bestOffset = 0;
    let minimum = Math.abs(firstMs - secondMs);
    for (let offsetHours = -14; offsetHours <= 14; offsetHours += 1) {
      const offset = offsetHours * 3600000;
      const difference = Math.abs(firstMs + offset - secondMs);
      if (difference < minimum) {
        minimum = difference;
        bestOffset = offset;
      }
    }
    return bestOffset;
  }

  function applyAcquisitionAnalytics(cleaned, analytics) {
    const dashboardPointCount = cleaned.dashboardPoints.length;
    const dominantSlope = dominantSlopeClass(analytics.slopeDistribution);
    const shared = {
      analytics_id: analytics.id,
      analytics_file: analytics.sourceFile,
      analytics_dashboard_point_count: dashboardPointCount,
      analytics_distance_km: analytics.distanceKm,
      analytics_skiing_time_s: analytics.skiingTimeSeconds,
      analytics_stops_time_s: analytics.stopsTimeSeconds,
      analytics_avg_speed_kmh: analytics.averageSpeedKmh,
      analytics_max_speed_kmh: analytics.maximumSpeedKmh,
      analytics_effective_edging_deg: analytics.effectiveEdgingDegrees,
      analytics_carving_score: analytics.carvingScore,
      analytics_max_g_force: analytics.maximumGForce,
      analytics_avg_g_force: analytics.averageGForce,
      analytics_carved_turns: analytics.carvedTurns,
      analytics_turn_count: analytics.turnCount,
      analytics_carving_turns: Number(analytics.techniqueCounts?.Carving) || 0,
      analytics_drifted_turns: Number(analytics.techniqueCounts?.['Drifted turns']) || 0,
      analytics_snowplow_turns: Number(analytics.techniqueCounts?.['Snowplow steered']) || 0,
      analytics_parallel_turns: Number(analytics.techniqueCounts?.['Parallel turns']) || 0,
      analytics_gliding_segments: Number(analytics.techniqueCounts?.Gliding) || 0,
      analytics_vertical_m: analytics.verticalMeters,
      analytics_ski_parallel_angle_deg: analytics.skiParallelAngleDegrees,
      analytics_resort_name: analytics.resortName,
      analytics_location_name: analytics.locationName,
      analytics_slope_easy: analytics.slopeDistribution.easy,
      analytics_slope_intermediate: analytics.slopeDistribution.intermediate,
      analytics_slope_expert: analytics.slopeDistribution.expert
    };

    cleaned.dashboardPoints.forEach(point => {
      Object.assign(point, shared);
      const rawTimestamp = timestampToMilliseconds(point.phone_time);
      const timestamp = Number.isFinite(rawTimestamp) ? rawTimestamp + (Number(analytics.pointTimeOffsetMs) || 0) : rawTimestamp;
      const turn = analytics.turns.find(item => Number.isFinite(timestamp)
        && Number.isFinite(item.startMs) && Number.isFinite(item.endMs)
        && timestamp >= item.startMs && timestamp <= item.endMs);
      if (turn) {
        Object.assign(point, {
          analytics_technique: turn.technique,
          turn_index: turn.index,
          turn_side: turn.side,
          turn_is_proper: turn.isProper,
          turn_carving_score: turn.carvingScore,
          turn_speed_kmh: turn.speedKmh,
          turn_g_force: turn.gForce,
          turn_size_m: turn.turnSizeMeters,
          turn_steepness: turn.steepness,
          slope_class: turn.slopeClass || dominantSlope,
          effective_edging_angle: turn.effectiveEdgingDegrees || analytics.effectiveEdgingDegrees
        });
      } else {
        point.analytics_technique = 'Gliding';
        point.slope_class = dominantSlope;
        point.effective_edging_angle = analytics.effectiveEdgingDegrees;
      }
    });

    cleaned.features.forEach((feature, index) => {
      const point = cleaned.dashboardPoints[index];
      if (!point) return;
      Object.assign(feature.properties, Object.fromEntries(
        Object.entries(point).filter(([key]) => key !== 'lat' && key !== 'lon')
      ));
    });
  }

  function summarizeAcquisitionAnalytics(items) {
    const safeItems = Array.isArray(items) ? items : [];
    const skiingTimeSeconds = safeItems.reduce((sum, item) => sum + (Number(item.skiingTimeSeconds) || 0), 0);
    const turnWeight = safeItems.reduce((sum, item) => sum + Math.max(1, Number(item.turnCount) || 0), 0);
    const weighted = (field, fallbackWeight = 'skiingTimeSeconds') => {
      let numerator = 0, denominator = 0;
      safeItems.forEach(item => {
        const value = Number(item[field]);
        const weight = Math.max(0, Number(item[fallbackWeight]) || 0) || 1;
        if (Number.isFinite(value)) { numerator += value * weight; denominator += weight; }
      });
      return denominator ? roundNumber(numerator / denominator, 3) : null;
    };
    return {
      acquisitions: safeItems.length,
      distanceKm: roundNumber(safeItems.reduce((sum, item) => sum + (Number(item.distanceKm) || 0), 0), 3),
      skiingTimeSeconds: roundNumber(skiingTimeSeconds, 3),
      averageSpeedKmh: weighted('averageSpeedKmh'),
      maximumSpeedKmh: maximumFinite(safeItems.map(item => item.maximumSpeedKmh)),
      effectiveEdgingDegrees: weighted('effectiveEdgingDegrees'),
      carvingScore: weighted('carvingScore', 'turnCount'),
      maximumGForce: maximumFinite(safeItems.map(item => item.maximumGForce)),
      turnCount: safeItems.reduce((sum, item) => sum + (Number(item.turnCount) || 0), 0),
      carvedTurns: safeItems.reduce((sum, item) => sum + (Number(item.carvedTurns) || 0), 0),
      verticalMeters: roundNumber(safeItems.reduce((sum, item) => sum + (Number(item.verticalMeters) || 0), 0), 2),
      turnWeight
    };
  }

  function findSensorHeaderIndex(text) {
    const lines = text.split(/\r?\n/);
    return lines.findIndex(line => line.replace(/^\uFEFF/, '').trimStart().startsWith('Time;Lat;Lon'));
  }

  function cleanSensorText(text, sourceName, fieldMeasurements, fallbackRun, selectedSkiModel = '', options = {}) {
    const includeCsv = options.includeCsv === true;
    const includeGeojson = options.includeGeojson === true;
    const lines = text.split(/\r?\n/);
    const headerIndex = lines.findIndex(line => line.replace(/^\uFEFF/, '').trimStart().startsWith('Time;Lat;Lon'));
    if (headerIndex < 0) throw new Error(`No sensor table header found in ${sourceName}`);

    const runInfo = parseRunInfoFromFilename(sourceName, fallbackRun);
    const edgeCondition = resolveEdgeCondition(runInfo.runStartMs, fieldMeasurements);
    const seen = new Set();
    const csvLines = includeCsv ? [] : null;
    const dashboardRows = [];
    let aoiBounds = null;

    let rowsBefore = 0;
    let rowsAfter = 0;
    let duplicatesRemoved = 0;
    let invalidGpsRows = 0;
    let truncatedValues = 0;

    for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line || !line.trim()) continue;

      const rawCells = line.split(';').map(stripTrailingCommaArtifacts);
      if (!rawCells.some(value => value !== '')) continue;
      rowsBefore += 1;

      if (rawCells.length > STABLE_COLUMNS.length) truncatedValues += rawCells.length - STABLE_COLUMNS.length;

      // The raw normalized row is enough to detect repeated sensor records and
      // avoids serializing all 44 parsed values solely for duplicate checks.
      const duplicateKey = rawCells.slice(0, STABLE_COLUMNS.length).join('\u001F');
      if (seen.has(duplicateKey)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(duplicateKey);
      rowsAfter += 1;

      let values = null;
      if (includeCsv) {
        values = new Array(STABLE_COLUMNS.length);
        for (let columnIndex = 0; columnIndex < STABLE_COLUMNS.length; columnIndex += 1) {
          const column = STABLE_COLUMNS[columnIndex];
          const rawValue = rawCells[columnIndex] ?? '';
          values[columnIndex] = DATETIME_COLUMNS.has(column)
            ? normalizeTimestamp(rawValue)
            : parseNumeric(rawValue);
        }
        const outputValues = [...values, runInfo.runNumber, edgeCondition, shortName(sourceName), selectedSkiModel];
        csvLines.push(`${outputValues.map(csvEscape).join(',')}\n`);
      }

      const row = {};
      for (const [dashboardColumn, sourceIndex] of DASHBOARD_COLUMN_INDEXES) {
        if (includeCsv && values) {
          row[dashboardColumn] = values[sourceIndex];
        } else {
          const rawValue = rawCells[sourceIndex] ?? '';
          row[dashboardColumn] = DATETIME_COLUMNS.has(dashboardColumn)
            ? normalizeTimestamp(rawValue)
            : parseNumeric(rawValue);
        }
      }
      row.run = runInfo.runNumber;
      row.edge_condition = edgeCondition;
      row.source_file = shortName(sourceName);
      row.ski_model = selectedSkiModel;
      row.source_row = rowsBefore;

      if (isValidCoordinate(row.lat, row.lon)) {
        dashboardRows.push(row);
        if (!aoiBounds) {
          aoiBounds = {minLat: row.lat, minLon: row.lon, maxLat: row.lat, maxLon: row.lon, validPointCount: 1};
        } else {
          aoiBounds.minLat = Math.min(aoiBounds.minLat, row.lat);
          aoiBounds.minLon = Math.min(aoiBounds.minLon, row.lon);
          aoiBounds.maxLat = Math.max(aoiBounds.maxLat, row.lat);
          aoiBounds.maxLon = Math.max(aoiBounds.maxLon, row.lon);
          aoiBounds.validPointCount += 1;
        }
      } else {
        invalidGpsRows += 1;
      }
    }

    const referenceStatistics = calculateReferenceStatistics(dashboardRows);
    const routeDistanceKm = referenceStatistics.distanceMeters / 1000;
    const optimization = optimizeDashboardRows(dashboardRows, {
      run: runInfo.runNumber,
      sourceFile: shortName(sourceName)
    }, referenceStatistics);
    const selectedRows = optimization.rows;
    const dashboardPoints = selectedRows.map(row => rowToDashboardPoint(row, rowsAfter, selectedRows.length));
    const features = includeGeojson ? dashboardPoints.map(dashboardPointToFeature) : [];

    return {
      csvText: csvLines || [],
      features,
      dashboardPoints,
      stats: {
        rowsBefore,
        rowsAfter,
        duplicatesRemoved,
        invalidGpsRows,
        truncatedValues,
        routeDistanceKm,
        aoi: finalizeAoiBounds(aoiBounds),
        firstPoint: dashboardRows[0] ? {lat: dashboardRows[0].lat, lon: dashboardRows[0].lon} : null,
        lastPoint: dashboardRows.length ? {lat: dashboardRows[dashboardRows.length - 1].lat, lon: dashboardRows[dashboardRows.length - 1].lon} : null,
        startTimeMs: dashboardRows.length ? timestampToMilliseconds(dashboardRows[0].phone_time) : null,
        endTimeMs: dashboardRows.length ? timestampToMilliseconds(dashboardRows[dashboardRows.length - 1].phone_time) : null
      },
      optimization: optimization.diagnostics,
      reportRow: {
        file: shortName(sourceName),
        status: 'success',
        rows_before: rowsBefore,
        rows_after: rowsAfter,
        duplicates_removed: duplicatesRemoved,
        dashboard_points: selectedRows.length,
        route_distance_km: roundNumber(routeDistanceKm, 3),
        adaptive_budget: optimization.diagnostics.adaptiveBudget,
        sampling_ratio_percent: optimization.diagnostics.samplingRatioPercent,
        events_preserved: optimization.diagnostics.eventsPreserved,
        robust_outliers: optimization.diagnostics.robustOutliers,
        turn_events: optimization.diagnostics.turnEvents,
        gps_jump_flags: optimization.diagnostics.gpsJumpFlags,
        distance_error_percent: optimization.diagnostics.distanceErrorPercent,
        statistical_error_percent: optimization.diagnostics.statisticalErrorPercent,
        fidelity_error_percent: optimization.diagnostics.fidelityErrorPercent,
        quality_grade: optimization.diagnostics.qualityGrade,
        optimization_method: optimization.diagnostics.method,
        run: runInfo.runNumber,
        edge_condition: edgeCondition || '',
        ski_model: selectedSkiModel,
        note: truncatedValues ? `${truncatedValues} values beyond the stable 44-column schema were ignored` : ''
      }
    };
  }

  function calculateAoiBounds(rows) {
    let bounds = null;
    for (const row of rows || []) {
      if (row?.lat === null || row?.lat === undefined || row?.lat === '' || row?.lon === null || row?.lon === undefined || row?.lon === '') continue;
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!isValidCoordinate(lat, lon)) continue;
      if (!bounds) {
        bounds = {minLat: lat, minLon: lon, maxLat: lat, maxLon: lon, validPointCount: 1};
      } else {
        bounds.minLat = Math.min(bounds.minLat, lat);
        bounds.minLon = Math.min(bounds.minLon, lon);
        bounds.maxLat = Math.max(bounds.maxLat, lat);
        bounds.maxLon = Math.max(bounds.maxLon, lon);
        bounds.validPointCount += 1;
      }
    }
    return finalizeAoiBounds(bounds);
  }

  function mergeAoiBounds(current, incoming) {
    if (!incoming || ![incoming.minLat, incoming.minLon, incoming.maxLat, incoming.maxLon].every(Number.isFinite)) return current;
    if (!current) {
      return {
        minLat: incoming.minLat,
        minLon: incoming.minLon,
        maxLat: incoming.maxLat,
        maxLon: incoming.maxLon,
        validPointCount: Number(incoming.validPointCount) || 0
      };
    }
    return {
      minLat: Math.min(current.minLat, incoming.minLat),
      minLon: Math.min(current.minLon, incoming.minLon),
      maxLat: Math.max(current.maxLat, incoming.maxLat),
      maxLon: Math.max(current.maxLon, incoming.maxLon),
      validPointCount: (Number(current.validPointCount) || 0) + (Number(incoming.validPointCount) || 0)
    };
  }

  function finalizeAoiBounds(bounds) {
    if (!bounds || ![bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].every(Number.isFinite)) return null;
    const centroidLat = (bounds.minLat + bounds.maxLat) / 2;
    const centroidLon = (bounds.minLon + bounds.maxLon) / 2;
    const northSouthKm = haversineMeters(
      {lat: bounds.minLat, lon: centroidLon},
      {lat: bounds.maxLat, lon: centroidLon}
    ) / 1000;
    const eastWestKm = haversineMeters(
      {lat: centroidLat, lon: bounds.minLon},
      {lat: centroidLat, lon: bounds.maxLon}
    ) / 1000;
    const diagonalKm = haversineMeters(
      {lat: bounds.minLat, lon: bounds.minLon},
      {lat: bounds.maxLat, lon: bounds.maxLon}
    ) / 1000;
    return {
      minLat: roundNumber(bounds.minLat, 6),
      minLon: roundNumber(bounds.minLon, 6),
      maxLat: roundNumber(bounds.maxLat, 6),
      maxLon: roundNumber(bounds.maxLon, 6),
      centroidLat: roundNumber(centroidLat, 6),
      centroidLon: roundNumber(centroidLon, 6),
      widthKm: roundNumber(eastWestKm, 3),
      heightKm: roundNumber(northSouthKm, 3),
      diagonalKm: roundNumber(diagonalKm, 3),
      validPointCount: Number(bounds.validPointCount) || 0
    };
  }

  function stripTrailingCommaArtifacts(value) {
    return String(value ?? '').trim().replace(/,+$/g, '');
  }

  function parseNumeric(value) {
    const normalized = stripTrailingCommaArtifacts(value).replace(/,/g, '.');
    if (!normalized) return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeTimestamp(value) {
    let normalized = stripTrailingCommaArtifacts(value).replace(/,/g, '.');
    if (!normalized) return null;

    normalized = normalized.replace(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[ .](\d{1,6})$/,
      (_, datePart, timePart, fraction) => `${datePart} ${timePart}.${fraction.padEnd(3, '0').slice(0, 3)}`
    );

    const exact = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/);
    if (exact) {
      const milliseconds = (exact[3] || '0').padEnd(3, '0').slice(0, 3);
      return `${exact[1]} ${exact[2]}.${milliseconds}`;
    }

    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDateTime(parsed);
  }

  function parseRunInfoFromFilename(filename, fallbackRun) {
    const normalizedName = shortName(filename);
    const fullMatch = normalizedName.match(/(?<date>\d{4}-\d{2}-\d{2})[_ ](?<time>\d{2}-\d{2}-\d{2})[_ ]Run[_ ]?(?<run>\d+)/i);
    if (fullMatch?.groups) {
      const [year, month, day] = fullMatch.groups.date.split('-').map(Number);
      const [hour, minute, second] = fullMatch.groups.time.split('-').map(Number);
      return {
        runNumber: Number(fullMatch.groups.run),
        runStartMs: Date.UTC(year, month - 1, day, hour, minute, second)
      };
    }

    const runMatch = normalizedName.match(/Run[_ ]?(?<run>\d+)/i);
    return {
      runNumber: runMatch?.groups?.run ? Number(runMatch.groups.run) : fallbackRun,
      runStartMs: null
    };
  }

  async function parseFieldMeasurementsFromXlsxZip(arrayBuffer) {
    if (!window.JSZip || typeof DOMParser === 'undefined') return [];
    const workbookZip = await JSZip.loadAsync(arrayBuffer);
    const sharedStringsEntry = workbookZip.file('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsEntry
      ? parseSharedStringsXml(await sharedStringsEntry.async('string'))
      : [];

    const workbookEntry = workbookZip.file('xl/workbook.xml');
    const relationshipsEntry = workbookZip.file('xl/_rels/workbook.xml.rels');
    if (!workbookEntry || !relationshipsEntry) return [];

    const parser = new DOMParser();
    const workbookDocument = parser.parseFromString(await workbookEntry.async('string'), 'application/xml');
    const relationshipsDocument = parser.parseFromString(await relationshipsEntry.async('string'), 'application/xml');
    const firstSheet = workbookDocument.querySelector('sheet');
    if (!firstSheet) return [];

    const relationshipId = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const relationship = [...relationshipsDocument.querySelectorAll('Relationship')]
      .find(item => item.getAttribute('Id') === relationshipId);
    if (!relationship) return [];

    let sheetTarget = relationship.getAttribute('Target') || '';
    sheetTarget = sheetTarget.replace(/^\//, '').replace(/^\.\.\//, '');
    const sheetPath = sheetTarget.startsWith('xl/') ? sheetTarget : `xl/${sheetTarget}`;
    const sheetEntry = workbookZip.file(sheetPath);
    if (!sheetEntry) return [];

    const sheetDocument = parser.parseFromString(await sheetEntry.async('string'), 'application/xml');
    const tableRows = [...sheetDocument.querySelectorAll('sheetData row')].map(rowElement => {
      const values = [];
      [...rowElement.querySelectorAll('c')].forEach(cell => {
        const reference = cell.getAttribute('r') || '';
        const columnIndex = spreadsheetColumnIndex(reference.replace(/\d+/g, ''));
        const cellType = cell.getAttribute('t');
        let value = null;
        if (cellType === 'inlineStr') {
          value = [...cell.querySelectorAll('is t')].map(node => node.textContent || '').join('');
        } else {
          const rawValue = cell.querySelector('v')?.textContent ?? null;
          if (cellType === 's' && rawValue !== null) value = sharedStrings[Number(rawValue)] ?? '';
          else if (rawValue !== null && rawValue !== '') value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue;
        }
        values[columnIndex] = value;
      });
      return values;
    });

    const headerRowIndex = tableRows.findIndex(row => {
      const normalized = row.map(normalizeHeaderValue);
      return normalized.includes('date') && normalized.includes('time')
        && normalized.some(value => ['edge condition', 'edge'].includes(value));
    });
    if (headerRowIndex < 0) return [];

    const header = tableRows[headerRowIndex].map(normalizeHeaderValue);
    const dateIndex = header.indexOf('date');
    const timeIndex = header.indexOf('time');
    const edgeIndex = header.findIndex(value => ['edge condition', 'edge'].includes(value));
    const records = [];
    let lastDate = null;

    for (const row of tableRows.slice(headerRowIndex + 1)) {
      if (row[dateIndex] !== null && row[dateIndex] !== undefined && row[dateIndex] !== '') lastDate = row[dateIndex];
      const timeValue = row[timeIndex];
      if (lastDate === null || timeValue === null || timeValue === undefined || timeValue === '') continue;
      const timestamp = combineSpreadsheetDateTime(lastDate, timeValue);
      if (timestamp === null) continue;
      const edgeValue = row[edgeIndex];
      records.push({timestamp, edgeCondition: edgeValue == null ? null : String(edgeValue).trim()});
    }
    records.sort((a, b) => a.timestamp - b.timestamp);
    return records;
  }

  function parseSharedStringsXml(xml) {
    const parser = new DOMParser();
    const document = parser.parseFromString(xml, 'application/xml');
    return [...document.querySelectorAll('si')].map(item =>
      [...item.querySelectorAll('t')].map(node => node.textContent || '').join('')
    );
  }

  function spreadsheetColumnIndex(letters) {
    let index = 0;
    for (const character of String(letters).toUpperCase()) {
      index = index * 26 + character.charCodeAt(0) - 64;
    }
    return Math.max(0, index - 1);
  }

  function normalizeHeaderValue(value) {
    return String(value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseFieldMeasurements(arrayBuffer) {
    if (!window.XLSX) return [];
    const workbook = XLSX.read(arrayBuffer, {type: 'array', cellDates: true});
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {defval: null, raw: true});
    const records = [];
    let lastDate = null;

    for (const row of rows) {
      const dateValue = findObjectValue(row, ['date']);
      const timeValue = findObjectValue(row, ['time']);
      const edgeCondition = findObjectValue(row, ['edge condition', 'edge_condition', 'edge']);
      if (dateValue !== null && dateValue !== '') lastDate = dateValue;
      if (lastDate === null || timeValue === null || timeValue === '') continue;

      const timestamp = combineSpreadsheetDateTime(lastDate, timeValue);
      if (timestamp === null) continue;
      records.push({timestamp, edgeCondition: edgeCondition == null ? null : String(edgeCondition).trim()});
    }

    records.sort((a, b) => a.timestamp - b.timestamp);
    return records;
  }

  function findObjectValue(object, candidateKeys) {
    const entries = Object.entries(object);
    for (const [key, value] of entries) {
      const normalized = String(key).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (candidateKeys.includes(normalized)) return value;
    }
    return null;
  }

  function combineSpreadsheetDateTime(dateValue, timeValue) {
    const dateParts = extractDateParts(dateValue);
    const timeParts = extractTimeParts(timeValue);
    if (!dateParts || !timeParts) return null;
    return Date.UTC(
      dateParts.year, dateParts.month - 1, dateParts.day,
      timeParts.hour, timeParts.minute, timeParts.second, timeParts.millisecond
    );
  }

  function extractDateParts(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return {year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate()};
    }
    if (typeof value === 'number') {
      if (window.XLSX?.SSF?.parse_date_code) {
        const parsed = XLSX.SSF.parse_date_code(value);
        if (parsed) return {year: parsed.y, month: parsed.m, day: parsed.d};
      }
      // Excel's serial-date epoch, including the conventional 1900 leap-year offset.
      const excelDate = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
      return {
        year: excelDate.getUTCFullYear(),
        month: excelDate.getUTCMonth() + 1,
        day: excelDate.getUTCDate()
      };
    }
    const match = String(value ?? '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (match) return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3])};
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return {year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate()};
    }
    return null;
  }

  function extractTimeParts(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return {
        hour: value.getUTCHours(), minute: value.getUTCMinutes(),
        second: value.getUTCSeconds(), millisecond: value.getUTCMilliseconds()
      };
    }
    if (typeof value === 'number') {
      const totalMilliseconds = Math.round((value % 1) * 24 * 60 * 60 * 1000);
      return {
        hour: Math.floor(totalMilliseconds / 3600000),
        minute: Math.floor((totalMilliseconds % 3600000) / 60000),
        second: Math.floor((totalMilliseconds % 60000) / 1000),
        millisecond: totalMilliseconds % 1000
      };
    }
    const match = String(value ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?/);
    if (!match) return null;
    return {
      hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] || 0),
      millisecond: Number((match[4] || '0').padEnd(3, '0'))
    };
  }

  function resolveEdgeCondition(runStartMs, records) {
    if (runStartMs === null || !records?.length) return null;
    const runDate = new Date(runStartMs);
    let best = null;
    for (const record of records) {
      if (record.timestamp > runStartMs) break;
      const recordDate = new Date(record.timestamp);
      const sameDate = recordDate.getUTCFullYear() === runDate.getUTCFullYear()
        && recordDate.getUTCMonth() === runDate.getUTCMonth()
        && recordDate.getUTCDate() === runDate.getUTCDate();
      if (sameDate) best = record;
    }
    return best?.edgeCondition || null;
  }

  function downsampleDashboardRows(rows) {
    return optimizeDashboardRows(rows).rows;
  }

  function optimizeDashboardRows(rows, context = {}, originalReference = null) {
    const count = rows.length;
    if (!count) {
      return {
        rows: [],
        diagnostics: emptyOptimizationDiagnostics(context)
      };
    }

    const series = buildStatisticalSeries(rows);
    const eventAnalysis = detectStatisticalEvents(series, count);
    const complexity = calculateComplexity(series, eventAnalysis, count);
    const initialBudget = clamp(
      Math.round(
        OPTIMIZATION_CONFIG.basePoints
        + OPTIMIZATION_CONFIG.squareRootScale * Math.sqrt(count)
        + OPTIMIZATION_CONFIG.complexityBonus * complexity
      ),
      Math.min(count, OPTIMIZATION_CONFIG.minPoints),
      Math.min(count, OPTIMIZATION_CONFIG.maxPoints)
    );

    if (count <= OPTIMIZATION_CONFIG.minPoints) {
      const fidelity = evaluateSamplingFidelity(rows, rows, originalReference);
      return {
        rows,
        diagnostics: buildOptimizationDiagnostics({
          context,
          count,
          exportedCount: count,
          adaptiveBudget: count,
          eventAnalysis,
          fidelity,
          iterations: 0,
          complexity
        })
      };
    }

    let budget = initialBudget;
    let selectedIndices = [];
    let fidelity = null;
    let iterations = 0;

    while (iterations < OPTIMIZATION_CONFIG.maxIterations) {
      selectedIndices = buildAdaptiveSelection(
        count,
        budget,
        eventAnalysis.eventScores,
        series.importance
      );
      const selectedRows = selectedIndices.map(index => rows[index]);
      fidelity = evaluateSamplingFidelity(rows, selectedRows, originalReference);

      const atMaximum = selectedIndices.length >= Math.min(count, OPTIMIZATION_CONFIG.maxPoints)
        || budget >= Math.min(count, OPTIMIZATION_CONFIG.maxPoints);
      if (fidelity.fidelityErrorPercent <= OPTIMIZATION_CONFIG.fidelityTargetPercent || atMaximum) break;

      budget = Math.min(
        count,
        OPTIMIZATION_CONFIG.maxPoints,
        Math.max(budget + 1, Math.ceil(budget * OPTIMIZATION_CONFIG.growthFactor))
      );
      iterations += 1;
    }

    const selectedRows = selectedIndices.map(index => rows[index]);
    return {
      rows: selectedRows,
      diagnostics: buildOptimizationDiagnostics({
        context,
        count,
        exportedCount: selectedRows.length,
        adaptiveBudget: budget,
        eventAnalysis,
        fidelity,
        iterations,
        complexity
      })
    };
  }

  function buildStatisticalSeries(rows) {
    const count = rows.length;
    const acceleration = new Array(count);
    const gyroscope = new Array(count);
    const speed = new Array(count);
    const altitude = new Array(count);
    const timestamps = new Array(count);
    const jerk = new Array(count).fill(null);
    const speedChange = new Array(count).fill(null);
    const stepDistance = new Array(count).fill(null);
    const headingChange = new Array(count).fill(null);

    for (let index = 0; index < count; index += 1) {
      const row = rows[index];
      acceleration[index] = maximumFinite([
        vectorMagnitude(row.left_acc_x, row.left_acc_y, row.left_acc_z),
        vectorMagnitude(row.right_acc_x, row.right_acc_y, row.right_acc_z)
      ]);
      gyroscope[index] = maximumFinite([
        vectorMagnitude(row.left_gyro_x, row.left_gyro_y, row.left_gyro_z),
        vectorMagnitude(row.right_gyro_x, row.right_gyro_y, row.right_gyro_z)
      ]);
      speed[index] = Number.isFinite(row.speed) ? row.speed : null;
      altitude[index] = Number.isFinite(row.alt) ? row.alt : null;
      timestamps[index] = timestampToMilliseconds(row.phone_time);

      if (index > 0) {
        const dtSeconds = validTimeDeltaSeconds(timestamps[index - 1], timestamps[index]);
        if (Number.isFinite(acceleration[index]) && Number.isFinite(acceleration[index - 1])) {
          jerk[index] = Math.abs(acceleration[index] - acceleration[index - 1]) / dtSeconds;
        }
        if (Number.isFinite(speed[index]) && Number.isFinite(speed[index - 1])) {
          speedChange[index] = Math.abs(speed[index] - speed[index - 1]) / dtSeconds;
        }
        stepDistance[index] = haversineMeters(rows[index - 1], row);
      }
    }

    for (let index = 1; index < count - 1; index += 1) {
      const incoming = bearingDegrees(rows[index - 1], rows[index]);
      const outgoing = bearingDegrees(rows[index], rows[index + 1]);
      if (Number.isFinite(incoming) && Number.isFinite(outgoing)) {
        headingChange[index] = circularDifferenceDegrees(incoming, outgoing);
      }
    }

    const standardized = {
      acceleration: robustStandardize(acceleration, 'upper'),
      gyroscope: robustStandardize(gyroscope, 'upper'),
      jerk: robustStandardize(jerk, 'upper'),
      speedChange: robustStandardize(speedChange, 'upper'),
      stepDistance: robustStandardize(stepDistance, 'upper'),
      headingChange: robustStandardize(headingChange, 'upper')
    };

    const importance = rows.map((_, index) => maximumFinite([
      standardized.acceleration.scores[index],
      standardized.gyroscope.scores[index],
      standardized.jerk.scores[index],
      standardized.speedChange.scores[index],
      standardized.stepDistance.scores[index],
      Number.isFinite(headingChange[index]) ? headingChange[index] / 20 : 0
    ]) || 0);

    return {
      acceleration,
      gyroscope,
      speed,
      altitude,
      timestamps,
      jerk,
      speedChange,
      stepDistance,
      headingChange,
      standardized,
      importance
    };
  }

  function detectStatisticalEvents(series, count) {
    const eventScores = new Map();
    const categorySets = {
      robustOutliers: new Set(),
      turnEvents: new Set(),
      gpsJumpFlags: new Set()
    };

    const addEvent = (index, score, category, includeNeighbors = true) => {
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      eventScores.set(index, Math.max(eventScores.get(index) || 0, Number(score) || 0));
      categorySets[category]?.add(index);
      if (includeNeighbors) {
        for (const neighbor of [index - 1, index + 1]) {
          if (neighbor >= 0 && neighbor < count) {
            eventScores.set(neighbor, Math.max(eventScores.get(neighbor) || 0, (Number(score) || 0) * 0.85));
          }
        }
      }
    };

    ['acceleration', 'gyroscope', 'jerk', 'speedChange'].forEach(name => {
      const scores = series.standardized[name].scores;
      scores.forEach((score, index) => {
        if (Number.isFinite(score) && score >= OPTIMIZATION_CONFIG.robustZThreshold
            && isLocalMaximum(scores, index, 2)) {
          addEvent(index, score, 'robustOutliers');
        }
      });
    });

    series.headingChange.forEach((turn, index) => {
      const score = series.standardized.headingChange.scores[index];
      const statisticallyUnusual = Number.isFinite(score) && score >= OPTIMIZATION_CONFIG.robustZThreshold;
      const geometricallyStrong = Number.isFinite(turn) && turn >= 35;
      if (Number.isFinite(turn) && turn >= OPTIMIZATION_CONFIG.minimumTurnDegrees
          && (statisticallyUnusual || geometricallyStrong)
          && isLocalMaximum(series.headingChange, index, 6)) {
        addEvent(index, Math.max(score || 0, turn / 10), 'turnEvents');
      }
    });

    const distanceCenter = series.standardized.stepDistance.center;
    const distanceScale = series.standardized.stepDistance.scale;
    const absoluteJumpFloor = Math.max(25, (distanceCenter || 0) + 6 * (distanceScale || 0));
    series.stepDistance.forEach((distance, index) => {
      const score = series.standardized.stepDistance.scores[index];
      if (Number.isFinite(distance) && distance >= absoluteJumpFloor
          && Number.isFinite(score) && score >= 6) {
        addEvent(index, score, 'gpsJumpFlags', false);
        addEvent(index - 1, score, 'gpsJumpFlags', false);
      }
    });

    eventScores.set(0, Number.POSITIVE_INFINITY);
    eventScores.set(count - 1, Number.POSITIVE_INFINITY);

    if (eventScores.size > OPTIMIZATION_CONFIG.maxPoints) {
      const strongest = [...eventScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, OPTIMIZATION_CONFIG.maxPoints);
      eventScores.clear();
      strongest.forEach(([index, score]) => eventScores.set(index, score));
      eventScores.set(0, Number.POSITIVE_INFINITY);
      eventScores.set(count - 1, Number.POSITIVE_INFINITY);
    }

    return {
      eventScores,
      robustOutliers: categorySets.robustOutliers.size,
      turnEvents: categorySets.turnEvents.size,
      gpsJumpFlags: categorySets.gpsJumpFlags.size
    };
  }


  function isLocalMaximum(values, index, radius = 1) {
    const current = values[index];
    if (!Number.isFinite(current)) return false;
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    for (let candidate = start; candidate <= end; candidate += 1) {
      if (candidate === index || !Number.isFinite(values[candidate])) continue;
      if (values[candidate] > current) return false;
      if (values[candidate] === current && candidate < index) return false;
    }
    return true;
  }

  function calculateComplexity(series, eventAnalysis, count) {
    const turnP90 = quantile(series.headingChange, 0.90) || 0;
    const accelerationSpread = robustRelativeSpread(series.acceleration);
    const gyroscopeSpread = robustRelativeSpread(series.gyroscope);
    const eventDensity = Math.min(1, eventAnalysis.eventScores.size / Math.max(1, count * 0.08));
    const turnComplexity = Math.min(1, turnP90 / 35);
    return clamp(
      0.35 * turnComplexity
      + 0.25 * Math.min(1, accelerationSpread)
      + 0.20 * Math.min(1, gyroscopeSpread)
      + 0.20 * eventDensity,
      0,
      1
    );
  }

  function buildAdaptiveSelection(count, requestedBudget, eventScores, importance) {
    const maximum = Math.min(count, OPTIMIZATION_CONFIG.maxPoints);
    const budget = clamp(Math.round(requestedBudget), 2, maximum);
    const selected = new Set([...eventScores.keys()].filter(index => index >= 0 && index < count));
    selected.add(0);
    selected.add(count - 1);

    const remaining = Math.max(0, budget - selected.size);
    if (remaining > 0) {
      for (let bin = 0; bin < remaining; bin += 1) {
        const start = Math.floor((bin * count) / remaining);
        const end = Math.max(start + 1, Math.floor(((bin + 1) * count) / remaining));
        const midpoint = (start + end - 1) / 2;
        let bestIndex = start;
        let bestScore = -Infinity;

        for (let index = start; index < Math.min(end, count); index += 1) {
          if (selected.has(index)) continue;
          const temporalTieBreaker = 1 / (1 + Math.abs(index - midpoint));
          const score = (Number(importance[index]) || 0) + temporalTieBreaker * 0.01;
          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }
        selected.add(bestIndex);
      }
    }

    if (selected.size > maximum) {
      const protectedEndpoints = new Set([0, count - 1]);
      const ranked = [...selected]
        .filter(index => !protectedEndpoints.has(index))
        .sort((a, b) => (eventScores.get(b) || importance[b] || 0) - (eventScores.get(a) || importance[a] || 0))
        .slice(0, maximum - protectedEndpoints.size);
      return [...protectedEndpoints, ...ranked].sort((a, b) => a - b);
    }

    return [...selected].sort((a, b) => a - b);
  }

  function evaluateSamplingFidelity(originalRows, sampledRows, originalReference = null) {
    const original = originalReference || calculateReferenceStatistics(originalRows);
    const sampled = calculateReferenceStatistics(sampledRows);
    const distanceErrorPercent = relativeErrorPercent(sampled.distanceMeters, original.distanceMeters);
    const metricErrors = [
      relativeErrorPercent(sampled.speedMean, original.speedMean),
      relativeErrorPercent(sampled.speedP95, original.speedP95),
      relativeErrorPercent(sampled.altitudeRange, original.altitudeRange),
      relativeErrorPercent(sampled.accelerationP95, original.accelerationP95),
      relativeErrorPercent(sampled.gyroscopeP95, original.gyroscopeP95)
    ].filter(Number.isFinite);
    const statisticalErrorPercent = metricErrors.length ? Math.max(...metricErrors) : 0;
    const fidelityErrorPercent = maximumFinite([distanceErrorPercent, statisticalErrorPercent]) || 0;
    return {
      distanceErrorPercent: roundNumber(distanceErrorPercent || 0, 3),
      statisticalErrorPercent: roundNumber(statisticalErrorPercent || 0, 3),
      fidelityErrorPercent: roundNumber(fidelityErrorPercent, 3)
    };
  }

  function calculateReferenceStatistics(rows) {
    const acceleration = [];
    const gyroscope = [];
    const speed = [];
    const altitude = [];
    let distanceMeters = 0;

    rows.forEach((row, index) => {
      const acc = maximumFinite([
        vectorMagnitude(row.left_acc_x, row.left_acc_y, row.left_acc_z),
        vectorMagnitude(row.right_acc_x, row.right_acc_y, row.right_acc_z)
      ]);
      const gyro = maximumFinite([
        vectorMagnitude(row.left_gyro_x, row.left_gyro_y, row.left_gyro_z),
        vectorMagnitude(row.right_gyro_x, row.right_gyro_y, row.right_gyro_z)
      ]);
      if (Number.isFinite(acc)) acceleration.push(acc);
      if (Number.isFinite(gyro)) gyroscope.push(gyro);
      if (Number.isFinite(row.speed)) speed.push(row.speed);
      if (Number.isFinite(row.alt)) altitude.push(row.alt);
      if (index > 0) distanceMeters += haversineMeters(rows[index - 1], row) || 0;
    });

    return {
      distanceMeters,
      speedMean: mean(speed),
      speedP95: quantile(speed, 0.95),
      altitudeRange: finiteRange(altitude),
      accelerationP95: quantile(acceleration, 0.95),
      gyroscopeP95: quantile(gyroscope, 0.95)
    };
  }

  function buildOptimizationDiagnostics({context, count, exportedCount, adaptiveBudget, eventAnalysis, fidelity, iterations, complexity}) {
    return {
      method: OPTIMIZATION_CONFIG.method,
      run: context.run ?? null,
      sourceFile: context.sourceFile ?? '',
      originalCount: count,
      exportedCount,
      adaptiveBudget,
      samplingRatioPercent: roundNumber(100 * exportedCount / Math.max(1, count), 2),
      eventsPreserved: Math.min(exportedCount, eventAnalysis.eventScores.size),
      robustOutliers: eventAnalysis.robustOutliers,
      turnEvents: eventAnalysis.turnEvents,
      gpsJumpFlags: eventAnalysis.gpsJumpFlags,
      distanceErrorPercent: fidelity.distanceErrorPercent,
      statisticalErrorPercent: fidelity.statisticalErrorPercent,
      fidelityErrorPercent: fidelity.fidelityErrorPercent,
      qualityGrade: qualityGrade(fidelity.fidelityErrorPercent),
      targetMet: fidelity.fidelityErrorPercent <= OPTIMIZATION_CONFIG.fidelityTargetPercent,
      iterations,
      complexityScore: roundNumber(complexity, 3)
    };
  }

  function emptyOptimizationDiagnostics(context = {}) {
    return {
      method: OPTIMIZATION_CONFIG.method,
      run: context.run ?? null,
      sourceFile: context.sourceFile ?? '',
      originalCount: 0,
      exportedCount: 0,
      adaptiveBudget: 0,
      samplingRatioPercent: 0,
      eventsPreserved: 0,
      robustOutliers: 0,
      turnEvents: 0,
      gpsJumpFlags: 0,
      distanceErrorPercent: 0,
      statisticalErrorPercent: 0,
      fidelityErrorPercent: 0,
      qualityGrade: 'No data',
      targetMet: true,
      iterations: 0,
      complexityScore: 0
    };
  }

  function robustStandardize(values, tail = 'two-sided') {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    const center = finite.length ? quantileSorted(finite, 0.5) : null;
    const deviations = finite.length && Number.isFinite(center)
      ? finite.map(value => Math.abs(value - center)).sort((a, b) => a - b)
      : [];
    const mad = deviations.length ? quantileSorted(deviations, 0.5) : 0;
    const fallbackIqr = finite.length ? (quantileSorted(finite, 0.75) - quantileSorted(finite, 0.25)) / 1.349 : 0;
    const scale = Math.max(1e-9, 1.4826 * mad, fallbackIqr || 0);
    const scores = values.map(value => {
      if (!Number.isFinite(value) || !Number.isFinite(center)) return null;
      const z = (value - center) / scale;
      if (tail === 'upper') return Math.max(0, z);
      if (tail === 'lower') return Math.max(0, -z);
      return Math.abs(z);
    });
    return {center, scale, scores};
  }

  function robustRelativeSpread(values) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return 0;
    const median = quantileSorted(finite, 0.5);
    const deviations = finite.map(value => Math.abs(value - median)).sort((a, b) => a - b);
    const mad = quantileSorted(deviations, 0.5);
    return (1.4826 * mad) / Math.max(Math.abs(median), 1e-6);
  }

  function mean(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
  }

  function quantile(values, probability) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    return finite.length ? quantileSorted(finite, probability) : null;
  }

  function quantileSorted(sorted, probability) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * clamp(probability, 0, 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  function finiteRange(values) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    return minimum === Infinity ? null : maximum - minimum;
  }

  function relativeErrorPercent(estimate, reference) {
    if (!Number.isFinite(reference) || !Number.isFinite(estimate)) return null;
    const denominator = Math.max(Math.abs(reference), 1e-6);
    return 100 * Math.abs(estimate - reference) / denominator;
  }

  function qualityGrade(errorPercent) {
    if (!Number.isFinite(errorPercent)) return 'Review';
    if (errorPercent <= 1) return 'Excellent';
    if (errorPercent <= OPTIMIZATION_CONFIG.fidelityTargetPercent) return 'High';
    if (errorPercent <= 5) return 'Acceptable';
    return 'Review';
  }

  function maximumFinite(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function timestampToMilliseconds(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!match) return null;
    return Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6]),
      Number((match[7] || '0').padEnd(3, '0'))
    );
  }

  function validTimeDeltaSeconds(previous, current) {
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current <= previous) return 1;
    return Math.max(0.001, (current - previous) / 1000);
  }

  function haversineMeters(first, second) {
    if (!first || !second || !isValidCoordinate(first.lat, first.lon) || !isValidCoordinate(second.lat, second.lon)) return 0;
    const toRadians = degrees => degrees * Math.PI / 180;
    const deltaLat = toRadians(second.lat - first.lat);
    const deltaLon = toRadians(second.lon - first.lon);
    const lat1 = toRadians(first.lat);
    const lat2 = toRadians(second.lat);
    const h = Math.sin(deltaLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function bearingDegrees(first, second) {
    if (!first || !second || !isValidCoordinate(first.lat, first.lon) || !isValidCoordinate(second.lat, second.lon)) return null;
    const toRadians = degrees => degrees * Math.PI / 180;
    const lat1 = toRadians(first.lat);
    const lat2 = toRadians(second.lat);
    const deltaLon = toRadians(second.lon - first.lon);
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function circularDifferenceDegrees(first, second) {
    const difference = Math.abs(first - second) % 360;
    return difference > 180 ? 360 - difference : difference;
  }

  function vectorMagnitude(x, y, z) {
    if (![x, y, z].some(Number.isFinite)) return NaN;
    return Math.sqrt((Number(x) || 0) ** 2 + (Number(y) || 0) ** 2 + (Number(z) || 0) ** 2);
  }

  function rowToDashboardPoint(row, originalCount, exportedCount) {
    const point = {};
    for (const column of DASHBOARD_COLUMNS) {
      if (column === 'lat' || column === 'lon') continue;
      if (column === 'phone_time') point[column] = row[column] ? row[column].replace(' ', 'T') : null;
      else point[column] = roundForDashboard(column, row[column]);
    }
    point.run = row.run;
    point.edge_condition = row.edge_condition;
    point.source_file = row.source_file;
    point.ski_model = row.ski_model || null;
    point.source_row = row.source_row;
    point.run_rows_cleaned = originalCount;
    point.run_points_exported = exportedCount;
    point.lon = roundNumber(row.lon, 6);
    point.lat = roundNumber(row.lat, 6);
    return point;
  }

  function rowToFeature(row, originalCount, exportedCount) {
    return dashboardPointToFeature(rowToDashboardPoint(row, originalCount, exportedCount));
  }

  function roundForDashboard(column, value) {
    if (!Number.isFinite(value)) return null;
    if (column === 'alt') return roundNumber(value, 2);
    if (column === 'speed') return roundNumber(value, 3);
    return roundNumber(value, 3);
  }

  function roundNumber(value, decimals) {
    if (!Number.isFinite(value)) return null;
    const multiplier = 10 ** decimals;
    return Math.round(value * multiplier) / multiplier;
  }

  function isValidCoordinate(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon)
      && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
  }

  function canonicalValue(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'number' ? String(value) : value;
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildReportCsv(reportRows) {
    const columns = [
      'file', 'status', 'rows_before', 'rows_after', 'duplicates_removed',
      'dashboard_points', 'route_distance_km', 'adaptive_budget', 'sampling_ratio_percent',
      'events_preserved', 'robust_outliers', 'turn_events', 'gps_jump_flags',
      'distance_error_percent', 'statistical_error_percent', 'fidelity_error_percent',
      'quality_grade', 'optimization_method', 'run', 'edge_condition', 'ski_model',
      'analytics_file', 'analytics_status', 'note'
    ];
    return `${columns.join(',')}\n${reportRows.map(row => columns.map(column => csvEscape(row[column])).join(',')).join('\n')}\n`;
  }

  function populatePipelineResults(summary, report) {
    const processedRuns = Number(summary.filesProcessed || 0);
    const matchedAnalytics = Number(summary.analyticsFilesMatched || 0);
    const selectedSki = summary.selectedSkiModel || 'selected ski';

    byId('pipelineFiles').textContent = processedRuns.toLocaleString();
    if (byId('pipelineAnalytics')) {
      byId('pipelineAnalytics').textContent = `${matchedAnalytics}/${processedRuns}`;
    }
    if (byId('pipelineDistance')) {
      byId('pipelineDistance').textContent = `${Number(summary.totalDistanceKm || 0).toFixed(2)} km`;
    }
    byId('pipelineRows').textContent = summary.rowsAfter.toLocaleString();
    byId('pipelinePoints').textContent = summary.dashboardPoints.toLocaleString();
    byId('pipelineReduction').textContent = `${summary.reductionPercent.toFixed(1)}%`;
    if (byId('pipelineFidelity')) byId('pipelineFidelity').textContent = `${summary.worstFidelityErrorPercent.toFixed(2)}%`;
    if (byId('pipelineEvents')) byId('pipelineEvents').textContent = summary.eventsPreserved.toLocaleString();

    const resultBox = byId('dataPipelineModal')?.querySelector('.data-pipeline-box');
    resultBox?.classList.remove('is-error');
    resultBox?.classList.add('is-success');
    if (byId('pipelineResultIcon')) byId('pipelineResultIcon').textContent = '✓';
    if (byId('pipelineResultTitle')) byId('pipelineResultTitle').textContent = 'Dashboard ready';
    if (byId('pipelineResultSubtitle')) {
      byId('pipelineResultSubtitle').textContent = `${processedRuns} run${processedRuns === 1 ? '' : 's'} processed and assigned to ${selectedSki}.`;
    }

    const skipped = report.filter(row => row.status !== 'success');
    const userWarnings = [];
    if (summary.gpsJumpFlags) {
      userWarnings.push(`${summary.gpsJumpFlags.toLocaleString()} possible GPS-jump point${summary.gpsJumpFlags === 1 ? ' was' : 's were'} retained for review.`);
    }
    if (skipped.length) {
      userWarnings.push(`${skipped.length} sensor file${skipped.length === 1 ? ' did' : 's did'} not match the expected raw-data format.`);
    }
    const actionNote = byId('pipelineActionNote');
    if (actionNote) {
      actionNote.textContent = userWarnings.join(' ');
      actionNote.classList.toggle('is-visible', userWarnings.length > 0);
    }

    byId('pipelineDetails').innerHTML = `
      <b>${escapeHtml(summary.archiveName)}</b> was processed locally in your browser.<br>
      <b>Assigned ski:</b> ${escapeHtml(summary.selectedSkiModel || 'Not specified')}<br>
      ${summary.duplicatesRemoved.toLocaleString()} duplicate rows removed ·
      ${summary.invalidGpsRows.toLocaleString()} rows excluded from the map because coordinates were missing/invalid ·
      ${summary.edgeConditionRecords.toLocaleString()} edge-condition timestamp record(s) detected.<br>
      <b>Full cleaned route distance:</b> ${summary.totalDistanceKm.toFixed(2)} km. This raw-GPS distance was added to the ski's preserved service baseline.<br>
      <b>Acquisition analytics JSON:</b> ${summary.analyticsFilesMatched}/${summary.filesProcessed} run(s) matched (${summary.analyticsCoveragePercent.toFixed(1)}% coverage).
      ${summary.analyticsFilesMatched ? `Authoritative JSON KPIs: ${Number(summary.analyticsDistanceKm || 0).toFixed(2)} km skiing distance · ${Number(summary.analyticsSkiingTimeSeconds || 0).toFixed(1)} s skiing time · ${Number(summary.analyticsTurnCount || 0).toLocaleString()} turns · max ${Number(summary.analyticsMaximumGForce || 0).toFixed(2)} g.<br>` : 'No valid acquisition analytics JSON was matched; dashboard KPIs use CSV-derived fallbacks.<br>'}
      <b>Statistical optimization:</b> ${summary.optimizationQuality} fidelity ·
      worst combined error ${summary.worstFidelityErrorPercent.toFixed(2)}% ·
      route-distance error ${summary.worstDistanceErrorPercent.toFixed(2)}% ·
      distribution error ${summary.worstStatisticalErrorPercent.toFixed(2)}%.<br>
      Preserved ${summary.eventsPreserved.toLocaleString()} statistically important points
      (${summary.robustOutliers.toLocaleString()} robust signal outliers, ${summary.turnEvents.toLocaleString()} turn events).
      ${summary.gpsJumpFlags ? `${summary.gpsJumpFlags.toLocaleString()} possible GPS-jump point(s) were flagged and retained for review.<br>` : '<br>'}
      <b>AOI service partners:</b> ${Number(summary.servicePartnersFound || 0).toLocaleString()} result(s)${summary.servicePartnerSearchBufferKm ? ` within the AOI plus a ${Number(summary.servicePartnerSearchBufferKm).toFixed(0)} km search buffer` : ''}.${summary.servicePartnerLookupError ? ` Lookup warning: ${escapeHtml(summary.servicePartnerLookupError)}` : ' Lookup runs separately so it does not block the dashboard.'}<br>
      Cleaned CSV: ${summary.csvDeferred && !state.csvBlob ? 'generated only when requested' : formatBytes(summary.csvBytes || state.csvBlob?.size || 0)} · Optimized GeoJSON: ${summary.geojsonDeferred && !state.geojsonBlob ? 'generated only when requested' : formatBytes(summary.geojsonBytes || state.geojsonBlob?.size || 0)}.
    `;

    const technicalWarnings = [];
    if (skipped.length) technicalWarnings.push(`${skipped.length} CSV file(s) were skipped because they did not match the raw sensor format.`);
    if (summary.truncatedValues) technicalWarnings.push(`${summary.truncatedValues.toLocaleString()} values beyond the stable 44-column schema were ignored.`);
    if (summary.runsAboveFidelityTarget) technicalWarnings.push(`${summary.runsAboveFidelityTarget} run(s) could not reach the 2% fidelity target within the ${OPTIMIZATION_CONFIG.maxPoints.toLocaleString()}-point ceiling.`);
    if (summary.gpsJumpFlags) technicalWarnings.push(`${summary.gpsJumpFlags.toLocaleString()} possible GPS-jump point(s) were retained and flagged for review.`);
    byId('pipelineWarnings').textContent = technicalWarnings.length
      ? `${technicalWarnings.join(' ')} See the cleaning report for run-level diagnostics.`
      : 'No run-level processing warnings were detected.';
  }

  function resetPipelineResults(filename, selectedSkiName = '') {
    state.csvBlob = null;
    state.geojsonBlob = null;
    state.lastDashboardPoints = null;
    state.lastGeojsonProperties = null;
    state.reportBlob = null;
    const csvButton = byId('pipelineDownloadCsv');
    if (csvButton) csvButton.textContent = 'Generate cleaned CSV';
    byId('pipelineFileName').textContent = filename;
    ['pipelineFiles', 'pipelineAnalytics', 'pipelineDistance', 'pipelineRows', 'pipelinePoints', 'pipelineReduction', 'pipelineFidelity', 'pipelineEvents'].forEach(id => {
      if (byId(id)) byId(id).textContent = '—';
    });
    const resultBox = byId('dataPipelineModal')?.querySelector('.data-pipeline-box');
    resultBox?.classList.remove('is-success', 'is-error');
    if (byId('pipelineResultIcon')) byId('pipelineResultIcon').textContent = '⏳';
    if (byId('pipelineResultTitle')) byId('pipelineResultTitle').textContent = 'Preparing dashboard data';
    if (byId('pipelineResultSubtitle')) {
      byId('pipelineResultSubtitle').textContent = selectedSkiName
        ? `The archive will be processed and assigned to ${selectedSkiName}.`
        : 'CSV sensor recordings and acquisition analytics will be combined automatically.';
    }
    if (byId('pipelineActionNote')) {
      byId('pipelineActionNote').textContent = '';
      byId('pipelineActionNote').classList.remove('is-visible');
    }
    setTechnicalDetailsExpanded(false);
    byId('pipelineDetails').textContent = 'The archive is being read and cleaned locally.';
    byId('pipelineWarnings').textContent = '';
  }

  function setProcessingState(processing, success = false) {
    const modal = byId('dataPipelineModal');
    modal?.classList.toggle('is-processing', processing);
    byId('pipelineSpinner')?.classList.toggle('active', processing);
    const csvButton = byId('pipelineDownloadCsv');
    if (csvButton) {
      csvButton.disabled = processing || !success;
      if (!processing) csvButton.textContent = state.csvBlob ? 'Download merged CSV' : 'Generate cleaned CSV';
    }
    const geojsonButton = byId('pipelineDownloadGeojson');
    if (geojsonButton) {
      geojsonButton.disabled = processing || !success;
      if (!processing) geojsonButton.textContent = state.geojsonBlob ? 'Download merged GeoJSON' : 'Generate merged GeoJSON';
    }
    byId('pipelineDownloadReport').disabled = processing || !success;
    byId('chooseAnotherZip').disabled = processing;
    byId('closePipelineModal').disabled = processing;
    if (byId('openDashboardAfterProcessing')) byId('openDashboardAfterProcessing').disabled = processing || !success;
  }

  function updatePipelineProgress(percent, message) {
    const bounded = Math.max(0, Math.min(100, percent));
    if (byId('pipelineProgressBar')) byId('pipelineProgressBar').style.width = `${bounded}%`;
    if (byId('pipelineProgressValue')) byId('pipelineProgressValue').textContent = `${Math.round(bounded)}%`;
    if (byId('pipelineStatus')) byId('pipelineStatus').textContent = message;
  }

  function showPipelineError(message) {
    openPipelineModal();
    updatePipelineProgress(0, 'Processing stopped');
    const resultBox = byId('dataPipelineModal')?.querySelector('.data-pipeline-box');
    resultBox?.classList.remove('is-success');
    resultBox?.classList.add('is-error');
    if (byId('pipelineResultIcon')) byId('pipelineResultIcon').textContent = '!';
    if (byId('pipelineResultTitle')) byId('pipelineResultTitle').textContent = 'The archive could not be processed';
    if (byId('pipelineResultSubtitle')) byId('pipelineResultSubtitle').textContent = message;
    if (byId('pipelineDetails')) byId('pipelineDetails').innerHTML = `<span class="pipeline-error">${escapeHtml(message)}</span>`;
    if (byId('pipelineWarnings')) byId('pipelineWarnings').textContent = 'Confirm that the ZIP contains the original semicolon-delimited ConnectedBoot CSV exports.';
    setTechnicalDetailsExpanded(true);
  }

  function openPipelineModal() {
    const modal = byId('dataPipelineModal');
    if (modal) modal.style.display = 'flex';
  }

  function closePipelineModal() {
    const modal = byId('dataPipelineModal');
    if (modal && !modal.classList.contains('is-processing')) modal.style.display = 'none';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function formatDateTime(date) {
    const pad = (number, length = 2) => String(number).padStart(length, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  function shortName(path) {
    return String(path).split('/').pop().split('\\').pop();
  }

  function safeBaseName(value) {
    return String(value).trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  window.SkiDataPipeline = {
    processSensorZip,
    parseFieldMeasurementsFromXlsxZip,
    cleanSensorText,
    findSensorHeaderIndex,
    parseRunInfoFromFilename,
    downsampleDashboardRows,
    optimizeDashboardRows,
    evaluateSamplingFidelity,
    buildMergedCleanedCsv,
    buildGeojsonBlob,
    detectStatisticalEvents,
    calculateAoiBounds,
    mergeAoiBounds,
    finalizeAoiBounds
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDataPipeline);
  } else {
    initDataPipeline();
  }
})();
