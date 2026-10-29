from functools import lru_cache
from pathlib import Path
from pydantic import BaseModel
import os
from dotenv import load_dotenv

load_dotenv()


class Settings(BaseModel):
    data_dir: Path = Path(os.getenv("DATA_DIR", "/home/jota/Downloads/third_analysis_dataset/Pilot/pp_study"))
    patient_dir_pattern: str = "pp_*_sessions"
    realtime_cooked_alpha: float = 0.4
    default_plot_alpha: float = 0.20
    min_duration_s: float = 10.0
    min_total_samples: int = 20
    interrupt_state: int = 2
    completed_state: int = 1
    speed_rolling_window: int = 5
    # IMU quality: a stationary target sensor whose accel norm jumps above
    # max(impact_min_accel, median + impact_delta_accel) was probably hit/kicked.
    impact_min_accel: float = 1.5
    impact_delta_accel: float = 1.0
    # Minimum speed (m/s) before the trajectory heading is considered meaningful.
    heading_min_speed: float = 0.25

    # Trial metrics: exploration vs. learning trajectory comparison.
    trial_overlap_buffer_m: float = 0.5
    # Shape overlap: both trajectories resampled to this many points, equally
    # spaced by arc length (not by sample/time — walking speed differs), then
    # compared point-by-point at the same relative position along the route.
    # Same trial_overlap_buffer_m threshold, but this respects order/direction,
    # unlike the plain nearest-neighbor overlap_pct above.
    trial_shape_resample_points: int = 100
    # Previous pause rule (compute_stop_events), kept only for comparison:
    # speed between consecutive samples, median over 5, below a fixed 0.08 m/s.
    stop_speed_threshold_m_s: float = 0.08
    stop_min_duration_s: float = 1.0

    # Pauses of the hand-held unit P1 (compute_pause_events).
    # Speed of a sample = horizontal displacement between the samples around
    # t - window/2 and t + window/2, divided by the real time between them,
    # after dropping samples whose position repeats the previous one.
    pause_window_s: float = 1.0
    # Noise threshold: this percentile of the same speed measured on the
    # landmark units O1-O3, which do not move (so their speed is only position
    # noise), outside haptic_on_object (units parked at the border there), on
    # every recording included in the analysis. Computed from the data and
    # stored with how it was obtained in pause_noise_threshold_path; computed
    # again whenever the recordings, inclusions or exclusions change.
    pause_noise_percentile: float = 95.0
    pause_noise_threshold_path: Path = Path(os.getenv(
        "PAUSE_NOISE_THRESHOLD_PATH",
        str(Path(__file__).resolve().parent / "pause_noise_threshold.json"),
    ))
    # Relative threshold (off by default): P1 is paused when its speed is below
    # the higher of the noise threshold and this fraction of P1's median speed
    # in that task, the median taken on the moving samples only.
    pause_relative_enabled: bool = False
    pause_relative_fraction: float = 0.25
    pause_min_duration_s: float = 1.0
    # Pauses of P1 = stay points (Li et al. 2008): P1 stays within this radius
    # of a sample for at least pause_min_duration_s. Equal to the mean position
    # error of P1 (0.141 m), as for the border hysteresis. The window-speed
    # rule above (noise threshold, relative threshold) is kept for comparison only.
    pause_stay_radius_m: float = 0.141
    # A stretch where P1's position stays identical for at least this long is
    # a gap in the data, not a pause: left out of the pauses, counted apart.
    data_gap_min_duration_s: float = 1.0
    # Turn-deviation beyond this angle counts as "wrong" even if a turn was detected at all.
    wrong_turn_threshold_deg: float = 45.0
    # If the exploration trajectory never comes within this radius of a learned turn, it's a missed/wrong turn.
    turn_miss_radius_m: float = 1.5
    # Centered inner "safe" box: margin applied to the longer/shorter anchor-span axis.
    border_margin_long_m: float = 2.0
    border_margin_short_m: float = 1.0
    # Border crossings of P1: a crossing starts when P1 is more than this far
    # outside the inner box, and the next one can only start after P1 has
    # come back more than this far inside it (hysteresis). Equal to the mean
    # position error of P1 measured on 63 reference points (0.141 m), so that
    # position jitter near the border does not count one visit many times.
    border_hysteresis_m: float = 0.141
    min_turn_heading_change_deg: float = 40.0
    turn_min_separation_m: float = 1.0
    turn_resample_step_m: float = 0.15

    # Researcher annotations (manual "lost" override + free-text comment per
    # trial attempt) — kept as a small JSON file next to the backend code,
    # separate from DATA_DIR since it's app state, not raw session data.
    annotations_path: Path = Path(os.getenv(
        "ANNOTATIONS_PATH",
        str(Path(__file__).resolve().parent / "trial_annotations.json"),
    ))

    # Per-patient opt-out from the General statistics aggregate — same
    # small-JSON-file pattern as annotations_path above. Patients default to
    # included (True) when absent from the file.
    patient_inclusion_path: Path = Path(os.getenv(
        "PATIENT_INCLUSION_PATH",
        str(Path(__file__).resolve().parent / "patient_inclusion.json"),
    ))

    # Manually-entered O1/O2/O3 coordinates for trials whose target tags were
    # never tracked by the sensors (e.g. haptic_on_object_intes only tracked
    # P1) — same small-JSON-file pattern as the two paths above.
    target_coordinates_path: Path = Path(os.getenv(
        "TARGET_COORDINATES_PATH",
        str(Path(__file__).resolve().parent / "target_coordinates.json"),
    ))
    # A manually-placed target counts as "found" (distance-based fallback,
    # used only when no feedback event confirms it) once the seeker's
    # trajectory comes within this radius of the entered coordinate.
    manual_target_found_radius_m: float = 1.0
    # A P1 sample is "near the landmarks" within this distance (m) of any of them.
    landmark_near_radius_m: float = 1.0

    # Distance at which the feedback makes its last (strongest) step. In the
    # recordings this is 0.6 m whatever min_activation_distance is set to:
    # the steps are `threshold` wide (0.2 m) from max_activation_distance
    # down to here, and no feedback_changed event happens closer than this.
    feedback_innermost_step_m: float = 0.6

    # Corrects a session mislabeled learning/exploration at recording time
    # (experimenter picked the wrong phase when starting the recording) —
    # keyed by file_name (stable across session_id renumbering on refresh),
    # same small-JSON-file pattern as the three paths above. Never edits the
    # raw session JSON files themselves.
    phase_overrides_path: Path = Path(os.getenv(
        "PHASE_OVERRIDES_PATH",
        str(Path(__file__).resolve().parent / "phase_overrides.json"),
    ))

    # Recording to use for each phase of a trial, fixed by hand where the
    # automatic choice (last non-interrupted learning, latest exploration) is
    # the wrong one — keyed by "patient|condition|path_id", values are
    # file_names like phase_overrides_path. Same small-JSON-file pattern.
    recording_pins_path: Path = Path(os.getenv(
        "RECORDING_PINS_PATH",
        str(Path(__file__).resolve().parent / "recording_pins.json"),
    ))

    # Log of every correction saved from the dashboard (value before and
    # after, time), one JSON object per line — read back and undone from the
    # "Changes" menu.
    change_log_path: Path = Path(os.getenv(
        "CHANGE_LOG_PATH",
        str(Path(__file__).resolve().parent / "corrections_log.jsonl"),
    ))

    # Participants left out of the ANOVA and the mixed models (data quality),
    # still shown everywhere else: {patient: reason}.
    stats_exclusions_path: Path = Path(os.getenv(
        "STATS_EXCLUSIONS_PATH",
        str(Path(__file__).resolve().parent / "stats_exclusions.json"),
    ))

    # Route actually set up, for the trials whose file name carries another
    # route letter — keyed by "patient|condition|path_id" (file-name letter).
    route_overrides_path: Path = Path(os.getenv(
        "ROUTE_OVERRIDES_PATH",
        str(Path(__file__).resolve().parent / "route_overrides.json"),
    ))

    # Manual found/in-order override per trial — for when the automatic
    # feedback/distance-based detection (target_coordinates_path above) gets
    # it wrong, mainly under haptic_on_object_intes where there's no sensor
    # on O1/O2/O3 to derive it from. Same small-JSON-file pattern as the
    # paths above; keyed the same way as target_coordinates_path.
    manual_discovery_path: Path = Path(os.getenv(
        "MANUAL_DISCOVERY_PATH",
        str(Path(__file__).resolve().parent / "manual_discovery.json"),
    ))

    # Manually marked point E per recording (end of the route = start of the
    # walk back to the starting point) — keyed by file_name like
    # phase_overrides_path, same small-JSON-file pattern as the paths above.
    task_split_path: Path = Path(os.getenv(
        "TASK_SPLIT_PATH",
        str(Path(__file__).resolve().parent / "task_split.json"),
    ))
    # Free-text observations written in the dashboard, keyed by section.
    observations_path: Path = Path(os.getenv(
        "OBSERVATIONS_PATH",
        str(Path(__file__).resolve().parent / "observations.json"),
    ))

    # Performance score (1-5, compute_performance_score): a heuristic composite
    # of how well one exploration attempt achieved the stated goal — end up as
    # close as possible to the learning route's own end point and to EACH
    # target individually (O1-O3), have actually found them (not just walked
    # near them), without repeatedly leaving the 8x6 m safety border. NOT a
    # validated formula — see compute_navigation_metrics for the same facts
    # reported as individually-established O&M measures instead, for
    # comparison. Endpoint/target distances are linearly scored 1.0 at/below
    # their "good" reference down to 0.0 at/above their "bad" reference (see
    # _linear_good_bad_score); "targets found" is already a 0-1 fraction
    # (found_count / found_total). Speed/acceleration are deliberately NOT in
    # this formula — see compute_speed_accel_correlations, which checks
    # whether they actually relate to outcome before anything gets weighted
    # by them.
    performance_endpoint_good_m: float = 0.5
    performance_endpoint_bad_m: float = 3.0
    performance_target_good_m: float = 0.5
    performance_target_bad_m: float = 3.0
    performance_border_bad_count: int = 5
    performance_weight_endpoint: float = 0.30
    performance_weight_target: float = 0.25
    performance_weight_found: float = 0.25
    performance_weight_border: float = 0.20


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
