import { ReactNode, useLayoutEffect, useRef, useState } from 'react';

interface ChartFrameProps {
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** width / height. Use this when the physical proportion matters, e.g. room 8 m x 12 m. */
  aspectRatio?: number;
  className?: string;
  children: (width: number, height: number) => ReactNode;
}

export function ChartFrame({
  height = 330,
  minWidth = 320,
  minHeight = 260,
  maxHeight = 760,
  aspectRatio,
  className,
  children,
}: ChartFrameProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;

    const measure = () => {
      const next = Math.max(minWidth, Math.floor(el.getBoundingClientRect().width));
      setContainerWidth((prev) => (prev === next ? prev : next));
    };

    measure();

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });

    observer.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [minWidth]);

  let chartWidth = containerWidth;
  let chartHeight = height;

  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    const naturalHeight = Math.round(containerWidth / aspectRatio);
    chartHeight = Math.max(minHeight, Math.min(maxHeight, naturalHeight));
    chartWidth = Math.round(chartHeight * aspectRatio);

    if (chartWidth > containerWidth) {
      chartWidth = containerWidth;
      chartHeight = Math.round(containerWidth / aspectRatio);
    }
  }

  return (
    <div ref={ref} className={`chartFrame ${className ?? ''}`} style={{ minHeight: chartHeight }}>
      <div className="chartFrameInner" style={{ width: chartWidth, height: chartHeight }}>
        {children(chartWidth, chartHeight)}
      </div>
    </div>
  );
}
