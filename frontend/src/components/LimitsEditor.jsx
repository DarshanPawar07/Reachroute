import { Input } from './ui.jsx';

/**
 * One number box per limit. An empty box means "not set here": the next level down applies (the plan, or the standard value).
 *   defs          [{ key, label }]
 *   value         { key: number|string } for the limits set at this level
 *   placeholders  { key: number } shown in an empty box (what applies when this level does not set it)
 */
export default function LimitsEditor({ defs, value, placeholders = {}, onChange, disabled = false }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((d) => (
        <label key={d.key} className="block text-sm">
          <span className="mb-1 block text-stone-700">{d.label}</span>
          <Input
            type="number"
            min={1}
            step={1}
            disabled={disabled}
            placeholder={placeholders[d.key] !== undefined ? String(placeholders[d.key]) : 'standard'}
            value={value[d.key] ?? ''}
            onChange={(e) => onChange({ ...value, [d.key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
