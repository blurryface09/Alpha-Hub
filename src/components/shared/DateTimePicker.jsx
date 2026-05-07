/**
 * DateTimePicker — replaces the clunky datetime-local input.
 * - Separate date + time fields (much cleaner on Chrome)
 * - Detects and displays the user's local timezone
 * - value/onChange use UTC ISO strings (what the DB stores)
 *   so everything round-trips correctly across timezones.
 */
import React from 'react'
import { Clock } from 'lucide-react'

// Detect short timezone label e.g. "WAT", "GMT+1", "EST"
function tzLabel() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const abbr = new Date().toLocaleTimeString('en', { timeZoneName: 'short' }).split(' ').pop()
    return abbr || tz
  } catch {
    return 'local'
  }
}

// UTC ISO string → { date: 'YYYY-MM-DD', time: 'HH:MM' } in LOCAL time
function utcToLocalParts(utcStr) {
  if (!utcStr) return { date: '', time: '' }
  const d = new Date(utcStr)
  if (isNaN(d)) return { date: '', time: '' }
  const pad = n => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

// LOCAL date + time strings → UTC ISO string
function localPartsToUtc(date, time) {
  if (!date) return null
  // new Date('YYYY-MM-DDTHH:MM') is parsed as LOCAL time by the browser
  const str = `${date}T${time || '00:00'}:00`
  const d = new Date(str)
  return isNaN(d) ? null : d.toISOString()
}

export default function DateTimePicker({ value, onChange, label = 'Mint Date & Time' }) {
  const { date, time } = utcToLocalParts(value)
  const tz = tzLabel()

  const handleDate = (e) => {
    onChange(localPartsToUtc(e.target.value, time))
  }

  const handleTime = (e) => {
    onChange(localPartsToUtc(date, e.target.value))
  }

  return (
    <div>
      <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1.5">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="date"
          className="input flex-1 min-w-0"
          value={date}
          onChange={handleDate}
        />
        <input
          type="time"
          className="input w-28"
          value={time}
          onChange={handleTime}
        />
      </div>
      <p className="text-[10px] text-muted mt-1 flex items-center gap-1">
        <Clock size={9} />
        Times are in your local timezone · <span className="text-accent font-mono">{tz}</span>
      </p>
    </div>
  )
}
