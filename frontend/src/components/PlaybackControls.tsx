import { useCallback, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react';

interface Props {
  duration: number;
  time: number;
  playing: boolean;
  speed: number;
  globalEnabled: boolean;
  onTime: (time: number) => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: number) => void;
  onGlobalEnabled: (enabled: boolean) => void;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return '0.0 s';
  return `${value.toFixed(1)} s`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function PlaybackScrubber({
  duration,
  time,
  disabled,
  onTime,
  onPlaying,
}: {
  duration: number;
  time: number;
  disabled: boolean;
  onTime: (time: number) => void;
  onPlaying: (playing: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const safeTime = clamp(Number.isFinite(time) ? time : 0, 0, safeDuration);
  const percentage = safeDuration > 0 ? (safeTime / safeDuration) * 100 : 0;

  const updateFromClientX = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !safeDuration || disabled) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    onPlaying(false);
    onTime(ratio * safeDuration);
  }, [disabled, onPlaying, onTime, safeDuration]);

  return (
    <div className={`scrubber ${dragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`}>
      <span className="scrubberTime">{formatTime(safeTime)}</span>
      <div
        ref={trackRef}
        className="scrubberTrack"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={0}
        aria-valuemax={safeDuration}
        aria-valuenow={safeTime}
        aria-label="Timeline playback globale"
        onPointerDown={(event) => {
          if (disabled) return;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!dragging || disabled) return;
          updateFromClientX(event.clientX);
        }}
        onPointerUp={(event) => {
          setDragging(false);
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
          updateFromClientX(event.clientX);
        }}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(event) => {
          if (disabled || !safeDuration) return;
          const smallStep = Math.max(0.05, safeDuration / 200);
          const bigStep = Math.max(0.5, safeDuration / 20);
          if (event.key === 'ArrowLeft') { event.preventDefault(); onPlaying(false); onTime(clamp(safeTime - smallStep, 0, safeDuration)); }
          if (event.key === 'ArrowRight') { event.preventDefault(); onPlaying(false); onTime(clamp(safeTime + smallStep, 0, safeDuration)); }
          if (event.key === 'PageDown') { event.preventDefault(); onPlaying(false); onTime(clamp(safeTime - bigStep, 0, safeDuration)); }
          if (event.key === 'PageUp') { event.preventDefault(); onPlaying(false); onTime(clamp(safeTime + bigStep, 0, safeDuration)); }
          if (event.key === 'Home') { event.preventDefault(); onPlaying(false); onTime(0); }
          if (event.key === 'End') { event.preventDefault(); onPlaying(false); onTime(safeDuration); }
        }}
      >
        <div className="scrubberFill" style={{ width: `${percentage}%` }} />
        <div className="scrubberThumb" style={{ left: `${percentage}%` }} />
      </div>
      <span className="scrubberTime end">{formatTime(safeDuration)}</span>
    </div>
  );
}

export function PlaybackControls({
  duration,
  time,
  playing,
  speed,
  globalEnabled,
  onTime,
  onPlaying,
  onSpeed,
  onGlobalEnabled,
}: Props) {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const safeTime = Math.min(safeDuration, Math.max(0, Number.isFinite(time) ? time : 0));

  return (
    <section className="card playbackPanel">
      <div className="playbackHeader">
        <div>
          <strong>Playback globale</strong>
          <p>La timeline sotto controlla tutti i grafici insieme. Trascina avanti o indietro senza resettare la sessione.</p>
        </div>
        <label className="switchLabel">
          <input type="checkbox" checked={globalEnabled} onChange={(e) => onGlobalEnabled(e.target.checked)} />
          Usa cursore globale
        </label>
      </div>

      <div className="playbackControlsRow">
        <div className="playbackButtons">
          <button
            type="button"
            className="iconButton"
            onClick={() => {
              if (safeTime >= safeDuration - 0.05) onTime(0);
              onPlaying(!playing);
            }}
            disabled={!safeDuration || !globalEnabled}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
            {playing ? 'Pausa' : 'Play'}
          </button>

          <button type="button" className="iconButton" onClick={() => { onTime(0); onPlaying(false); }} disabled={!safeDuration || !globalEnabled}>
            <RotateCcw size={18} />
            Reset
          </button>

          <button type="button" className="iconButton" onClick={() => { onTime(safeDuration); onPlaying(false); }} disabled={!safeDuration || !globalEnabled}>
            <SkipForward size={18} />
            Fine
          </button>
        </div>

        <PlaybackScrubber
          duration={safeDuration}
          time={safeTime}
          disabled={!safeDuration || !globalEnabled}
          onTime={onTime}
          onPlaying={onPlaying}
        />

        <label className="speedSelect">
          Velocità
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} disabled={!globalEnabled}>
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
            <option value={8}>8×</option>
          </select>
        </label>
      </div>
    </section>
  );
}
