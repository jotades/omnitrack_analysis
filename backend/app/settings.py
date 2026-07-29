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
    stop_speed_threshold_m_s: float = 0.08
    stop_min_duration_s: float = 1.0
    # Turn-deviation beyond this angle counts as "wrong" even if a turn was detected at all.
    wrong_turn_threshold_deg: float = 45.0
    # If the exploration trajectory never comes within this radius of a learned turn, it's a missed/wrong turn.
    turn_miss_radius_m: float = 1.5
    # Centered inner "safe" box: margin applied to the longer/shorter anchor-span axis.
    border_margin_long_m: float = 2.0
    border_margin_short_m: float = 1.0
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
