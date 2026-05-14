/**
 * DateTimePicker — clean split date + time inputs with timezone awareness.
 *
 * - Buffers local date/time strings internally
 * - Only calls onChange(utcISOString) once the date is fully valid (4-digit year)
 * - Displays the user's detected timezone so they know what time they're setting
 * - value/onChange use UTC ISO strings (what the DB stores)
 */
import React, { useState, useEffect } from 'react'
import { Clock } from 'lucide-react'

function tzLabel() {
  try {
    return new Date().toLocaleTimeString('en', { timeZoneName: 'short' }).split(' ').pop() || 'local'
  } catch { return 'local' }
}

function tzName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time'
  } catch { return 'Local time' }
}

function formatLocalPreview(date, time) {
  const utc = localPartsToUtc(date, time)
  if (!utc) return null
  return new Date(utc).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatUtcPreview(date, time) {
  const utc = localPartsToUtc(date, time)
  if (!utc) return null
  return new Date(utc).toLocaleString([], {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// UTC ISO string → { date: 'YYYY-MM-DD', time: 'HH:MM' } in user's LOCAL time
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

// LOCAL date + time strings → UTC ISO string (only when date is complete)
function localPartsToUtc(date, time) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const str = `${date}T${time && /^\d{2}:\d{2}$/.test(time) ? time : '00:00'}:00`
  const d = new Date(str) // parsed as LOCAL time
  return isNaN(d) ? null : d.toISOString()
}

export default function DateTimePicker({ value, onChange, label = 'Mint Date & Time' }) {
  const initial = utcToLocalParts(value)
  const [localDate, setLocalDate] = useState(initial.date)
  const [localTime, setLocalTime] = useState(initial.time)
  const tz = tzLabel()
  const timezone = tzName()
  const localPreview = formatLocalPreview(localDate, localTime)
  const utcPreview = formatUtcPreview(localDate, localTime)

  // Sync inbound value changes (e.g. when EditModal loads project data)
  useEffect(() => {
    const parts = utcToLocalParts(value)
    setLocalDate(parts.date)
    setLocalTime(parts.time)
  }, [value])

  const handleDate = (e) => {
    const d = e.target.value
    setLocalDate(d)
    const utc = localPartsToUtc(d, localTime)
    if (utc) onChange(utc)      // only emit when date is fully valid
    else if (!d) onChange(null) // cleared
  }

  const handleTime = (e) => {
    const t = e.target.value
    setLocalTime(t)
    const utc = localPartsToUtc(localDate, t)
    if (utc) onChange(utc)
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
          value={localDate}
          onChange={handleDate}
        />
        <input
          type="time"
          className="input w-28"
          value={localTime}
          onChange={handleTime}
        />
      </div>
      <p className="text-[10px] text-muted mt-1 flex items-center gap-1">
        <Clock size={9} />
        Enter local time · <span className="text-accent font-mono">{timezone} / {tz}</span>
      </p>
      {utcPreview && (
        <div className="mt-2 rounded-lg border border-border bg-surface2/70 p-2 text-[10px] text-muted leading-relaxed">
          <div><span className="text-text">Local:</span> {localPreview}</div>
          <div><span className="text-text">Saved as UTC:</span> {utcPreview}</div>
          <div className="text-muted2 mt-1">Confirm this against the official mint page before enabling Strike Mode.</div>
        </div>
      )}
    </div>
  )
}
