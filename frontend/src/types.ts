export type Phase = 'all' | 'learning' | 'exploration' | string;

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
  t_s: number;
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
