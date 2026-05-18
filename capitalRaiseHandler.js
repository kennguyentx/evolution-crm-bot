// ============================================================
// Evolution Strategy Discord Bot — Capital Raise Handler
// File: capitalRaiseHandler.js (root of bot repo)
//
// Drop alongside agent.js, index.js in the bot root.
// Wire it in agent.js with:
//   const { handleCapitalMessage } = require('./capitalRaiseHandler')
//   // inside your messageCreate listener, before other handlers:
//   if (await handleCapitalMessage(message)) return
// ============================================================

const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// In-memory store for pending confirmations: userId → { proposal, dbOps }
// In production you'd persist this in Redis or Supabase, but in-memory
// works fine for a small team where confirms happen within seconds.
const pendingConfirms = new Map()

// ─── Main entry point ────────────────────────────────────────

async function handleCapitalMessage(message, _pendingMap) {
  if (message.author.bot) return false

  const content = message.content.trim()
  const userId  = message.author.id

  // ── YES / NO confirmation replies ────────────────────────
  const lower = content.toLowerCase()
  if (lower === 'yes' || lower === 'y') {
    const pending = pendingConfirms.get(userId)
    if (!pending) return false
    pendingConfirms.delete(userId)
    await executePendingOps(message, pending)
    return true
  }

  if (lower === 'no' || lower === 'n') {
    if (!pendingConfirms.has(userId)) return false
    pendingConfirms.delete(userId)
    await message.reply('Got it — update discarded. Let me know if you want to re-enter it.')
    return true
  }

  // ── Capital-related message detection ────────────────────
  // Only process if message looks like a capital update
  const capitalKeywords = [
    'teaser', 'nda', 'cim', 'call', 'model', 'term sheet', 'termsheet',
    'passed', 'pass ', 'invested', 'committed', 'signed', 'diligence',
    'dd ', 'raise', 'lender', 'investor', 'equity', 'debt', 'sofr',
    'closing fee', 'interest', 'senior', 'mezz', 'unitranche',
  ]
  const isCapitalMsg = capitalKeywords.some(kw => lower.includes(kw))
  if (!isCapitalMsg) return false

  // ── Load active raises for context ───────────────────────
  const { data: raises } = await supabase
    .from('capital_raises')
    .select(`
      id, name, status,
      raise_participants ( id, firm_name, contact_name, status, committed_amount, debt_amount )
    `)
    .in('status', ['Open', 'active'])

  if (!raises || raises.length === 0) {
    // No active raises — still parse but note it
  }

  // ── Ask Claude to parse the update ───────────────────────
  const systemPrompt = `You are an assistant for Evolution Strategy, an independent sponsor PE firm.
You help log capital raise updates from free-text messages into a structured database.

Active raises and their participants:
${JSON.stringify(raises, null, 2)}

Valid participant statuses:
outreach | teaser_sent | nda_signed | cim_sent | call_had | model_sent | in_dd | term_sheet | invested | confirmed | pass | no_response

Milestone date fields (use ISO YYYY-MM-DD):
teaser_date | nda_date | cim_date | first_call_date | model_date | term_sheet_date | invested_date | pass_date

Other updatable fields:
committed_amount (number, dollars) | debt_amount (number, dollars) | pricing_notes (string) |
pass_reason (string, verbatim if quoted) | notes (string) | contact_name | contact_email | contact_phone

Today's date: ${new Date().toISOString().split('T')[0]}

Return ONLY valid JSON in this exact shape. No prose, no markdown, no explanation.
If you cannot confidently identify a raise or participant, set "confidence": "low".

{
  "confidence": "high" | "medium" | "low",
  "raise_name": "<matched raise name or null>",
  "raise_id": "<UUID or null>",
  "updates": [
    {
      "participant_id": "<UUID>",
      "firm_name": "<for display>",
      "field_changes": {
        "<field>": "<new_value>"
      },
      "new_activity": {
        "event_type": "<type>",
        "summary": "<short summary>",
        "detail": "<longer notes if any>"
      } | null
    }
  ],
  "new_participant": {
    "firm_name": "...",
    "contact_name": "...",
    "firm_type": "...",
    "status": "...",
    "notes": "..."
  } | null,
  "ambiguity": "<explain if anything is unclear>"
}`

  let parsed
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: content }],
      system: systemPrompt,
    })
    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch (err) {
    console.error('Bot parse error:', err)
    return false  // let other handlers try
  }

  if (parsed.confidence === 'low' || (!parsed.updates?.length && !parsed.new_participant)) {
    await message.reply(
      `I picked up a capital-related message but couldn't confidently identify what to update.\n` +
      (parsed.ambiguity ? `\nUnclear: ${parsed.ambiguity}` : '') +
      `\nTry being more specific, e.g.:\n> "Sinclair sent a term sheet on Coggins — $12M senior, SOFR+4.5"\n> "BMO passed on DiPonio, geographic concentration"\n> "Had a call with Timber Bay today, they're interested"`
    )
    return true
  }

  // ── Build confirmation message ────────────────────────────
  const lines = []
  lines.push(`📋 **${parsed.raise_name ?? 'Capital raise'} update**\n`)

  if (parsed.updates?.length) {
    for (const u of parsed.updates) {
      lines.push(`**${u.firm_name}**`)
      for (const [field, val] of Object.entries(u.field_changes ?? {})) {
        const oldVal = getOldValue(raises, u.participant_id, field)
        lines.push(`  • ${humanField(field)}: ${oldVal ? `\`${oldVal}\` → ` : ''}\`${val}\``)
      }
      if (u.new_activity) {
        lines.push(`  • Activity logged: ${u.new_activity.summary}`)
        if (u.new_activity.detail) lines.push(`    _${u.new_activity.detail}_`)
      }
    }
  }

  if (parsed.new_participant) {
    lines.push(`\n**New participant:** ${parsed.new_participant.firm_name}`)
    lines.push(`  Status: ${parsed.new_participant.status}`)
  }

  if (parsed.ambiguity) {
    lines.push(`\n⚠️ _Note: ${parsed.ambiguity}_`)
  }

  lines.push(`\nReply **yes** to confirm or **no** to discard.`)

  // Store pending
  pendingConfirms.set(userId, { parsed, raises, loggedBy: message.author.username })

  await message.reply(lines.join('\n'))
  return true
}

