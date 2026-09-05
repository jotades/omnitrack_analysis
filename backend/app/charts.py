from __future__ import annotations

import io
from typing import List

import matplotlib

matplotlib.use("Agg")  # no display available on the server
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker as mticker  # noqa: E402


def render_bar_chart_png(
    title: str,
    labels: List[str],
    values: List[float],
    y_label: str = "%",
    y_max: float = 100.0,
    y_major_unit: float = 25.0,
    color: str = "#3b5bfd",
    width_in: float = 9.0,
    height_in: float = 5.0,
    dpi: int = 200,
) -> bytes:
    """A clean, presentation-ready bar chart as a PNG — an alternative to the
    in-app recharts version for pasting into a slide deck: server-rendered so
    the styling (fonts, DPI, spacing) stays consistent regardless of the
    viewer's browser/zoom, unlike a screenshot of the live chart."""
    fig, ax = plt.subplots(figsize=(width_in, height_in), dpi=dpi)
    bars = ax.bar(labels, values, color=color, width=0.6, zorder=3)

    ax.set_ylim(0, y_max)
    ax.yaxis.set_major_locator(mticker.MultipleLocator(y_major_unit))
    ax.set_ylabel(y_label)
    ax.set_title(title, fontsize=14, fontweight="bold", pad=14)

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(axis="y", color="#e5e7eb", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)

    plt.setp(ax.get_xticklabels(), rotation=25, ha="right")

    for bar, v in zip(bars, values):
        label = f"{v:.0f}{y_label}" if y_label == "%" else f"{v:.0f}"
        ax.annotate(
            label,
            xy=(bar.get_x() + bar.get_width() / 2, bar.get_height()),
            xytext=(0, 4),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=9,
            color="#333333",
        )

    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, facecolor="white")
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()
