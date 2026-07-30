import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Footprints, Moon, RefreshCw, Sun, User } from 'lucide-react';
import {
  fetchCompareRows,
  fetchPatientInclusion,
  fetchSessionDetail,
  fetchSessions,
  fetchTrialRows,
  fetchTrialsSummary,
  refreshIndex,
} from './api';
import type { CompareRow, PatientTrialSummary, SessionPayload, SessionRow, TrialRow } from './types';
import { Controls } from './components/Controls';
import { SessionSetupCard } from './components/SessionSetupCard';
import { QualityIndicators } from './components/QualityIndicators';
import { PlaybackControls } from './components/PlaybackControls';
import { Trajectory2D } from './components/Trajectory2D';
import { OrientationBox3D } from './components/OrientationBox3D';
import { SessionTrialMetricsCard } from './components/SessionTrialMetricsCard';
import {
  ClosestAndFeedbackChart,
  DistanceChart,
  FeedbackIntensityChart,
  IntensityDistanceChart,
  OrientationAnglesChart,
  SpeedChart,
} from './components/TimeSeriesCharts';
import { TrialsPanel } from './components/TrialsPanel';
import { GeneralStatisticsPanel } from './components/GeneralStatisticsPanel';
import { ProfilesTable, SessionStatusTable } from './components/SessionTables';
import './styles.css';

export type AnalysisMode = 'single' | 'trials' | 'general';
type Theme = 'light' | 'dark';

function firstOrEmpty(values: string[]) {
  return values.length ? values[0] : '';
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function finiteMax(values: unknown[]) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : 0;
}

function payloadDuration(payload: SessionPayload | null) {
  if (!payload) return 0;
  const metricDuration = payload.metrics.duration_s;
  if (typeof metricDuration === 'number' && Number.isFinite(metricDuration) && metricDuration > 0) return metricDuration;
  return finiteMax([
    ...payload.tracking.map((p) => p.t_s),
    ...payload.distances.map((p) => p.t_s),
    ...payload.closest.map((p) => p.t_s),
    ...payload.feedback.map((p) => p.t_s),
    ...payload.speed.map((p) => p.t_s),
  ]);
}

function sortSessions(rows: SessionRow[]) {
  return [...rows].sort((a, b) => `${a.path_id}-${a.phase}-${a.start_time}`.localeCompare(`${b.path_id}-${b.phase}-${b.start_time}`));
}

