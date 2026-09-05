export type Phase = 'learning' | 'exploration' | string;

export interface SessionRow {
  session_id: number;
  patient: string;
  condition: string;
  condition_label: string;
  phase: string;
  path_id: string;
  start_time: string | null;
  total_samples: number | null;
  n_raw: number | null;
  duration_s: number | null;
  last_state: number | string | null;
  status: string;
  is_interrupt: boolean;
  is_suspicious_short: boolean;
  warning: string;
  file_name: string;
}

export interface TrackingPoint {
  sample_idx: number;
  timestamp: string;
  state: number | string | null;
  event_type?: string | null;
  tag_id: string;
  x: number | null;
  y: number | null;
  z: number | null;
  x_plot: number | null;
  y_plot: number | null;
  z_plot: number | null;
  ax?: number | null;
  ay?: number | null;
  az?: number | null;
  accel_norm?: number | null;
  yaw_deg?: number | null;
  roll_deg?: number | null;
  pitch_deg?: number | null;
  qx?: number | null;
  qy?: number | null;
  qz?: number | null;
  qw?: number | null;
  t_s: number;
}

export interface ImuTagStat {
  tag_id: string;
  samples: number;
  median_accel: number | null;
  p95_accel: number | null;
  max_accel: number | null;
  spike_count: number;
  threshold?: number;
  is_target: boolean;
}

export interface ImuImpactEvent {
  tag_id: string;
  t_s: number | null;
  end_t_s: number | null;
  peak_accel: number;
}

export interface ImuQuality {
  tags: ImuTagStat[];
  impacts: Array<{ tag_id: string; t_s: number | null; accel_norm: number }>;
  events: ImuImpactEvent[];
  impact_count: number;
}

export interface OrientationSummary {
  samples_used: number;
  median_offset_deg: number | null;
  circular_std_deg: number | null;
  consistency: 'good' | 'fair' | 'poor' | 'unknown';
  note: string;
}

export interface FeedbackPoint {
  sample_idx: number;
  timestamp: string;
  state?: number | string | null;
  type?: string;
  target_id?: string;
  recipient_id?: string;
  distance?: number | null;
  intensity?: number | null;
  frequency_hz?: number | null;
  bucket?: string | number | null;
  prev_bucket?: string | number | null;
  proximity_profile_id?: string | null;
  t_s: number;
}

export interface DistancePoint {
  timestamp: string;
  t_s: number;
  target_id: string;
  distance: number;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  p1_x?: number | null;
  p1_y?: number | null;
  p1_z?: number | null;
}

export interface ClosestPoint {
  timestamp: string;
  t_s: number;
  closest_target_id: string;
  closest_distance: number;
}

export interface SpeedPoint {
  timestamp: string;
  t_s: number;
  speed_m_s: number | null;
  speed_m_s_smooth: number | null;
}

export interface MetricSummary {
  duration_s: number | null;
  samples: number | null;
  feedback_events: number;
  mean_intensity: number | null;
  max_intensity: number | null;
  mean_feedback_distance: number | null;
  min_feedback_distance: number | null;
  mean_closest_distance: number | null;
  min_closest_distance: number | null;
  mean_speed_m_s: number | null;
  max_speed_m_s: number | null;
  total_distance_m: number | null;
  max_accel_norm: number | null;
  feedback_events_per_min: number | null;
}

export interface SessionPayload {
  summary: Record<string, any>;
  metrics: MetricSummary;
  config: {
    seeker_id: string;
    target_ids: string[];
    distance_cfg: Record<string, any>;
    anchors: Array<Record<string, any>>;
    condition_cfg: Record<string, any>;
  };
  tracking: TrackingPoint[];
  feedback: FeedbackPoint[];
  distances: DistancePoint[];
  closest: ClosestPoint[];
  speed: SpeedPoint[];
  profiles: Array<Record<string, any>>;
  imu_quality?: ImuQuality;
  orientation?: OrientationSummary;
}

export interface CompareRow extends MetricSummary {
  session_id: number;
  patient: string;
  phase: string;
  condition: string;
  condition_label: string;
  path_id: string;
  start_time: string | null;
  warning: string;
}

export interface TrialTurn {
  turn_index: number;
  target_id: string;
  x: number;
  y: number;
  /** Geometric turn angle of the IDEAL straight-line route (start -> O1 ->
   * O2 -> O3 -> stop) at this target — not measured from the learning
   * trajectory's own (noisy) shape, which a pause or confused circling right
   * at the target could distort well past what the path design intends. */
  ideal_heading_change_deg: number | null;
  exploration_heading_change_deg: number | null;
  deviation_deg: number | null;
  wrong_turn: boolean;
}

