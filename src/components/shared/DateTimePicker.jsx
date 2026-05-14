import React, { useState, useEffect } from 'react'

// Convert a UTC ISO string to local date/time parts for display
function utcToLocalParts(utcStr) {
  if (!utcStr) return { date: '', time: '' }
  const d = new Date(utcStr)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  const hh   = String(d.getHours()).padStart(2, '0')
  const min  = String(d.getMinutes()).padStart(2, '0')
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` }
}

// Convert local date+time parts back to UTC ISO string
function localPartsToUtc(date, time) {
  if (!date || !time) return null
  const d = new Date(`${date}T${time}:00`)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

function getTzLabel() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    // Get short offset label  e.g. "GMT+1"
    const offset = -new Date().getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
    const m = String(Math.abs(offset) % 60).padStart(2, '0')
    return `GMT${sign}${h}:${m}`
  } catch {
    return 'local'
  }
}

/**
 * DateTimePicker — stores UTC ISO internally, shows user's local time
 * @param {string} value    - UTC ISO string (from DB)
 * @param {Function} onChange - called with UTC ISO string
 */
export default function DateTimePicker({ value, onChange, disabled = false }) {
  const [parts, setParts] = useState(() => utcToLocalParts(value))
  const tz = getTzLabel()

  // Sync if external value changes
  useEffect(() => {
    setParts(utcToLocalParts(value))
  }, [value])

  const handleChange = (field, val) => {
    const next = { ...parts, [field]: val }
    setParts(next)
    const utc = localPartsToUtc(next.date, next.time)
    if (utc) onChange(utc)
  }

  return (
    <div className="flex gap-2 items-center">
      <input
        type="date"
        className="input flex-1 min-w-0"
        value={parts.date}
        disabled={disabled}
        onChange={e => handleChange('date', e.target.value)}
      />
      <input
        type="time"
        className="input w-28"
        value={parts.time}
        disabled={disabled}
        onChange={e => handleChange('time', e.target.value)}
      />
      <span className="text-xs text-muted whitespace-nowrap font-mono">{tz}</span>
    </div>
  )
}