// ─── Execute confirmed ops ────────────────────────────────────

async function executePendingOps(message, { parsed, raises, loggedBy }) {
  const errors = []
  const done = []

  // Process participant updates
  for (const u of parsed.updates ?? []) {
    const changes = { ...u.field_changes }

    // Update participant fields
    if (Object.keys(changes).length > 0) {
      const { error } = await supabase
        .from('raise_participants')
        .update(changes)
        .eq('id', u.participant_id)
      if (error) { errors.push(`Failed to update ${u.firm_name}: ${error.message}`); continue }
    }

    // Log activity
    if (u.new_activity) {
      await supabase.from('raise_activity').insert({
        participant_id: u.participant_id,
        raise_id: parsed.raise_id,
        event_date: changes.pass_date ?? changes.invested_date ?? new Date().toISOString().split('T')[0],
        event_type: u.new_activity.event_type,
        summary: u.new_activity.summary,
        detail: u.new_activity.detail ?? null,
        logged_by: loggedBy,
        source: 'discord_bot',
      })
    }

    done.push(u.firm_name)
  }

  // Add new participant
  if (parsed.new_participant) {
    const { error } = await supabase.from('raise_participants').insert({
      raise_id: parsed.raise_id,
      ...parsed.new_participant,
    })
    if (error) errors.push(`Failed to add ${parsed.new_participant.firm_name}: ${error.message}`)
    else done.push(`Added ${parsed.new_participant.firm_name}`)
  }

  if (errors.length) {
    await message.reply(`⚠️ Some updates failed:\n${errors.map(e => `• ${e}`).join('\n')}`)
  } else {
    const crmUrl = process.env.CRM_URL ?? 'https://your-crm.vercel.app'
    await message.reply(
      `✅ Updated: ${done.join(', ')}.\n<${crmUrl}/capital-raises>`
    )
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function getOldValue(raises, participantId, field) {
  for (const r of raises ?? []) {
    for (const p of r.raise_participants ?? []) {
      if (p.id === participantId) return String(p[field] ?? '')
    }
  }
  return null
}

function humanField(field) {
  const map = {
    status: 'Status', teaser_date: 'Teaser', nda_date: 'NDA', cim_date: 'CIM',
    first_call_date: 'First call', model_date: 'Model sent', term_sheet_date: 'Term sheet',
    invested_date: 'Invested date', pass_date: 'Pass date', pass_reason: 'Pass reason',
    committed_amount: 'Amount committed', debt_amount: 'Debt amount',
    pricing_notes: 'Pricing', notes: 'Notes',
  }
  return map[field] ?? field.replace(/_/g, ' ')
}

module.exports = { handleCapitalMessage, pendingConfirms }