export interface TargetDiscoveryEntry {
  target_id: string;
  /** Position of this target in the learning session's own intended visit order. */
  path_order: number;
  found: boolean;
  first_feedback_t_s: number | null;
  /** Closest proximity zone reached for this target (lower = closer). */
  min_bucket: number | null;
  max_intensity: number | null;
  /** How "found" was determined: a real feedback event, a distance check
   * against a manually-entered coordinate (no sensor data for this target),
   * a direct researcher override (manual_discovery.py — bypasses both of the
   * above), or null if never found either way. */
  source: 'feedback' | 'manual_distance' | 'manual_flag' | null;
  /** [x, y] of a manually-entered coordinate for this target, if one has
   * been entered — regardless of whether it counted as "found". */
  manual_xy: [number, number] | null;
  /** Raw manual found/not-found override (manual_discovery.py) for this
   * target — null when no override is set (the automatic `found` value
   * above is used as-is). Drives the "Auto-detected / Found / Not found"
   * select; distinct from `found`, which already has the override applied. */
  manual_found_override?: boolean | null;
}

export interface TargetDiscovery {
  targets: TargetDiscoveryEntry[];
  found_count: number;
  discovery_order: string[];
  /** Whether the found targets were triggered in the same relative order as the intended path. */
  in_order: boolean | null;
  /** Raw manual in-order override (manual_discovery.py) — null when no
   * override is set (the automatic `in_order` above is used as-is). */
  manual_in_order_override?: boolean | null;
}

export interface TrialRow {
  patient: string;
  condition: string;
  condition_label: string;
  path_id: string;
  learning_session_id: number | null;
  exploration_session_id: number | null;
  attempt_number: number | null;
  total_attempts: number | null;
  got_lost: boolean;
  overlap_pct: number | null;
  mean_deviation_m: number | null;
  /** Point-by-point comparison at the same relative position along each
   * route (arc-length resampled, same buffer threshold as overlap_pct) —
   * unlike overlap_pct (nearest-neighbor to ANY point on the route,
   * order-blind), this respects order/direction: wandering the same general
   * area without retracing the actual shape scores low here. */
  shape_overlap_pct: number | null;
  shape_deviation_m: number | null;
  /** Discrete Fréchet distance (Eiter & Mannila, 1994) between the same
   * 100-point resampled routes used for shape_overlap_pct — the smallest
   * "leash length" connecting a walker on each route if both may only move
   * forward. A worst-case number: one bad detour raises it even if the rest
   * of the route matches closely (unlike shape_deviation_m, which averages). */
  frechet_distance_m: number | null;
  /** Dynamic Time Warping cost between the same two 100-point resampled
   * routes, normalized to an average cost per step (meters) — like
   * shape_deviation_m, but tolerant of pacing differences: a point may match
   * several consecutive points on the other route instead of a rigid 1-to-1
   * same-index pairing. */
  dtw_distance_m: number | null;
  /** Longest Common Subsequence similarity (%): the longest run of matched
   * point-pairs (within 0.5 m) allowing unmatched stretches to be freely
   * skipped on either side, normalized by the shorter route's length. Most
   * forgiving of the five — a single bad detour is skipped, not penalized. */
  lcss_pct: number | null;
  /** d_k (meters) for k = 1..100 — the same per-point distances averaged into
   * shape_deviation_m, kept here so a chart can show WHERE along the route
   * (x = % of the way along) the deviation happened, not just the mean. */
  shape_deviation_profile: number[] | null;
  /** [x, y] of the k-th arc-length-resampled point (k = 0..99) on the
   * learning / exploration route — lets the UI highlight, on the trajectory
   * map, exactly which physical point corresponds to a given position on the
   * deviation profile chart. */
  learn_resampled_xy: [number, number][] | null;
  exp_resampled_xy: [number, number][] | null;
  turns: TrialTurn[];
  wrong_turns_count: number | null;
  mean_turn_deviation_deg: number | null;
  stop_position_distance_m: number | null;
  start_position_distance_m: number | null;
  /** [x, y] of the learning trajectory's own end point — the "ideal" stop location. */
  ideal_stop_xy: [number, number] | null;
  /** [x, y] of the learning trajectory's own start point — the "ideal" start location. */
  ideal_start_xy: [number, number] | null;
  /** Distance between the learning start point and the exploration's LAST position —
   * did they go out and come back? This is how "completed the path" is defined. */
  return_to_start_distance_m: number | null;
  /** Distance between the exploration's own END point and its own START
   * point — the "completed" reference used by General statistics (more
   * robust than return_to_start_distance_m: the reference point always comes
   * from the same recording it's judging, so it can't be thrown off by
   * learning/exploration placement drift, but requires filtering out
   * near-empty recordings separately since start==end trivially there). */
  self_return_distance_m: number | null;
  target_discovery: TargetDiscovery | null;
  /** target_id -> probable physical impact count during this exploration attempt. */
  target_impacts: Record<string, number>;
  stop_count: number | null;
  border_reached_count: number | null;
  manual_lost: boolean | null;
  comment: string;
  /** Hardware error / bad trial — excluded from all aggregate statistics. */
  excluded_from_stats: boolean;
  mean_speed_m_s: number | null;
  max_accel_norm: number | null;
  /** Closest distance reached to any target during this exploration attempt
   * — same field as the "Min closest" stat, duplicated here as the input to
   * the performance score's "target proximity" component. */
  min_closest_distance_m: number | null;
  /** 1-5 composite rating of this exploration attempt — see
   * performance_score_details for the components/weights behind it. */
  performance_score: number | null;
  performance_score_details: PerformanceScoreDetails | null;
  /** Same underlying facts as performance_score_details, reported instead as
   * individually-established navigation/O&M measures with no combining or
   * weighting — see NavMetrics. Shown side by side with the composite score
   * for comparison, not as a replacement for it. */
  nav_metrics: NavMetrics | null;
  note?: string;
  error?: string;
}

