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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
