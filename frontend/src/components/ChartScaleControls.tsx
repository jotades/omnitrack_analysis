export type ScaleMode = 'tight' | 'auto' | 'zero';

interface Props {
  value: ScaleMode;
  onChange: (value: ScaleMode) => void;
  label?: string;
}

export function ChartScaleControls({ value, onChange, label = 'Scala Y' }: Props) {
  return (
    <div className="chartTools">
      <label>
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value as ScaleMode)}>
          <option value="tight">tight ±5%</option>
          <option value="auto">auto Recharts</option>
          <option value="zero">da 0</option>
        </select>
      </label>
    </div>
  );
}

export function finiteNumbers(values: unknown[]) {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

export function yDomain(values: unknown[], mode: ScaleMode): [number | string, number | string] {
  if (mode === 'auto') return ['auto', 'auto'];

  const nums = finiteNumbers(values);
  if (!nums.length) return ['auto', 'auto'];

  const min = Math.min(...nums);
  const max = Math.max(...nums);

  if (mode === 'zero') {
    return [0, Math.max(max * 1.05, max + 0.01)];
  }

  if (min === max) {
    const pad = Math.max(0.1, Math.abs(max) * 0.05);
    return [min - pad, max + pad];
  }

  const pad = Math.max((max - min) * 0.05, 0.001);
  return [min - pad, max + pad];
}