export interface PerformanceScoreComponent {
  name: string;
  /** 0 (bad) to 1 (good) after applying the good/bad reference thresholds. */
  normalized_score: number;
  /** This component's share of the composite, renormalized across whichever
   * components had data (a missing one doesn't silently count as 0). */
  weight: number;
  raw_value: number | null;
  unit: string;
}

/** How close the exploration attempt got to ONE target individually — behind
 * the averaged "Target proximity" component above, so the info popover can
 * show O1/O2/O3 separately instead of only the mean. `found` mirrors this
 * same target's entry in TargetDiscovery (feedback or manual-distance based),
 * a related but distinct signal from the raw geometric distance here. */
export interface PerformanceTargetBreakdown {
  target_id: string;
  distance_m: number;
  normalized_score: number | null;
  found: boolean;
}

export interface PerformanceScoreDetails {
  score: number | null;
  /** Weighted 0-1 blend of the components' normalized_score, before mapping
   * onto the 1-5 scale (round(1 + 4*composite)). */
  composite: number | null;
  components: PerformanceScoreComponent[];
  target_breakdown: PerformanceTargetBreakdown[];
}

/** Distance to ONE target, without the normalized_score/weighting baggage
 * of PerformanceTargetBreakdown — purely descriptive detail behind
 * NavMetrics.target_acquisition_pct. */
export interface NavTargetBreakdown {
  target_id: string;
  distance_m: number;
  found: boolean;
}

/** Standard individual navigation / orientation-and-mobility (O&M) outcome
 * measures for one exploration attempt — reported separately, unweighted,
 * as an alternative to the heuristic composite in PerformanceScoreDetails.
 * See compute_navigation_metrics on the backend for what each one is and
 * the literature term it corresponds to. */
export interface NavMetrics {
  /** ideal_path_length_m / actual_path_length_m * 100 — same ratio as "path
   * efficiency" in Morris water maze spatial-navigation research, and the
   * inverse of "path ratio" (actual/ideal) used in human wayfinding studies.
   * Can exceed 100% on a short/interrupted attempt (less distance walked
   * than the ideal route requires) — that's an incomplete trajectory, not
   * superhuman efficiency. */
  path_efficiency_pct: number | null;
  ideal_path_length_m: number | null;
  actual_path_length_m: number | null;
  /** targets_found / targets_total * 100 — the standard task-success-rate
   * measure in search / assistive-technology studies. */
  target_acquisition_pct: number | null;
  targets_found: number | null;
  targets_total: number | null;
  /** Distance from the final tracked position to the learning route's own
   * end point — a "homing error" measure, as used in homing / triangle-
   * completion navigation experiments. */
  endpoint_error_m: number | null;
  /** Number of times the 8x6 m safety perimeter was left — analogous to
   * "veering incidents" in O&M mobility research. */
  boundary_contacts: number | null;
  target_breakdown: NavTargetBreakdown[];
}

/** Pearson r (or null if too few trials / no variance) for one speed- or
 * accel-vs-outcome pair, across every trial in the dataset — see
 * fetchPerformanceCorrelations. target_distance is the average of each
 * trial's per-target proximities (same measure as the score's "Target
 * proximity" component); targets_found is the found_count/found_total
 * fraction (same measure as "Targets found"). */
export interface PerformanceCorrelations {
  n: number;
  correlations: {
    speed_vs_endpoint_distance: number | null;
    speed_vs_target_distance: number | null;
    speed_vs_targets_found: number | null;
    speed_vs_border_crossings: number | null;
    accel_vs_endpoint_distance: number | null;
    accel_vs_target_distance: number | null;
    accel_vs_targets_found: number | null;
    accel_vs_border_crossings: number | null;
  };
}

export interface PatientTrialSummary {
  patient: string;
  total_trials: number;
  lost_trials: number;
}
