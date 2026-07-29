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
  learned_heading_change_deg: number | null;
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
}

export interface TargetDiscovery {
  targets: TargetDiscoveryEntry[];
  found_count: number;
  discovery_order: string[];
  /** Whether the found targets were triggered in the same relative order as the intended path. */
  in_order: boolean | null;
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
  target_discovery: TargetDiscovery | null;
  /** target_id -> probable physical impact count during this exploration attempt. */
  target_impacts: Record<string, number>;
  stop_count: number | null;
  border_reached_count: number | null;
  manual_lost: boolean | null;
  comment: string;
  /** Hardware error / bad trial — excluded from all aggregate statistics. */
  excluded_from_stats: boolean;
  note?: string;
  error?: string;
}

export interface PatientTrialSummary {
  patient: string;
  total_trials: number;
  lost_trials: number;
}
