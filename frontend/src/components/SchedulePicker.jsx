import { DAY_NAMES } from '../lib/schedule.js';
import { Field, Input } from './ui.jsx';

/**
 * When a campaign starts and which hours it may send in.
 *   value     the schedule (see lib/schedule.js)
 *   onChange  called with the new schedule
 *   allowStart  false once the campaign has begun (the start time can no longer move)
 */
export default function SchedulePicker({ value, onChange, allowStart = true }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const toggleDay = (d) => set({ days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d].sort() });

  return (
    <div className="space-y-4">
      {allowStart && (
        <div className="space-y-2">
          <span className="block text-sm font-medium text-stone-800">When to start</span>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="start" checked={!value.later} onChange={() => set({ later: false })} />
              Right away
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="start" checked={value.later} onChange={() => set({ later: true })} />
              At a set time
            </label>
          </div>
          {value.later && (
            <Field label="Start at" hint="Your computer's time. Up to 30 days ahead.">
              <Input type="datetime-local" value={value.startAt} onChange={(e) => set({ startAt: e.target.value })} />
            </Field>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
          <input type="checkbox" checked={value.useWindow} onChange={(e) => set({ useWindow: e.target.checked })} />
          Only send during certain hours
        </label>
        {value.useWindow && (
          <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="From">
                <Input type="time" value={value.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
              </Field>
              <Field label="Until">
                <Input type="time" value={value.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
              </Field>
              <Field label="Timezone" hint="For example Asia/Kolkata">
                <Input value={value.timezone} onChange={(e) => set({ timezone: e.target.value })} />
              </Field>
            </div>
            <div>
              <span className="mb-1 block text-sm font-medium text-stone-800">On these days</span>
              <div className="flex flex-wrap gap-3 text-sm">
                {DAY_NAMES.map((name, d) => (
                  <label key={d} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={value.days.includes(d)} onChange={() => toggleDay(d)} />
                    {name}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-stone-500">Leave all unticked to send on every day. Messages that come due outside these hours wait for the next opening.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