function initialTheme(): Theme {
  const stored = window.localStorage.getItem('omnitrack-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [phaseOverlayPayloads, setPhaseOverlayPayloads] = useState<SessionPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [phaseOverlayLoading, setPhaseOverlayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('single');

  const [selectedPatient, setSelectedPatient] = useState('');
  const [selectedCondition, setSelectedCondition] = useState('');
  const [selectedPhase, setSelectedPhase] = useState('learning');
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const [alpha, setAlpha] = useState(0.2);
  const [smoothTrajectory, setSmoothTrajectory] = useState(true);
  const [showCookedOverlay, setShowCookedOverlay] = useState(true);
  const [smoothOnlySeeker, setSmoothOnlySeeker] = useState(true);
  const [showPhaseOverlay, setShowPhaseOverlay] = useState(false);

  const [globalPlayback, setGlobalPlayback] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('omnitrack-theme', theme);
  }, [theme]);

  async function loadSessions() {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchSessions();
      setSessions(rows);
      const patients = uniq(rows.map((s) => s.patient));
      const patient = selectedPatient || firstOrEmpty(patients);
      const conditions = uniq(rows.filter((s) => !patient || s.patient === patient).map((s) => s.condition));
      const condition = selectedCondition || firstOrEmpty(conditions);
      setSelectedPatient(patient);
      setSelectedCondition(condition);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const validConditions = uniq(sessions.filter((s) => !selectedPatient || s.patient === selectedPatient).map((s) => s.condition));
    if (validConditions.length && !validConditions.includes(selectedCondition)) {
      setSelectedCondition(validConditions[0]);
    }
  }, [sessions, selectedPatient, selectedCondition]);

  // Phase has no "all" option: fall back to the first phase that actually has sessions.
  useEffect(() => {
    const validPhases = uniq(
      sessions
        .filter((s) => !selectedPatient || s.patient === selectedPatient)
        .filter((s) => !selectedCondition || s.condition === selectedCondition)
        .map((s) => s.phase)
    );
    if (validPhases.length && !validPhases.includes(selectedPhase)) {
      setSelectedPhase(validPhases.includes('learning') ? 'learning' : validPhases[0]);
    }
  }, [sessions, selectedPatient, selectedCondition, selectedPhase]);

  // Path has no "all" option either: default to the first available path.
  useEffect(() => {
    const validPaths = uniq(
      sessions
        .filter((s) => !selectedPatient || s.patient === selectedPatient)
        .filter((s) => !selectedCondition || s.condition === selectedCondition)
        .filter((s) => s.phase === selectedPhase)
        .map((s) => s.path_id)
    );
    if (validPaths.length && !validPaths.includes(selectedPath)) {
      setSelectedPath(validPaths[0]);
    }
  }, [sessions, selectedPatient, selectedCondition, selectedPhase, selectedPath]);

  // ---------------------------------------------------------------------
  // Bulk data shared by the Trial metrics and General statistics tabs —
  // fetched once here (not inside either tab) so switching tabs doesn't
  // re-trigger the slow (tens of seconds) bulk trial-trajectory computation.
  // ---------------------------------------------------------------------
  const allPatients = useMemo(() => uniq(sessions.map((s) => s.patient)), [sessions]);

  const [patientSummaries, setPatientSummaries] = useState<PatientTrialSummary[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchTrialsSummary(undefined, controller.signal).then(setPatientSummaries).catch(() => {});
    return () => controller.abort();
  }, []);
  // Manual lost/not-lost annotations change this count server-side, but the
  // fetch above only runs once on mount — refresh it after every save so the
  // "N/M trials lost" badge doesn't go stale.
  const refreshPatientSummaries = useCallback(() => {
    fetchTrialsSummary().then(setPatientSummaries).catch(() => {});
  }, []);

  const [bulkSessionRows, setBulkSessionRows] = useState<CompareRow[]>([]);
  const [bulkSessionRowsLoaded, setBulkSessionRowsLoaded] = useState(false);
  useEffect(() => {
    if (!allPatients.length) { setBulkSessionRows([]); return; }
    let cancelled = false;
    fetchCompareRows({ patients: allPatients, phase: 'all', includeSuspicious: true })
      .then((rows) => { if (!cancelled) { setBulkSessionRows(rows); setBulkSessionRowsLoaded(true); } })
      .catch(() => { if (!cancelled) setBulkSessionRowsLoaded(true); });
    return () => { cancelled = true; };
  }, [allPatients]);

  const [bulkTrialRows, setBulkTrialRows] = useState<TrialRow[]>([]);
  const [bulkTrialRowsLoaded, setBulkTrialRowsLoaded] = useState(false);
  useEffect(() => {
    if (!allPatients.length) { setBulkTrialRows([]); return; }
    let cancelled = false;
    fetchTrialRows({ includeSuspicious: true })
      .then((rowsResult) => { if (!cancelled) { setBulkTrialRows(rowsResult); setBulkTrialRowsLoaded(true); } })
      .catch(() => { if (!cancelled) setBulkTrialRowsLoaded(true); });
    return () => { cancelled = true; };
  }, [allPatients]);

  const bulkDataLoading = !bulkSessionRowsLoaded || !bulkTrialRowsLoaded;

  // Per-patient opt-out from General statistics, persisted on the backend —
  // the save call itself lives in TrialsPanel (next to the checkbox), this
  // just keeps the shared in-memory map in sync for GeneralStatisticsPanel.
  const [inclusion, setInclusionState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    fetchPatientInclusion().then(setInclusionState).catch(() => {});
  }, []);
  const setInclusion = useCallback((patient: string, included: boolean) => {
    setInclusionState((prev) => ({ ...prev, [patient]: included }));
  }, []);

  // Per-trial "exclude from statistics" (hardware error / bad trial) — same
  // save-instantly, apply-on-top-of-last-fetch pattern as inclusion above,
  // keyed per attempt so the underlying annotation save (in TrialsPanel) and
  // this shared override map agree on which attempt was flagged.
  const [excludedTrialOverrides, setExcludedTrialOverrides] = useState<Record<string, boolean>>({});
  const setTrialExcluded = useCallback((patient: string, condition: string, pathId: string, explorationSessionId: number | null, excluded: boolean) => {
    setExcludedTrialOverrides((prev) => ({ ...prev, [`${patient}|${condition}|${pathId}|${explorationSessionId ?? 'none'}`]: excluded }));
  }, []);

  const filteredSessions = useMemo(() => {
    return sortSessions(
      sessions
        .filter((s) => !selectedPatient || s.patient === selectedPatient)
        .filter((s) => !selectedCondition || s.condition === selectedCondition)
        .filter((s) => s.phase === selectedPhase)
        .filter((s) => !selectedPath || s.path_id === selectedPath)
    );
  }, [sessions, selectedPatient, selectedCondition, selectedPhase, selectedPath]);

  useEffect(() => {
    if (!filteredSessions.length) {
      if (selectedSessionId !== null) setSelectedSessionId(null);
      return;
    }
    if (selectedSessionId === null || !filteredSessions.some((s) => s.session_id === selectedSessionId)) {
      setSelectedSessionId(filteredSessions[0].session_id);
    }
  }, [filteredSessions, selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId === null || analysisMode !== 'single') {
      if (selectedSessionId === null) setPayload(null);
      return;
    }

    const controller = new AbortController();

    async function loadDetail() {
      setDetailLoading(true);
      setError(null);
      try {
        const detail = await fetchSessionDetail(
          selectedSessionId as number,
          alpha,
          smoothTrajectory,
          smoothOnlySeeker,
          1200,
          controller.signal,
        );
        setPayload(detail);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }

    loadDetail();
    return () => controller.abort();
  }, [selectedSessionId, alpha, smoothTrajectory, smoothOnlySeeker, analysisMode]);

  const duration = useMemo(() => payloadDuration(payload), [payload]);

  useEffect(() => {
    setIsPlaying(false);
    setPlaybackTime(0);
  }, [selectedSessionId]);

  useEffect(() => {
    setPlaybackTime((prev) => Math.max(0, Math.min(duration, prev)));
  }, [duration]);

  useEffect(() => {
    if (!isPlaying || !globalPlayback || !duration) return;

    let last = performance.now();

    const step = (now: number) => {
      const delta = ((now - last) / 1000) * playbackSpeed;
      last = now;

      setPlaybackTime((prev) => {
        const next = Math.min(duration, Math.max(0, prev + delta));
        if (next >= duration) {
          window.setTimeout(() => setIsPlaying(false), 0);
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [duration, globalPlayback, isPlaying, playbackSpeed]);

  const handleCursorTime = useCallback((next: number) => {
    if (!globalPlayback || !Number.isFinite(next)) return;
    setIsPlaying(false);
    setPlaybackTime((prev) => Math.abs(prev - next) < 0.05 ? prev : Math.max(0, Math.min(duration, next)));
  }, [duration, globalPlayback]);

  const currentSession = sessions.find((s) => s.session_id === selectedSessionId) ?? null;

  // Trial metrics (overlap, turn deviation, stops, border...) for whichever
  // (patient, condition, path) trial the currently selected session belongs to.
  const [sessionTrialRows, setSessionTrialRows] = useState<TrialRow[]>([]);
  useEffect(() => {
    if (!selectedPatient || !selectedCondition || !selectedPath) { setSessionTrialRows([]); return; }
    const controller = new AbortController();
    fetchTrialRows({ patients: [selectedPatient], condition: selectedCondition, pathId: selectedPath, includeSuspicious: true, signal: controller.signal })
      .then(setSessionTrialRows)
      .catch((e) => { if (!(e instanceof DOMException && e.name === 'AbortError')) setSessionTrialRows([]); });
    return () => controller.abort();
  }, [selectedPatient, selectedCondition, selectedPath]);

  const phaseOverlaySessionIds = useMemo(() => {
    if (!currentSession) return [] as number[];
    const sameBlock = sortSessions(
      sessions.filter((s) =>
        s.patient === currentSession.patient
        && s.condition === currentSession.condition
        && s.path_id === currentSession.path_id
        && (s.phase === 'learning' || s.phase === 'exploration')
      )
    );

    const byPhase = new Map<string, SessionRow>();
    for (const phase of ['learning', 'exploration']) {
      const currentForPhase = currentSession.phase === phase ? currentSession : null;
      const firstForPhase = sameBlock.find((s) => s.phase === phase) ?? null;
      const selected = currentForPhase ?? firstForPhase;
      if (selected) byPhase.set(phase, selected);
    }

    return Array.from(byPhase.values()).map((s) => s.session_id);
  }, [currentSession, sessions]);

  useEffect(() => {
    if (!showPhaseOverlay || !phaseOverlaySessionIds.length || analysisMode !== 'single') {
      setPhaseOverlayPayloads([]);
      return;
    }

    const controller = new AbortController();
    setPhaseOverlayLoading(true);

    Promise.all(
      phaseOverlaySessionIds.map((id) => fetchSessionDetail(
        id,
        alpha,
        smoothTrajectory,
        smoothOnlySeeker,
        1200,
        controller.signal,
      ))
    )
      .then((rows) => setPhaseOverlayPayloads(rows))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPhaseOverlayLoading(false);
      });

    return () => controller.abort();
  }, [alpha, phaseOverlaySessionIds, showPhaseOverlay, smoothOnlySeeker, smoothTrajectory, analysisMode]);

  async function handleRefresh() {
    setError(null);
    try {
      await refreshIndex();
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) {
    return (
      <main className="appShell">
        <div className="loading"><RefreshCw className="spin" /> Loading sessions...</div>
      </main>
    );
  }

  const controlledTime = globalPlayback ? playbackTime : null;

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">Omnitrack research dashboard</p>
          <h1>Session analytics: trajectory, feedback, learning vs exploration</h1>
          <p>
            Interactive dashboard with a global time cursor: trajectory, distances, feedback and speed fill together as you scrub or play.
          </p>
        </div>
        <div className="heroSide">
          <button
            type="button"
            className="themeToggle"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <div className="heroMeta">
            <strong>{sessions.length}</strong>
            <span>indexed sessions</span>
          </div>
        </div>
      </header>

      {error ? <div className="errorBox">{error}</div> : null}

      <div className="modeSwitch" role="tablist" aria-label="Analysis mode">
        <button
          type="button"
          role="tab"
          aria-selected={analysisMode === 'single'}
          className={analysisMode === 'single' ? 'active' : ''}
          onClick={() => setAnalysisMode('single')}
        >
          <User size={16} />
          <span>
            <strong>Single session analysis</strong>
            <small>One patient, one session: trajectory, playback and detailed charts</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={analysisMode === 'trials'}
          className={analysisMode === 'trials' ? 'active' : ''}
          onClick={() => setAnalysisMode('trials')}
        >
          <Footprints size={16} />
          <span>
            <strong>Trial metrics</strong>
            <small>Exploration vs. learning: overlap, turns, stops, border, lost trials</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={analysisMode === 'general'}
          className={analysisMode === 'general' ? 'active' : ''}
          onClick={() => setAnalysisMode('general')}
        >
          <BarChart3 size={16} />
          <span>
            <strong>General statistics</strong>
            <small>Combined totals across every included patient</small>
          </span>
        </button>
      </div>

      {analysisMode === 'single' ? (
        <Controls
          sessions={sessions}
          selectedPatient={selectedPatient}
          selectedCondition={selectedCondition}
          selectedPhase={selectedPhase}
          selectedPath={selectedPath}
          selectedSessionId={selectedSessionId}
          alpha={alpha}
          smoothTrajectory={smoothTrajectory}
          showCookedOverlay={showCookedOverlay}
          smoothOnlySeeker={smoothOnlySeeker}
          onPatient={setSelectedPatient}
          onCondition={setSelectedCondition}
          onPhase={setSelectedPhase}
          onPath={setSelectedPath}
          onSession={setSelectedSessionId}
          onAlpha={setAlpha}
          onSmoothTrajectory={setSmoothTrajectory}
          onShowCookedOverlay={setShowCookedOverlay}
          onSmoothOnlySeeker={setSmoothOnlySeeker}
          onRefresh={handleRefresh}
        />
      ) : null}

      {/* Always mounted (just hidden) rather than swapped in/out with the other
          tabs — both are pure presentational components over the bulk data
          fetched in App, so this costs nothing extra, and it means switching
          Trials <-> General <-> Single no longer resets which pp_XX dropdowns
          are open or the trajectory data already loaded inside them. */}
      <div className={analysisMode === 'trials' ? undefined : 'hiddenPanel'}>
        <TrialsPanel
          sessions={sessions}
          sessionRows={bulkSessionRows}
          allTrialRows={bulkTrialRows}
          patientSummaries={patientSummaries}
          dataLoading={bulkDataLoading}
          onRefreshPatientSummaries={refreshPatientSummaries}
          inclusion={inclusion}
          onSetInclusion={setInclusion}
          excludedTrialOverrides={excludedTrialOverrides}
          onSetTrialExcluded={setTrialExcluded}
        />
      </div>
      <div className={analysisMode === 'general' ? undefined : 'hiddenPanel'}>
        <GeneralStatisticsPanel
          sessions={sessions}
          sessionRows={bulkSessionRows}
          trialRows={bulkTrialRows}
          patientSummaries={patientSummaries}
          inclusion={inclusion}
          dataLoading={bulkDataLoading}
          excludedTrialOverrides={excludedTrialOverrides}
        />
      </div>
      {analysisMode === 'single' ? (
        <>
          <SessionSetupCard session={currentSession} payload={payload} />

          {detailLoading ? <div className="loading inlineLoading"><RefreshCw className="spin" /> Updating charts...</div> : null}
          {phaseOverlayLoading ? <div className="loading inlineLoading"><RefreshCw className="spin" /> Loading learning/exploration overlay...</div> : null}

          {payload ? <QualityIndicators payload={payload} /> : null}

          {payload ? (
            <PlaybackControls
              duration={duration}
              time={playbackTime}
              playing={isPlaying}
              speed={playbackSpeed}
              globalEnabled={globalPlayback}
              onTime={setPlaybackTime}
              onPlaying={setIsPlaying}
              onSpeed={setPlaybackSpeed}
              onGlobalEnabled={setGlobalPlayback}
            />
          ) : null}

          {payload ? (
            <div className="chartWithStats">
              <Trajectory2D
                payload={payload}
                showCookedOverlay={showCookedOverlay}
                playbackTime={controlledTime}
                duration={duration}
                onCursorTime={handleCursorTime}
                phaseOverlayPayloads={phaseOverlayPayloads}
                onShowPhaseOverlay={setShowPhaseOverlay}
              />
              <div className="statsStack">
                <SessionTrialMetricsCard
                  payload={payload}
                  phaseOverlayPayloads={phaseOverlayPayloads}
                  trialRows={sessionTrialRows}
                  sessions={sessions}
                />
                <OrientationBox3D
                  payload={payload}
                  phaseOverlayPayloads={phaseOverlayPayloads}
                  playbackTime={controlledTime}
                  duration={duration}
                />
              </div>
            </div>
          ) : null}

          <section className="dashboardGrid">
            {payload ? (
              <>
                <OrientationAnglesChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <DistanceChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <ClosestAndFeedbackChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <FeedbackIntensityChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <IntensityDistanceChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <SpeedChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
                <ProfilesTable payload={payload} />
              </>
            ) : (
              <section className="card span2"><div className="emptyState">No session selected.</div></section>
            )}

            <SessionStatusTable sessions={sessions} />
          </section>
        </>
      ) : null}
    </main>
  );
}
