// ============================================================
// Evolution Strategy Discord Bot — Meeting Notes Handler
// File: meetingNotesHandler.js
//
// Wire into index.js:
//   const { handleMeetingNotes } = require('./meetingNotesHandler')
//   // inside messageCreate, before other handlers:
//   if (await handleMeetingNotes(message)) return
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
//   DISCORD_NOTES_CHANNEL=meeting-notes  (or whatever you name it)
// ============================================================

const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const NOTES_CHANNEL = process.env.DISCORD_NOTES_CHANNEL || 'meeting-notes'

// ─── Main entry point ────────────────────────────────────────

async function handleMeetingNotes(message) {
  if (message.author.bot) return false
  if (!message.channel.name?.includes(NOTES_CHANNEL)) return false

  const raw = message.content.trim()
  if (!raw || raw.length < 10) return false

  console.log(`[meetingNotes] processing message from ${message.author.username}`)

  // Who logged it
  const loggedBy = message.member?.displayName || message.author.username

  await message.react('⏳')

  try {
    console.log(`[meetingNotes] parsing notes...`)
    const parsed = await parseNotes(raw, loggedBy)
    console.log(`[meetingNotes] parsed, persisting...`)
    const result = await persistNote(raw, parsed, loggedBy)
    console.log(`[meetingNotes] persisted, posting confirmation...`)
    await message.reactions.removeAll().catch(() => {})
    await postConfirmation(message, parsed, result)
    console.log(`[meetingNotes] done`)
  } catch (err) {
    console.error(`[meetingNotes] error:`, err)
    await message.reactions.removeAll().catch(() => {})
    await message.reply(`❌ Failed to log note: ${err.message}`)
  }

  return true
}

// ─── Parse with Claude ───────────────────────────────────────

