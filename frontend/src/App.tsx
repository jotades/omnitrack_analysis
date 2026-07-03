import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchCompareRows, fetchSessionDetail, fetchSessions, refreshIndex } from './api';
import type { CompareRow, SessionPayload, SessionRow } from './types';
import { Controls } from './components/Controls';
import { MetricCards } from './components/MetricCards';
import { PlaybackControls } from './components/PlaybackControls';
import { Trajectory2D } from './components/Trajectory2D';
import {
  ClosestAndFeedbackChart,
  DistanceChart,
  FeedbackIntensityChart,
  IntensityDistanceChart,
  SpeedChart,
} from './components/TimeSeriesCharts';
import { ComparisonPanel } from './components/ComparisonPanel';
import { ProfilesTable, SessionStatusTable } from './components/SessionTables';
import './styles.css';

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

export default function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [phaseOverlayPayloads, setPhaseOverlayPayloads] = useState<SessionPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [phaseOverlayLoading, setPhaseOverlayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedPatient, setSelectedPatient] = useState('');
  const [selectedCondition, setSelectedCondition] = useState('');
  const [selectedPhase, setSelectedPhase] = useState('all');
  const [selectedPath, setSelectedPath] = useState('all');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const [alpha, setAlpha] = useState(0.2);
  const [smoothTrajectory, setSmoothTrajectory] = useState(true);
  const [showCookedOverlay, setShowCookedOverlay] = useState(true);
  const [smoothOnlySeeker, setSmoothOnlySeeker] = useState(true);
  const [compareMode, setCompareMode] = useState('single');
  const [selectedComparePatients, setSelectedComparePatients] = useState<string[]>([]);
  const [includeSuspicious, setIncludeSuspicious] = useState(true);
  const [showPhaseOverlay, setShowPhaseOverlay] = useState(false);

  const [globalPlayback, setGlobalPlayback] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);

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
      setSelectedComparePatients((old) => old.length ? old : patients.slice(0, Math.min(3, patients.length)));
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
      setSelectedPath('all');
    }
  }, [sessions, selectedPatient, selectedCondition]);

  useEffect(() => {
    const validPaths = ['all', ...uniq(
      sessions
        .filter((s) => !selectedPatient || s.patient === selectedPatient)
        .filter((s) => !selectedCondition || s.condition === selectedCondition)
        .filter((s) => selectedPhase === 'all' || s.phase === selectedPhase)
        .map((s) => s.path_id)
    )];
    if (!validPaths.includes(selectedPath)) {
      setSelectedPath('all');
    }
  }, [sessions, selectedPatient, selectedCondition, selectedPhase, selectedPath]);

  const filteredSessions = useMemo(() => {
    return sortSessions(
      sessions
        .filter((s) => !selectedPatient || s.patient === selectedPatient)
        .filter((s) => !selectedCondition || s.condition === selectedCondition)
        .filter((s) => selectedPhase === 'all' || s.phase === selectedPhase)
        .filter((s) => selectedPath === 'all' || s.path_id === selectedPath)
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
    if (selectedSessionId === null) {
      setPayload(null);
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
  }, [selectedSessionId, alpha, smoothTrajectory, smoothOnlySeeker]);

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

  useEffect(() => {
    async function loadCompare() {
      if (compareMode === 'single') {
        setCompareRows([]);
        return;
      }
      try {
        const rows = await fetchCompareRows({
          patients: compareMode === 'users' ? selectedComparePatients : [selectedPatient],
          condition: selectedCondition,
          pathId: selectedPath,
          phase: compareMode === 'phase' ? 'all' : selectedPhase,
          includeSuspicious,
        });
        setCompareRows(rows);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    loadCompare();
  }, [compareMode, selectedComparePatients, selectedPatient, selectedCondition, selectedPath, selectedPhase, includeSuspicious]);

  const currentSession = sessions.find((s) => s.session_id === selectedSessionId) ?? null;

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
    if (!showPhaseOverlay || !phaseOverlaySessionIds.length) {
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
  }, [alpha, phaseOverlaySessionIds, showPhaseOverlay, smoothOnlySeeker, smoothTrajectory]);

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
        <div className="loading"><RefreshCw className="spin" /> Caricamento sessioni...</div>
      </main>
    );
  }

  const controlledTime = globalPlayback ? playbackTime : null;

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">Jota research dashboard</p>
          <h1>Session analytics: trajectory, feedback, learning vs exploration</h1>
          <p>
            Dashboard React/Recharts con playback temporale globale: il cursore riempie insieme traiettoria, distanze, feedback e velocità.
          </p>
        </div>
        <div className="heroMeta">
          <strong>{sessions.length}</strong>
          <span>sessioni indicizzate</span>
        </div>
      </header>

      {error ? <div className="errorBox">{error}</div> : null}

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
        compareMode={compareMode}
        selectedComparePatients={selectedComparePatients}
        includeSuspicious={includeSuspicious}
        showPhaseOverlay={showPhaseOverlay}
        onPatient={(v) => { setSelectedPatient(v); setSelectedPath('all'); }}
        onCondition={(v) => { setSelectedCondition(v); setSelectedPath('all'); }}
        onPhase={setSelectedPhase}
        onPath={setSelectedPath}
        onSession={setSelectedSessionId}
        onAlpha={setAlpha}
        onSmoothTrajectory={setSmoothTrajectory}
        onShowCookedOverlay={setShowCookedOverlay}
        onSmoothOnlySeeker={setSmoothOnlySeeker}
        onCompareMode={setCompareMode}
        onComparePatients={setSelectedComparePatients}
        onIncludeSuspicious={setIncludeSuspicious}
        onShowPhaseOverlay={setShowPhaseOverlay}
        onRefresh={handleRefresh}
      />

      {currentSession ? (
        <section className="sessionBanner">
          <div>
            <strong>{currentSession.patient}</strong> / {currentSession.phase} / {currentSession.condition_label} / {currentSession.path_id}
          </div>
          <span>{currentSession.warning}</span>
        </section>
      ) : null}

      {detailLoading ? <div className="loading inlineLoading"><RefreshCw className="spin" /> Aggiorno grafici...</div> : null}
      {phaseOverlayLoading ? <div className="loading inlineLoading"><RefreshCw className="spin" /> Carico overlay learning/exploration...</div> : null}

      {payload ? <MetricCards metrics={payload.metrics} /> : null}

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

      <section className="dashboardGrid">
        {compareMode !== 'single' ? <ComparisonPanel rows={compareRows} mode={compareMode} /> : null}

        {payload ? (
          <>
            <Trajectory2D
              payload={payload}
              showCookedOverlay={showCookedOverlay}
              playbackTime={controlledTime}
              duration={duration}
              onCursorTime={handleCursorTime}
              phaseOverlayPayloads={phaseOverlayPayloads}
              showPhaseOverlay={showPhaseOverlay}
              onShowPhaseOverlay={setShowPhaseOverlay}
            />
            <DistanceChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
            <ClosestAndFeedbackChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
            <FeedbackIntensityChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
            <IntensityDistanceChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
            <SpeedChart payload={payload} playbackTime={controlledTime} duration={duration} onCursorTime={handleCursorTime} />
            <ProfilesTable payload={payload} />
          </>
        ) : (
          <section className="card span2"><div className="emptyState">Nessuna sessione selezionata.</div></section>
        )}

        <SessionStatusTable sessions={sessions} />
      </section>
    </main>
  );
}
