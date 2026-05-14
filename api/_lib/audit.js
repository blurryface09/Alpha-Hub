export async function writeAuditLog(supabase, { action, userId, metadata = {} }) {
  const { error } = await supabase.from('audit_logs').insert({
    action,
    user_id: userId || null,
    metadata,
  })

  if (error) {
    console.error('audit log write failed:', error.message)
  }
}