async function parseNotes(raw, loggedBy) {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are parsing meeting notes for a small private equity firm called Evolution Strategy.
Extract structured data from these notes and return ONLY valid JSON, no markdown, no explanation.

Notes:
${raw}

Return this exact JSON shape:
{
  "note_date": "YYYY-MM-DD or null if not mentioned (use today if unclear)",
  "summary": "2-4 sentence clean summary of what was discussed",
  "next_steps": "specific follow-up actions mentioned, or null",
  "sentiment": "interested | neutral | passing | passed — based on the counterparty's response",
  "people": ["full names mentioned"],
  "companies": ["company or firm names mentioned"],
  "deal_keywords": ["keywords that might match a deal company name"],
  "raise_keywords": ["keywords suggesting a capital raise e.g. 'DiPonio equity', 'Coggins debt'"],
  "deal_stage_change": "new stage if notes imply a stage change (Teaser/Reviewing/Pre-LOI/LOI Submitted/Exclusivity/Closed (Platform)/Closed (Add-On)/Pass (DOA)/Pass (Pre-LOI)/Pass (Post-LOI)/Hold) or null",
  "raise_status_change": "new status for a capital raise participant if implied (outreach/teaser_sent/nda_signed/cim_sent/call_had/in_dd/term_sheet/invested/pass/no_response) or null"
}`
    }]
  })

  const text = resp.content[0].text.trim()
  return JSON.parse(text)
}

// ─── Match entities in DB ────────────────────────────────────

async function findDeal(keywords) {
  if (!keywords?.length) return null
  for (const kw of keywords) {
    if (!kw || kw.length < 2) continue
    const { data } = await supabase
      .from('deals')
      .select('id, company_name, stage, status')
      .ilike('company_name', `%${kw}%`)
      .limit(1)
    if (data?.[0]) return data[0]
  }
  return null
}

async function findContact(people) {
  if (!people?.length) return null
  for (const name of people) {
    if (!name || name.length < 2) continue
    const parts = name.trim().split(/\s+/)
    if (parts.length < 2) continue
    const { data } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, firm')
      .ilike('first_name', `%${parts[0]}%`)
      .ilike('last_name', `%${parts[parts.length - 1]}%`)
      .limit(1)
    if (data?.[0]) return data[0]
  }
  return null
}

async function findCapitalRaise(keywords) {
  if (!keywords?.length) return null
  for (const kw of keywords) {
    if (!kw || kw.length < 2) continue
    const { data } = await supabase
      .from('capital_raises')
      .select('id, name, status')
      .ilike('name', `%${kw}%`)
      .limit(1)
    if (data?.[0]) return data[0]
  }
  return null
}

async function findCapitalContact(companies, people) {
  const terms = [...(companies || []), ...(people || [])]
  for (const term of terms) {
    if (!term || term.length < 2) continue
    const { data } = await supabase
      .from('capital_contacts')
      .select('id, firm, contact_name')
      .or(`firm.ilike.%${term}%,contact_name.ilike.%${term}%`)
      .limit(1)
    if (data?.[0]) return data[0]
  }
  return null
}

// ─── Persist to DB ───────────────────────────────────────────

async function persistNote(raw, parsed, loggedBy) {
  const [deal, contact, raise, capitalContact] = await Promise.all([
    findDeal(parsed.deal_keywords),
    findContact(parsed.people),
    findCapitalRaise(parsed.raise_keywords),
    findCapitalContact(parsed.companies, parsed.people),
  ])

  // Insert note
  const noteDate = parsed.note_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.note_date)
    ? parsed.note_date
    : new Date().toISOString().split('T')[0]

  const { data: note, error } = await supabase.from('notes').insert({
    raw_text:           raw,
    summary:            parsed.summary,
    next_steps:         parsed.next_steps || null,
    sentiment:          parsed.sentiment || 'neutral',
    deal_id:            deal?.id || null,
    contact_id:         contact?.id || null,
    raise_id:           raise?.id || null,
    capital_contact_id: capitalContact?.id || null,
    logged_by:          loggedBy,
    source:             'discord',
    note_date:          noteDate,
  }).select().single()

  if (error) throw new Error(error.message)

  // Also log to interactions table if we have a deal or contact
  if (deal?.id || contact?.id) {
    await supabase.from('interactions').insert({
      deal_id:          deal?.id || null,
      contact_id:       contact?.id || null,
      interaction_type: 'call',
      interaction_date: new Date().toISOString(),
      summary:          parsed.summary,
      next_steps:       parsed.next_steps || null,
      logged_by:        loggedBy,
    })
  }

  // Log to capital contact call log if matched
  if (capitalContact?.id) {
    await supabase.from('capital_contact_calls').insert({
      contact_id:   capitalContact.id,
      call_date:    noteDate,
      summary:      parsed.summary,
      logged_by:    loggedBy,
      deal_context: deal?.company_name || raise?.name || null,
    })
  }

  // Update deal stage if implied
  let stageUpdated = null
  if (deal?.id && parsed.deal_stage_change) {
    await supabase.from('deals').update({ stage: parsed.deal_stage_change }).eq('id', deal.id)
    await supabase.from('notes').update({ deal_stage_updated: parsed.deal_stage_change }).eq('id', note.id)
    stageUpdated = parsed.deal_stage_change
  }

  // Update raise participant status if implied
  let raiseStatusUpdated = null
  if (raise?.id && parsed.raise_status_change && capitalContact) {
    const { data: participants } = await supabase
      .from('raise_participants')
      .select('id')
      .eq('raise_id', raise.id)
      .ilike('firm_name', `%${capitalContact.firm}%`)
      .limit(1)
    if (participants?.[0]) {
      await supabase.from('raise_participants')
        .update({ status: parsed.raise_status_change })
        .eq('id', participants[0].id)
      await supabase.from('notes').update({ raise_status_updated: parsed.raise_status_change }).eq('id', note.id)
      raiseStatusUpdated = parsed.raise_status_change
    }
  }

  return { note, deal, contact, raise, capitalContact, stageUpdated, raiseStatusUpdated }
}

// ─── Post confirmation ────────────────────────────────────────

async function postConfirmation(message, parsed, result) {
  const { deal, contact, raise, capitalContact, stageUpdated, raiseStatusUpdated } = result

  let msg = `✅ **Note logged**\n\n`
  msg += `📝 ${parsed.summary}\n`

  if (parsed.next_steps) msg += `\n**Next steps:** ${parsed.next_steps}\n`

  msg += `\n**Linked to:**\n`
  if (deal)           msg += `• Deal: ${deal.company_name}${stageUpdated ? ` → stage updated to **${stageUpdated}**` : ''}\n`
  if (contact)        msg += `• Contact: ${contact.first_name} ${contact.last_name}${contact.firm ? ` @ ${contact.firm}` : ''}\n`
  if (raise)          msg += `• Raise: ${raise.name}${raiseStatusUpdated ? ` → status updated to **${raiseStatusUpdated}**` : ''}\n`
  if (capitalContact) msg += `• Capital Contact: ${capitalContact.firm}${capitalContact.contact_name ? ` / ${capitalContact.contact_name}` : ''}\n`
  if (!deal && !contact && !raise && !capitalContact) msg += `• No matches found in Nexus — logged as standalone note\n`

  if (parsed.sentiment && parsed.sentiment !== 'neutral') {
    const emoji = { interested: '🟢', passing: '🟡', passed: '🔴' }[parsed.sentiment] || '⚪'
    msg += `\n**Sentiment:** ${emoji} ${parsed.sentiment}`
  }

  await message.reply(msg)
}

module.exports = { handleMeetingNotes }
