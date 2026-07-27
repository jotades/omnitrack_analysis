import { useEffect, useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { SessionPayload, TrackingPoint } from '../types';
import { ChartCard } from './ChartCard';
import { type Phase, PhaseToggle, phaseOf, payloadForPhase } from './PhaseToggle';

/**
 * 3D box driven by the raw IMU quaternion of the seeker tag, so you can see
 * how the sensor is physically held in the hand (roll/pitch/yaw), not just
 * the walking-direction arrow of the 2D trajectory.
 *
 * Drawn with a plain orthographic SVG projection (no 3D library):
 * quaternion → rotation matrix → rotate vertices → painter-sort faces.
 * Around the device there is a STATIC gimbal sphere: the trails of dots on it
 * are where the sensor's forward (X, red) and top (Z, blue) axes pointed over
 * the session — a tight cluster means the device was held steady, a cluster
 * away from the pole/equator means it was held at an angle.
 */

interface Props {
  payload: SessionPayload;
  /** Learning/exploration payloads for the same patient/condition/path, when
   * preloaded (the "Learning"/"Exploration" flags on the 2D room trajectory
   * chart) — lets this card show either phase, not just whichever session is
   * currently selected. */
  phaseOverlayPayloads?: SessionPayload[];
  playbackTime?: number | null;
  duration?: number;
}

interface Quat { x: number; y: number; z: number; w: number }
type Vec3 = [number, number, number];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function quatOf(p: TrackingPoint): Quat | null {
  if (isFiniteNumber(p.qx) && isFiniteNumber(p.qy) && isFiniteNumber(p.qz) && isFiniteNumber(p.qw)) {
    return { x: p.qx, y: p.qy, z: p.qz, w: p.qw };
  }
  return null;
}

/** Normalised linear interpolation — fine for the small steps between samples. */
function nlerp(a: Quat, b: Quat, t: number): Quat {
  // Take the short way around: flip sign if the quaternions are on opposite hemispheres.
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dot < 0 ? -1 : 1;
  const x = a.x + (s * b.x - a.x) * t;
  const y = a.y + (s * b.y - a.y) * t;
  const z = a.z + (s * b.z - a.z) * t;
  const w = a.w + (s * b.w - a.w) * t;
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/** Rotation matrix (columns = sensor axes expressed in room coordinates). */
function quatToMatrix(q: Quat): number[][] {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

function eulerDeg(q: Quat) {
  const { x, y, z, w } = q;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const d = 180 / Math.PI;
  return { yaw: yaw * d, pitch: pitch * d, roll: roll * d };
}

function yawOfQuat(q: Quat): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * (180 / Math.PI);
}

/** Rotate a room-frame vector by -deg about the vertical axis. */
function rotateZVec(v: Vec3, deg: number): Vec3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

function mulMatVec(m: number[][], v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// Real device: 60 mm (length, sensor X) × 40 mm (width, Y) × 45 mm (height, Z).
// Scaled to scene units (factor 0.014 units/mm), half-extents:
const HX = (60 / 2) * 0.014;
const HY = (40 / 2) * 0.014;
const HZ = (45 / 2) * 0.014;

const CORNERS: Vec3[] = [
  [-HX, -HY, -HZ], [HX, -HY, -HZ], [HX, HY, -HZ], [-HX, HY, -HZ],
  [-HX, -HY, HZ], [HX, -HY, HZ], [HX, HY, HZ], [-HX, HY, HZ],
];

// Faces as corner indices + outward normal in the sensor frame.
const FACES: Array<{ idx: [number, number, number, number]; normal: Vec3; front?: boolean }> = [
  { idx: [1, 2, 6, 5], normal: [1, 0, 0], front: true }, // +X: forward
  { idx: [0, 3, 7, 4], normal: [-1, 0, 0] },
  { idx: [2, 3, 7, 6], normal: [0, 1, 0] },
  { idx: [0, 1, 5, 4], normal: [0, -1, 0] },
  { idx: [4, 5, 6, 7], normal: [0, 0, 1] }, // +Z: top
  { idx: [0, 1, 2, 3], normal: [0, 0, -1] },
];

const SPHERE_RADIUS = 0.85;
const RING_SEGMENTS = 48;
const MAX_TRAIL_POINTS = 350;

interface Projector {
  toScreen: (v: Vec3) => { x: number; y: number; depth: number };
}

function makeProjector(azimuthDeg: number, elevationDeg: number, cx: number, cy: number, scale: number): Projector {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az);
  const ce = Math.cos(el), se = Math.sin(el);
  return {
    toScreen(v: Vec3) {
      const x1 = v[0] * ca + v[1] * sa;
      const y1 = -v[0] * sa + v[1] * ca;
      const up = v[2] * ce - y1 * se;
      const depth = y1 * ce + v[2] * se;
      return { x: cx + x1 * scale, y: cy - up * scale, depth };
    },
  };
}

function ringPath(proj: Projector, point: (t: number) => Vec3): string {
  const parts: string[] = [];
  for (let i = 0; i <= RING_SEGMENTS; i += 1) {
    const t = (i / RING_SEGMENTS) * Math.PI * 2;
    const p = proj.toScreen(point(t));
    parts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return parts.join('');
}

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(Math.min(255, ((n >> 16) & 255) * factor));
  const g = Math.round(Math.min(255, ((n >> 8) & 255) * factor));
  const b = Math.round(Math.min(255, (n & 255) * factor));
  return `rgb(${r}, ${g}, ${b})`;
}

const LIGHT: Vec3 = [0.35, -0.5, 0.79]; // roughly from above-left, normalised-ish

function fmtDeg(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}°`;
}

const W = 470;
const H = 340;
const CX = W / 2;
const CY = H / 2 + 10;
const SCALE = 100;
const GROUND_Z = -1.05;
const COMPASS_RADIUS = 1.28;

export function OrientationBox3D({ payload, phaseOverlayPayloads = [], playbackTime, duration = 0 }: Props) {
  const [walkingFrame, setWalkingFrame] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [view, setView] = useState({ azimuth: -32, elevation: 22 });
  const [localTime, setLocalTime] = useState<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; azimuth: number; elevation: number } | null>(null);

  const currentPhase = phaseOf(payload);
  const availability = {
    learning: !!payloadForPhase('learning', payload, phaseOverlayPayloads),
    exploration: !!payloadForPhase('exploration', payload, phaseOverlayPayloads),
  };
  // Prefer exploration by default (once loaded) — that's the phase this card
  // is usually asked about. Recomputed live, so it switches over the moment
  // the exploration payload finishes loading, without fighting a manual pick.
  const preferredPhase: Phase | null = availability.exploration ? 'exploration' : availability.learning ? 'learning' : currentPhase;

  // A manual click sticks until a different session is selected elsewhere.
  const [manualPhase, setManualPhase] = useState<Phase | null>(null);
  useEffect(() => { setManualPhase(null); }, [payload.summary?.file]);

  const selectedPhase = manualPhase ?? preferredPhase;
  const effectivePayload = (selectedPhase && payloadForPhase(selectedPhase, payload, phaseOverlayPayloads)) ?? payload;
  const effectivePhase = phaseOf(effectivePayload);

  const seekerId = effectivePayload.config.seeker_id;
  const samples = useMemo(
    () => effectivePayload.tracking
      .filter((p) => p.tag_id === seekerId && quatOf(p) !== null && isFiniteNumber(p.t_s))
      .sort((a, b) => a.t_s - b.t_s),
    [effectivePayload.tracking, seekerId],
  );

  const maxT = samples.length ? samples[samples.length - 1].t_s : 0;
  const effectiveDuration = duration > 0 ? duration : maxT;
  const globalDriven = isFiniteNumber(playbackTime);
  const time = globalDriven
    ? Math.max(0, Math.min(effectiveDuration, playbackTime as number))
    : (localTime ?? maxT);

  const quat = useMemo(() => {
    if (!samples.length) return null;
    // Bracket `time` between two samples and nlerp for a smooth playback.
    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t_s <= time) lo = mid; else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const qa = quatOf(a)!;
    if (a === b || time <= a.t_s) return qa;
    if (time >= b.t_s) return quatOf(b)!;
    const t = (time - a.t_s) / (b.t_s - a.t_s || 1);
    return nlerp(qa, quatOf(b)!, t);
  }, [samples, time]);

  const mountingOffset = isFiniteNumber(effectivePayload.orientation?.median_offset_deg)
    ? effectivePayload.orientation!.median_offset_deg!
    : 0;

  const euler = quat ? eulerDeg(quat) : null;
  // Walking direction in room coordinates: IMU yaw minus the mounting offset
  // (same correction used by the trajectory arrow).
  const heading = euler ? euler.yaw - mountingOffset : 0;

  // Sensor X (forward) and Z (top) directions on the unit sphere for every
  // sample up to the cursor, in the selected frame. These become the dot
  // trails on the static gimbal sphere.
  const trails = useMemo(() => {
    const visible = samples.filter((s) => s.t_s <= time);
    const stride = Math.max(1, Math.ceil(visible.length / MAX_TRAIL_POINTS));
    const xTrail: Vec3[] = [];
    const zTrail: Vec3[] = [];
    for (let i = 0; i < visible.length; i += stride) {
      const q = quatOf(visible[i])!;
      const rot = quatToMatrix(q);
      let vx = mulMatVec(rot, [1, 0, 0]);
      let vz = mulMatVec(rot, [0, 0, 1]);
      if (walkingFrame) {
        const h = yawOfQuat(q) - mountingOffset;
        vx = rotateZVec(vx, -h);
        vz = rotateZVec(vz, -h);
      }
      xTrail.push(vx);
      zTrail.push(vz);
    }
    return { xTrail, zTrail };
  }, [samples, time, walkingFrame, mountingOffset]);

  const scene = useMemo(() => {
    if (!quat) return null;
    const proj = makeProjector(view.azimuth, view.elevation, CX, CY, SCALE);

    // In the walking frame the whole world is rotated so the walking direction
    // sits at azimuth 0: the compass stays put and the box shows only how the
    // device is held relative to where the person is going.
    const rot = walkingFrame
      ? (() => {
          const m = quatToMatrix(quat);
          return [
            rotateZVec([m[0][0], m[1][0], m[2][0]], -heading),
            rotateZVec([m[0][1], m[1][1], m[2][1]], -heading),
            rotateZVec([m[0][2], m[1][2], m[2][2]], -heading),
          ].reduce((acc, col, j) => {
            acc[0][j] = col[0]; acc[1][j] = col[1]; acc[2][j] = col[2];
            return acc;
          }, [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as number[][]);
        })()
      : quatToMatrix(quat);
    const northDeg = walkingFrame ? 0 : heading;

    const corners = CORNERS.map((c) => proj.toScreen(mulMatVec(rot, c)));

    const faces = FACES.map((face) => {
      const pts = face.idx.map((i) => corners[i]);
      const normal = mulMatVec(rot, face.normal);
      const lum = 0.62 + 0.38 * Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
      const base = face.front ? '#d92d20' : '#5b708a';
      return {
        points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        depth: pts.reduce((s, p) => s + p.depth, 0) / pts.length,
        fill: shade(base, lum),
      };
    }).sort((a, b) => a.depth - b.depth); // paint far faces first

    const axisLen = SPHERE_RADIUS;
    const axes = ([
      { dir: [axisLen, 0, 0] as Vec3, color: '#d92d20', label: 'X' },
      { dir: [0, axisLen, 0] as Vec3, color: '#17b26a', label: 'Y' },
      { dir: [0, 0, axisLen] as Vec3, color: '#3b5bfd', label: 'Z' },
    ]).map((axis) => {
      const end = proj.toScreen(mulMatVec(rot, axis.dir));
      return { ...axis, end };
    });

    // Static gimbal sphere: equator (level plane) + two fixed meridians.
    const R = SPHERE_RADIUS;
    const sphereRings = [
      ringPath(proj, (t) => [R * Math.cos(t), R * Math.sin(t), 0]), // equator = level
      ringPath(proj, (t) => [R * Math.cos(t), 0, R * Math.sin(t)]),
      ringPath(proj, (t) => [0, R * Math.cos(t), R * Math.sin(t)]),
    ];
    const poleTop = proj.toScreen([0, 0, R]);

    const centerDepth = proj.toScreen([0, 0, 0]).depth;
    const projectTrail = (trail: Vec3[]) => trail.map((v) => {
      const p = proj.toScreen([v[0] * R, v[1] * R, v[2] * R]);
      return { x: p.x, y: p.y, front: p.depth <= centerDepth };
    });

    // Ground compass ring: N = walking direction, E 90° clockwise from N (top view).
    const compassRing = ringPath(proj, (t) => [COMPASS_RADIUS * Math.cos(t), COMPASS_RADIUS * Math.sin(t), GROUND_Z]);
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const cardinals = ([
      { label: 'N', deg: northDeg, main: true },
      { label: 'E', deg: northDeg - 90, main: false },
      { label: 'S', deg: northDeg + 180, main: false },
      { label: 'O', deg: northDeg + 90, main: false },
    ]).map((c) => {
      const dir: Vec3 = [Math.cos(rad(c.deg)), Math.sin(rad(c.deg)), 0];
      const tickA = proj.toScreen([dir[0] * COMPASS_RADIUS * 0.92, dir[1] * COMPASS_RADIUS * 0.92, GROUND_Z]);
      const tickB = proj.toScreen([dir[0] * COMPASS_RADIUS, dir[1] * COMPASS_RADIUS, GROUND_Z]);
      const text = proj.toScreen([dir[0] * COMPASS_RADIUS * 1.16, dir[1] * COMPASS_RADIUS * 1.16, GROUND_Z]);
      return { ...c, tickA, tickB, text };
    });
    // Arrow on the ground pointing north (= walking direction).
    const nDir: Vec3 = [Math.cos(rad(northDeg)), Math.sin(rad(northDeg)), 0];
    const northArrow = {
      from: proj.toScreen([0, 0, GROUND_Z]),
      to: proj.toScreen([nDir[0] * COMPASS_RADIUS * 0.8, nDir[1] * COMPASS_RADIUS * 0.8, GROUND_Z]),
    };

    const center = proj.toScreen([0, 0, 0]);
    return {
      faces, axes, sphereRings, poleTop, compassRing, cardinals, northArrow, center,
      xTrail: projectTrail(trails.xTrail),
      zTrail: projectTrail(trails.zTrail),
    };
  }, [quat, walkingFrame, heading, view, trails]);

  const phaseToggle = <PhaseToggle selected={effectivePhase} available={availability} onSelect={setManualPhase} />;

  if (!samples.length) {
    return (
      <ChartCard title="3D sensor orientation" subtitle="How the seeker sensor is held in the hand (IMU quaternion).">
        {phaseToggle}
        <div className="emptyState chartEmpty">No IMU quaternion data for the seeker in this {effectivePhase ?? ''} session.</div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="3D sensor orientation" subtitle={`Showing ${effectivePhase ?? 'the selected'} session.`}>
      <div className="orientationBoxControls">
        {phaseToggle}
        <label className="inlineCheck">
          <input type="checkbox" checked={walkingFrame} onChange={(e) => setWalkingFrame(e.target.checked)} />
          Walking-direction frame (compass fixed)
        </label>
      </div>
      <div className="orientationBoxControls">
        {euler ? (
          <span className="orientationReadout">
            roll {fmtDeg(euler.roll)} · pitch {fmtDeg(euler.pitch)} · yaw {fmtDeg(euler.yaw)} · t = {time.toFixed(1)} s
          </span>
        ) : null}
        <button
          type="button"
          className="infoToggle"
          aria-expanded={showHint}
          aria-label="What am I looking at?"
          title="What am I looking at?"
          onClick={() => setShowHint((v) => !v)}
        >
          <Info size={14} />
        </button>
      </div>
      {showHint ? (
        <p className="orientationBoxHint">
          Seeker {seekerId} device (60×40×45 mm) at the playback cursor. Compass N = walking direction, drag to
          orbit. The static sphere is the gimbal: red dots are where the forward axis (X) pointed, blue dots where the
          top axis (Z) pointed, accumulated up to the cursor. Blue dots clustered at "up" = device held level on
          the 2D plane; a cluster away from the pole = held tilted at that angle; scattered dots = unstable grip.
          N on the ground compass is the walking direction; enable the walking-direction frame to keep it fixed
          and judge the grip independently of where the person was going.
        </p>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="orientationBoxSvg"
        style={{ width: '100%', height: 'auto', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, azimuth: view.azimuth, elevation: view.elevation };
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setView({
            azimuth: d.azimuth + (e.clientX - d.x) * 0.4,
            elevation: Math.max(-80, Math.min(80, d.elevation + (e.clientY - d.y) * 0.4)),
          });
        }}
        onPointerUp={() => { dragRef.current = null; }}
      >
        {scene ? (
          <>
            {/* Ground compass: N follows the walking direction */}
            <path d={scene.compassRing} stroke="var(--border, #d0d5dd)" strokeWidth={1.2} fill="none" />
            <line
              x1={scene.northArrow.from.x} y1={scene.northArrow.from.y}
              x2={scene.northArrow.to.x} y2={scene.northArrow.to.y}
              stroke="#d92d20" strokeWidth={1.6} strokeDasharray="6 4" opacity={0.55}
            />
            {scene.cardinals.map((c) => (
              <g key={c.label}>
                <line x1={c.tickA.x} y1={c.tickA.y} x2={c.tickB.x} y2={c.tickB.y}
                  stroke={c.main ? '#d92d20' : 'currentColor'} strokeWidth={c.main ? 2.4 : 1.4} opacity={c.main ? 0.95 : 0.5} />
                <text x={c.text.x} y={c.text.y + 4} textAnchor="middle" fontSize={c.main ? 14 : 12}
                  fontWeight={c.main ? 800 : 600} fill={c.main ? '#d92d20' : 'currentColor'} opacity={c.main ? 1 : 0.65}>
                  {c.label}
                </text>
              </g>
            ))}

            {/* Static gimbal sphere (equator = level horizontal plane) */}
            {scene.sphereRings.map((d, i) => (
              <path key={i} d={d} stroke="currentColor" strokeWidth={i === 0 ? 1.3 : 0.8}
                strokeDasharray={i === 0 ? undefined : '3 4'} fill="none" opacity={i === 0 ? 0.45 : 0.28} />
            ))}
            <text x={scene.poleTop.x + 5} y={scene.poleTop.y - 4} fontSize={10} fill="currentColor" opacity={0.5}>up</text>

            {/* Back-half trail dots (behind the device) */}
            {scene.xTrail.filter((p) => !p.front).map((p, i) => (
              <circle key={`xb${i}`} cx={p.x} cy={p.y} r={1.7} fill="#d92d20" opacity={0.18} />
            ))}
            {scene.zTrail.filter((p) => !p.front).map((p, i) => (
              <circle key={`zb${i}`} cx={p.x} cy={p.y} r={1.7} fill="#3b5bfd" opacity={0.18} />
            ))}

            {/* Device */}
            {scene.faces.map((f, i) => (
              <polygon key={i} points={f.points} fill={f.fill} stroke="rgba(15, 23, 42, 0.45)" strokeWidth={0.8} />
            ))}

            {/* Sensor axes */}
            {scene.axes.map((axis) => (
              <g key={axis.label}>
                <line
                  x1={scene.center.x} y1={scene.center.y}
                  x2={axis.end.x} y2={axis.end.y}
                  stroke={axis.color} strokeWidth={2.2} opacity={0.9}
                />
                <text x={axis.end.x + 6} y={axis.end.y + 4} fontSize={12} fontWeight={700} fill={axis.color}>
                  {axis.label}
                </text>
              </g>
            ))}

            {/* Front-half trail dots (in front of the device) */}
            {scene.xTrail.filter((p) => p.front).map((p, i) => (
              <circle key={`xf${i}`} cx={p.x} cy={p.y} r={1.7} fill="#d92d20" opacity={0.5} />
            ))}
            {scene.zTrail.filter((p) => p.front).map((p, i) => (
              <circle key={`zf${i}`} cx={p.x} cy={p.y} r={1.7} fill="#3b5bfd" opacity={0.5} />
            ))}

            {/* Current instant markers on the sphere */}
            {scene.xTrail.length ? (
              <circle cx={scene.xTrail[scene.xTrail.length - 1].x} cy={scene.xTrail[scene.xTrail.length - 1].y}
                r={4} fill="#d92d20" stroke="#fff" strokeWidth={1.2} />
            ) : null}
            {scene.zTrail.length ? (
              <circle cx={scene.zTrail[scene.zTrail.length - 1].x} cy={scene.zTrail[scene.zTrail.length - 1].y}
                r={4} fill="#3b5bfd" stroke="#fff" strokeWidth={1.2} />
            ) : null}
          </>
        ) : (
          <text x={CX} y={CY} textAnchor="middle" fontSize={13} fill="currentColor" opacity={0.6}>
            IMU not initialised at this instant.
          </text>
        )}
      </svg>
      {!globalDriven ? (
        <div className="orientationBoxControls">
          <input
            type="range"
            min={0}
            max={Math.max(0.1, effectiveDuration)}
            step={0.1}
            value={time}
            onChange={(e) => setLocalTime(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      ) : null}
    </ChartCard>
  );
}
