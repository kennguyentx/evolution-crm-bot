const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js')
const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')
const fetch = require('node-fetch')
const { FormData } = require('formdata-node')
const fs = require('fs')
const path = require('path')
const os = require('os')

require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─────────────────────────────────────────────────
// SLASH COMMANDS
// ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('deal')
    .setDescription('Deal management')
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List active pipeline')
      .addStringOption(opt => opt.setName('stage').setDescription('Filter by stage').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('search')
      .setDescription('Search all deals by company name (including past/dead deals)')
      .addStringOption(opt => opt.setName('company').setDescription('Company name to search').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('update')
      .setDescription('Update deal stage')
      .addStringOption(opt => opt.setName('company').setDescription('Company name').setRequired(true))
      .addStringOption(opt => opt.setName('stage').setDescription('New stage').setRequired(true)
        .addChoices(
          { name: 'Teaser',              value: 'Teaser' },
          { name: 'Reviewing',           value: 'Reviewing' },
          { name: 'Pre-LOI',             value: 'Pre-LOI' },
          { name: 'LOI Submitted',       value: 'LOI Submitted' },
          { name: 'Exclusivity',         value: 'Exclusivity' },
          { name: 'Closed (Platform)',   value: 'Closed (Platform)' },
          { name: 'Closed (Add-On)',     value: 'Closed (Add-On)' },
          { name: 'Pass (DOA)',          value: 'Pass (DOA)' },
          { name: 'Pass (Pre-LOI)',      value: 'Pass (Pre-LOI)' },
          { name: 'Pass (Post-LOI)',     value: 'Pass (Post-LOI)' },
          { name: 'Hold',               value: 'Hold' },
        ))
    )
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View deal details')
      .addStringOption(opt => opt.setName('company').setDescription('Company name').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('contact')
    .setDescription('Contact management')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a new contact')
      .addStringOption(opt => opt.setName('name').setDescription('Full name').setRequired(true))
      .addStringOption(opt => opt.setName('type').setDescription('Contact type').setRequired(true)
        .addChoices(
          { name: 'Banker', value: 'banker' },
          { name: 'LP / Investor', value: 'lp' },
          { name: 'Lender', value: 'lender' },
          { name: 'Advisor', value: 'advisor' },
          { name: 'Management', value: 'management' },
        ))
      .addStringOption(opt => opt.setName('firm').setDescription('Firm name').setRequired(false))
      .addStringOption(opt => opt.setName('email').setDescription('Email').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List contacts')
      .addStringOption(opt => opt.setName('type').setDescription('Filter by type').setRequired(false))
    ),

  new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Generate and send weekly pipeline digest'),

  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log an interaction')
    .addStringOption(opt => opt.setName('company').setDescription('Company name').setRequired(true))
    .addStringOption(opt => opt.setName('note').setDescription('Interaction note').setRequired(true)),
]

// ─────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────
function fmt(n) {
  if (!n) return '—'
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`
  return `$${n}`
}

const STAGE_EMOJI = {
  'Teaser':            '📥',
  'Reviewing':         '🔍',
  'Pre-LOI':           '📋',
  'LOI Submitted':     '📝',
  'Exclusivity':       '🤝',
  'Closed (Platform)': '✅',
  'Closed (Add-On)':   '✅',
  'Pass (DOA)':        '❌',
  'Pass (Pre-LOI)':    '❌',
  'Pass (Post-LOI)':   '❌',
  'Hold':              '⏸️',
}

async function findDeal(company) {
  const { data } = await supabase
    .from('deals')
    .select('*')
    .ilike('company_name', `%${company}%`)
    .limit(1)
  return data?.[0] || null
}

// ─────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────
async function handleDealSearch(interaction) {
  const company = interaction.options.getString('company')

  const { data: deals } = await supabase
    .from('deals')
    .select('id, company_name, stage, status, ebitda, revenue, sector, geography, sourced_date, source_notes, pass_reason, notes')
    .ilike('company_name', `%${company}%`)
    .order('sourced_date', { ascending: false })

  if (!deals || deals.length === 0) {
    return interaction.reply({ content: `🔍 No deals found matching "${company}"`, ephemeral: true })
  }

  let msg = `🔍 **Search results for "${company}"** — ${deals.length} deal(s) found\n\n`

  deals.forEach(d => {
    const emoji = d.status === 'Closed' ? '✅' : d.status === 'Dead' ? '❌' : '🔄'
    msg += `${emoji} **${d.company_name}** — \`${d.stage}\` (${d.status})\n`
    if (d.sector) msg += `  📌 ${d.sector}${d.geography ? ' · ' + d.geography : ''}\n`
    if (d.ebitda || d.revenue) {
      const fin = []
      if (d.revenue) fin.push('Rev: ' + fmt(d.revenue))
      if (d.ebitda)  fin.push('EBITDA: ' + fmt(d.ebitda))
      msg += `  💰 ${fin.join(' · ')}\n`
    }
    if (d.source_notes) msg += `  🏦 ${d.source_notes}\n`
    if (d.sourced_date) msg += `  📅 Sourced: ${new Date(d.sourced_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}\n`
    if (d.pass_reason)  msg += `  ⚠️ Pass reason: ${d.pass_reason}\n`
    if (d.notes && d.status === 'Dead') {
      const shortNote = d.notes.replace(/SF Stage:.*|Fiscal Period:.*/g, '').trim().slice(0, 120)
      if (shortNote) msg += `  📝 ${shortNote}\n`
    }
    msg += '\n'
  })

  await interaction.reply({ content: msg.slice(0, 2000), ephemeral: true })
}

async function handleDealList(interaction) {
  const stageFilter = interaction.options.getString('stage')

  let query = supabase.from('deals').select('*').eq('status', 'Active').order('stage')
  if (stageFilter) query = query.eq('stage', stageFilter)
  const { data: deals } = await query

  if (!deals?.length) {
    return interaction.reply({ content: '📋 No active deals found.', ephemeral: true })
  }

  const grouped = {}
  deals.forEach(d => {
    if (!grouped[d.stage]) grouped[d.stage] = []
    grouped[d.stage].push(d)
  })

  let msg = `**📊 Active Pipeline** — ${deals.length} deals\n\n`
  for (const [stage, stageDeals] of Object.entries(grouped)) {
    msg += `**${STAGE_EMOJI[stage] || '•'} ${stage}** (${stageDeals.length})\n`
    stageDeals.forEach(d => {
      msg += `  • **${d.company_name}** — ${d.sector || 'Unknown'}`
      if (d.ebitda) msg += ` | EBITDA: ${fmt(d.ebitda)}`
      if (d.geography) msg += ` | ${d.geography}`
      msg += '\n'
    })
    msg += '\n'
  }

  await interaction.reply({ content: msg.slice(0, 2000) })
}

async function handleDealUpdate(interaction) {
  const company = interaction.options.getString('company')
  const stage = interaction.options.getString('stage')
  const deal = await findDeal(company)

  if (!deal) {
    return interaction.reply({ content: `❌ No deal found matching "${company}"`, ephemeral: true })
  }

  await supabase.from('deals').update({ stage }).eq('id', deal.id)

  await interaction.reply({
    content: `✅ **${deal.company_name}** updated: \`${deal.stage}\` → \`${stage}\``,
  })
}

async function handleDealView(interaction) {
  const company = interaction.options.getString('company')
  const deal = await findDeal(company)

  if (!deal) {
    return interaction.reply({ content: `❌ No deal found matching "${company}"`, ephemeral: true })
  }

  let msg = `**${STAGE_EMOJI[deal.stage] || '•'} ${deal.company_name}**\n`
  msg += `Stage: \`${deal.stage}\` | Status: \`${deal.status}\`\n`
  if (deal.sector) msg += `Sector: ${deal.sector}\n`
  if (deal.geography) msg += `Geography: ${deal.geography}\n`
  if (deal.ebitda) msg += `EBITDA: ${fmt(deal.ebitda)}\n`
  if (deal.revenue) msg += `Revenue: ${fmt(deal.revenue)}\n`
  if (deal.asking_price) msg += `Asking: ${fmt(deal.asking_price)}\n`
  if (deal.ev_ebitda_multiple) msg += `EV/EBITDA: ${deal.ev_ebitda_multiple.toFixed(1)}x\n`
  if (deal.source_notes) msg += `Source: ${deal.source_notes}\n`
  if (deal.cim_summary) msg += `\n📄 **CIM Summary**\n${deal.cim_summary}\n`
  if (deal.notes) msg += `\n📝 **Notes**\n${deal.notes}`

  await interaction.reply({ content: msg.slice(0, 2000), ephemeral: true })
}

async function handleContactAdd(interaction) {
  const fullName = interaction.options.getString('name')
  const type = interaction.options.getString('type')
  const firm = interaction.options.getString('firm')
  const email = interaction.options.getString('email')
  const parts = fullName.trim().split(' ')
  const first_name = parts[0]
  const last_name = parts.slice(1).join(' ') || '—'

  const { error } = await supabase.from('contacts').insert({
    first_name, last_name, contact_type: type,
    firm: firm || null, email: email || null,
  })

  if (error) return interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true })
  await interaction.reply({ content: `✅ Contact **${fullName}** (${type}${firm ? ` @ ${firm}` : ''}) added.` })
}

async function handleContactList(interaction) {
  const typeFilter = interaction.options.getString('type')
  let query = supabase.from('contacts').select('*').order('last_name')
  if (typeFilter) query = query.eq('contact_type', typeFilter)
  const { data: contacts } = await query

  if (!contacts?.length) return interaction.reply({ content: '👥 No contacts found.', ephemeral: true })

  let msg = `**👥 Contacts** — ${contacts.length} total\n\n`
  contacts.slice(0, 20).forEach(c => {
    msg += `• **${c.first_name} ${c.last_name}**`
    if (c.firm) msg += ` @ ${c.firm}`
    msg += ` \`${c.contact_type}\``
    if (c.email) msg += ` — ${c.email}`
    msg += '\n'
  })
  if (contacts.length > 20) msg += `_...and ${contacts.length - 20} more_`

  await interaction.reply({ content: msg.slice(0, 2000), ephemeral: true })
}

async function handleDigest(interaction) {
  await interaction.deferReply()
  const { data: deals } = await supabase.from('deals').select('*').order('updated_at', { ascending: false })

  const activeDeals = (deals || []).filter(d => d.status === 'Active')
  const dealSummary = activeDeals.map(d =>
    `- ${d.company_name} | ${d.stage} | ${d.sector || 'Unknown'} | EBITDA: ${d.ebitda ? '$' + (d.ebitda/1e6).toFixed(1)+'M' : 'unknown'}`
  ).join('\n')

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Write a brief weekly pipeline digest for Evolution Strategy (independent sponsor, infra/industrial services). Active pipeline (${activeDeals.length} deals):\n${dealSummary || 'Empty pipeline'}\n\nFormat for Discord: short, punchy, use bullet points and bold. Max 1500 chars.`,
    }],
  })

  const digest = response.content.filter(b => b.type === 'text').map(b => b.text).join('')
  await interaction.editReply({ content: digest.slice(0, 2000) })
}

async function handleLog(interaction) {
  const company = interaction.options.getString('company')
  const note = interaction.options.getString('note')
  const deal = await findDeal(company)

  const { error } = await supabase.from('interactions').insert({
    deal_id: deal?.id || null,
    interaction_type: 'call',
    summary: note,
    interaction_date: new Date().toISOString(),
    logged_by: interaction.user.username,
  })

  if (error) return interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true })
  await interaction.reply({
    content: `📝 Interaction logged${deal ? ` on **${deal.company_name}**` : ''}: ${note}`,
  })
}

// ─────────────────────────────────────────────────
// CIM ATTACHMENT HANDLER
// ─────────────────────────────────────────────────

// Store pending deals waiting for missing field input
const pendingDeals = new Map()

async function saveDeal(parsed, replyMsg) {
  const { data, error } = await supabase.from('deals').insert({
    company_name:   parsed.company_name || 'Unknown',
    sector:         parsed.sector || null,
    geography:      parsed.geography || null,
    deal_type:      parsed.deal_type || 'platform',
    revenue:        parsed.revenue || null,
    ebitda:         parsed.ebitda || null,
    description:    parsed.cim_summary || null,
    cim_summary:    parsed.cim_summary || null,
    source_notes:   parsed.banker_firm || null,
    stage:          'Teaser',
    status:         'Active',
    cim_parsed:     true,
    expected_close: new Date().toISOString().split('T')[0],
  }).select().single()

  if (error) throw new Error(error.message)

  // Link selected contact if provided
  let contactNote = ''
  if (parsed.selectedContact && data) {
    const c = parsed.selectedContact
    await supabase.from('contact_deal_links').insert({ contact_id: c.id, deal_id: data.id, role: 'Source / Banker' })
    contactNote = ' ✅ linked to ' + c.first_name + ' ' + c.last_name
  }

  let msg = '✅ **' + (parsed.company_name || 'Unknown') + '** saved to pipeline as **Teaser**\n\n'
  if (parsed.sector)      msg += '📌 ' + parsed.sector + '\n'
  if (parsed.geography)   msg += '📍 ' + parsed.geography + '\n'
  if (parsed.revenue)     msg += '📈 Revenue: ' + fmt(parsed.revenue) + '\n'
  if (parsed.ebitda)      msg += '💰 EBITDA: ' + fmt(parsed.ebitda) + '\n'
  if (parsed.banker_name) msg += '🏦 ' + parsed.banker_name + (parsed.banker_firm ? ' @ ' + parsed.banker_firm : '') + contactNote + '\n'
  if (parsed.cim_summary) msg += '\n' + parsed.cim_summary

  await replyMsg.edit(msg.slice(0, 2000))
  return data
}

async function handleCIMAttachment(message, attachment) {
  if (!attachment.name.toLowerCase().endsWith('.pdf')) return

  const reply = await message.reply('📄 Parsing CIM with Claude...')

  try {
    const res = await fetch(attachment.url)
    const buffer = await res.buffer()
    const base64 = buffer.toString('base64')

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: `You extract factual deal data from teasers and CIMs. Return ONLY valid JSON, no markdown, no opinions.

Fields:
- company_name: exact company name
- sector: one of: Underground Utilities | Electrical Contracting | Civil / Public Works | Commercial Landscaping | Fiber Optics | HVAC | Plumbing | Industrial Services | Environmental Services | Construction & Engineering | Other
- geography: primary state(s) or region as stated
- deal_type: one of: platform | add-on | recap | growth
- revenue: number in raw dollars or null (4200000 for $4.2M)
- ebitda: number in raw dollars or null
- cim_summary: 3-5 factual sentences about what company does, where it operates, financial profile, transaction context. No opinions or qualitative words.
- banker_name: full name of banker or null
- banker_firm: advisory firm name or null

Return null for anything not explicitly stated.`,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Extract deal data. Return only valid JSON.' },
        ],
      }],
    })

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)

    // Check for duplicate deals
    if (parsed.company_name) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id, company_name, stage, status, created_at')
        .ilike('company_name', `%${parsed.company_name}%`)
        .limit(3)
      if (existing && existing.length > 0) {
        let dupMsg = `⚠️ **Possible duplicate detected!** Found ${existing.length} similar deal(s):\n\n`
        existing.forEach(d => {
          dupMsg += `• **${d.company_name}** — ${d.stage} (${d.status})\n`
        })
        dupMsg += `\nThis may be the same company. The new deal will still be shown for review below.`
        await message.reply(dupMsg.slice(0, 2000))
      }
    }

    // Always show preview first
    const pendingId = `${message.author.id}_${Date.now()}`
    const required = [
      { key: 'company_name', label: 'Company Name' },
      { key: 'sector',       label: 'Sector (e.g. Underground Utilities, Electrical Contracting)' },
      { key: 'geography',    label: 'Geography (state or region)' },
      { key: 'deal_type',    label: 'Deal Type (platform / add-on / recap / growth)' },
      { key: 'revenue',      label: 'Revenue in $M (e.g. 18.5)' },
      { key: 'ebitda',       label: 'EBITDA in $M (e.g. 4.2)' },
    ]
    const missing = required.filter(f => !parsed[f.key])
    pendingDeals.set(pendingId, { parsed, missing, replyMsg: reply, awaitingConfirm: true, bankerStep: null, bankerResults: null, newContact: null })

    let msg = '📄 **Parsed: ' + (parsed.company_name || 'Unknown') + '**\n\n'
    msg += '**Extracted fields:**\n'
    msg += (parsed.company_name ? '✅' : '❌') + ' Company: ' + (parsed.company_name || 'Missing') + '\n'
    msg += (parsed.sector       ? '✅' : '❌') + ' Sector: '  + (parsed.sector || 'Missing') + '\n'
    msg += (parsed.geography    ? '✅' : '❌') + ' Geography: ' + (parsed.geography || 'Missing') + '\n'
    msg += (parsed.deal_type    ? '✅' : '❌') + ' Deal Type: ' + (parsed.deal_type || 'Missing') + '\n'
    msg += (parsed.revenue      ? '✅' : '❌') + ' Revenue: ' + (parsed.revenue ? fmt(parsed.revenue) : 'Missing') + '\n'
    msg += (parsed.ebitda       ? '✅' : '❌') + ' EBITDA: '  + (parsed.ebitda  ? fmt(parsed.ebitda)  : 'Missing') + '\n'
    msg += (parsed.banker_name ? '✅' : '❌') + ' Banker: ' + (parsed.banker_name ? parsed.banker_name + (parsed.banker_firm ? ' @ ' + parsed.banker_firm : '') : 'Missing') + '\n'
    msg += '\n'
    if (missing.length > 0) {
      msg += '⚠️ **Missing fields - reply with values one per line:**\n'
      missing.forEach((f, i) => { msg += (i+1) + '. ' + f.label + '\n' })
      msg += '\nOr reply `save` to save as-is, or `cancel` to discard.'
    } else {
      msg += 'Reply `save` to confirm, or correct any field by replying\nFieldName: New Value\n(e.g. `Sector: Civil / Public Works`)\nReply `cancel` to discard.'
    }
    await reply.edit(msg.slice(0, 2000))
    setTimeout(() => pendingDeals.delete(pendingId), 10 * 60 * 1000)
  } catch (err) {
    console.error(err)
    await reply.edit(`❌ Failed to parse CIM: ${err.message}`)
  }
}
// ─────────────────────────────────────────────────
// BOT SETUP
// ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once('ready', async () => {
  console.log(`✅ Evolution CRM Bot ready as ${client.user.tag}`)

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands.map(c => c.toJSON()) }
  )
  console.log('✅ Slash commands registered')
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  const sub = interaction.options.getSubcommand(false)

  try {
    if (interaction.commandName === 'deal') {
      if (sub === 'list') await handleDealList(interaction)
      else if (sub === 'search') await handleDealSearch(interaction)
      else if (sub === 'update') await handleDealUpdate(interaction)
      else if (sub === 'view') await handleDealView(interaction)
    } else if (interaction.commandName === 'contact') {
      if (sub === 'add') await handleContactAdd(interaction)
      else if (sub === 'list') await handleContactList(interaction)
    } else if (interaction.commandName === 'digest') {
      await handleDigest(interaction)
    } else if (interaction.commandName === 'log') {
      await handleLog(interaction)
    }
  } catch (err) {
    console.error(err)
    const msg = { content: `❌ Error: ${err.message}`, ephemeral: true }
    if (interaction.deferred) await interaction.editReply(msg)
    else await interaction.reply(msg)
  }
})

// Handle CIM uploads and missing field replies
client.on('messageCreate', async message => {
  if (message.author.bot) return
  const intakeChannel = process.env.DISCORD_INTAKE_CHANNEL || 'deal-intake'
  const inIntakeChannel = message.channel.name?.includes(intakeChannel)

  // Check if this is a reply to a pending deal prompt
  if (inIntakeChannel && !message.attachments.size) {
    const userKey = `${message.author.id}_`
    // Find any pending deal for this user
    for (const [pendingId, pending] of pendingDeals.entries()) {
      if (!pendingId.startsWith(userKey)) continue

      const cmd = message.content.trim().toLowerCase()

      if (cmd === 'cancel') {
        pendingDeals.delete(pendingId)
        await message.reply('❌ Deal discarded.')
        return
      }

      if (cmd === 'save' || cmd === 'skip') {
        if (!pending.bankerStep && cmd !== 'skip') {
          // If AI found a banker name, go to search first
          if (pending.parsed.banker_name) {
            pending.bankerStep = 'search'
            const hint = pending.parsed.banker_name + (pending.parsed.banker_firm ? ' @ ' + pending.parsed.banker_firm : '')
            await message.reply('🏦 **Source banker:** AI extracted "' + hint + '"\nType a name or firm to search your contacts DB, or type `confirm` to use this as-is, or `skip` to save without a contact.')
          } else {
            // No banker found — show quick entry form
            pending.bankerStep = 'new'
            pending.newContact = { first_name: '', last_name: '', firm: '', email: '', phone: '' }
            await message.reply('🏦 **No banker found in document. Add one?**\nReply with details (one per line):\n1. First name\n2. Last name\n3. Firm\n4. Email (optional)\n5. Phone (optional)\n\nOr type `skip` to save without a contact.\nOr type a name/firm to search existing contacts.')
          }
          return
        }
        pendingDeals.delete(pendingId)
        try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
        return
      }

      // Banker search flow
      if (pending.bankerStep === 'search') {
        if (cmd === 'skip') {
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        // confirm = save with AI-extracted banker name (no DB link)
        if (cmd === 'confirm') {
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        // Search contacts by name and firm
        const q = message.content.trim()
        const parts = q.split(' ').filter(Boolean)
        let contacts = []
        if (parts.length >= 2) {
          const { data: nameResults } = await supabase.from('contacts')
            .select('id, first_name, last_name, firm, title, contact_type')
            .ilike('first_name', '%' + parts[0] + '%')
            .ilike('last_name', '%' + parts[parts.length-1] + '%')
            .limit(5)
          contacts = nameResults || []
        }
        if (contacts.length === 0) {
          const { data: anyResults } = await supabase.from('contacts')
            .select('id, first_name, last_name, firm, title, contact_type')
            .or('first_name.ilike.%' + q + '%,last_name.ilike.%' + q + '%,firm.ilike.%' + q + '%')
            .limit(5)
          contacts = anyResults || []
        }
        pending.bankerResults = contacts
        if (contacts.length === 0) {
          pending.bankerStep = 'new'
          pending.newContact = { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '', firm: pending.parsed.banker_firm || '', email: '', phone: '' }
          let msg = '❌ **No contacts found for "' + q + '"**\n\nAdd as new contact? Reply with their details:\n'
          msg += '1. First name: ' + (pending.newContact.first_name || '?') + '\n'
          msg += '2. Last name: ' + (pending.newContact.last_name || '?') + '\n'
          msg += '3. Firm: ' + (pending.newContact.firm || '?') + '\n'
          msg += '4. Email (optional)\n\n'
          msg += 'Reply with corrections line by line, or type `confirm` to save as shown, or `skip` to save deal without a contact.'
          await message.reply(msg)
        } else {
          pending.bankerStep = 'pick'
          let msg = '🔍 **Found ' + contacts.length + ' contact(s):**\n\n'
          contacts.forEach((c, i) => { msg += (i+1) + '. **' + c.first_name + ' ' + c.last_name + '**' + (c.firm ? ' @ ' + c.firm : '') + (c.title ? ' — ' + c.title : '') + '\n' })
          msg += '\nReply with the number to select, `new` to add a new contact, or `skip` to save without linking.'
          await message.reply(msg)
        }
        return
      }

      // Banker pick from results
      if (pending.bankerStep === 'pick') {
        if (cmd === 'skip') {
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        if (cmd === 'new') {
          pending.bankerStep = 'new'
          pending.newContact = { first_name: '', last_name: '', firm: pending.parsed.banker_firm || '', email: '', phone: '' }
          await message.reply('Add new contact:\n1. First name\n2. Last name\n3. Firm: ' + (pending.newContact.firm || '?') + '\n4. Email (optional)\n5. Phone (optional)\n\nReply with values line by line, or `confirm` to save as-is.')
          return
        }
        const num = parseInt(cmd)
        if (num >= 1 && num <= (pending.bankerResults || []).length) {
          pending.parsed.selectedContact = pending.bankerResults[num-1]
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        // If they typed something else, re-search
        pending.bankerStep = 'search'
        await message.reply('Search again with: ' + message.content)
        // re-trigger search
        return
      }

      // New contact entry
      if (pending.bankerStep === 'new') {
        if (cmd === 'skip') {
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        if (cmd === 'confirm') {
          // Create contact and link
          const nc = pending.newContact
          if (!nc.first_name || !nc.last_name) {
            await message.reply('❌ First and last name are required. Please provide them.')
            return
          }
          const { data: newC } = await supabase.from('contacts').insert({
            first_name: nc.first_name, last_name: nc.last_name,
            firm: nc.firm || null, email: nc.email || null, phone: nc.phone || null,
            contact_type: 'banker', sub_type: 'M&A banker / intermediary', relationship_strength: 'Cold',
          }).select().single()
          if (newC) pending.parsed.selectedContact = newC
          pending.bankerStep = null
          pendingDeals.delete(pendingId)
          try { await saveDeal(pending.parsed, pending.replyMsg) } catch (e) { await pending.replyMsg.edit('❌ Save failed: ' + e.message) }
          return
        }
        // Update new contact fields line by line
        const lines = message.content.trim().split('\n').map(l => l.trim()).filter(Boolean)
        if (lines[0]) pending.newContact.first_name = lines[0]
        if (lines[1]) pending.newContact.last_name = lines[1]
        if (lines[2]) pending.newContact.firm = lines[2]
        if (lines[3]) pending.newContact.email = lines[3]
        if (lines[4]) pending.newContact.phone = lines[4]
        const nc = pending.newContact
        let msg = '📝 **New contact preview:**\n'
        msg += 'First: ' + (nc.first_name || '❌ missing') + '\n'
        msg += 'Last: ' + (nc.last_name || '❌ missing') + '\n'
        msg += 'Firm: ' + (nc.firm || '—') + '\n'
        msg += 'Email: ' + (nc.email || '—') + '\n'
        msg += 'Phone: ' + (nc.phone || '—') + '\n\n'
        msg += 'Reply `confirm` to create and link, or correct fields above.'
        await message.reply(msg)
        return
      }

      // Field correction: "Sector: Civil / Public Works"
      if (message.content.includes(':')) {
        const colonIdx = message.content.indexOf(':')
        const fieldRaw = message.content.slice(0, colonIdx).trim().toLowerCase()
        const value = message.content.slice(colonIdx + 1).trim()
        const fieldMap = { 'company': 'company_name', 'company name': 'company_name', 'sector': 'sector', 'geography': 'geography', 'location': 'geography', 'deal type': 'deal_type', 'type': 'deal_type', 'revenue': 'revenue', 'ebitda': 'ebitda', 'banker': 'banker_name', 'firm': 'banker_firm' }
        const fieldKey = fieldMap[fieldRaw]
        if (fieldKey) {
          if (fieldKey === 'revenue' || fieldKey === 'ebitda') {
            const num = parseFloat(value.replace(/[^0-9.]/g, ''))
            if (!isNaN(num)) pending.parsed[fieldKey] = num >= 1000 ? num : num * 1_000_000
          } else {
            pending.parsed[fieldKey] = value
          }
          pending.missing = pending.missing.filter(f => f.key !== fieldKey)
          await message.reply('Updated ' + fieldKey + ' to: ' + value + '\nReply `save` to confirm or continue editing.')
          return
        }
      }

      // Line-by-line for missing fields
      if (pending.missing.length > 0) {
        const lines = message.content.trim().split('\n').map(l => l.trim()).filter(Boolean)
        lines.forEach((line, i) => {
          if (i >= pending.missing.length) return
          const field = pending.missing[i]
          if (field.key === 'revenue' || field.key === 'ebitda') {
            const num = parseFloat(line.replace(/[^0-9.]/g, ''))
            if (!isNaN(num)) pending.parsed[field.key] = num >= 1000 ? num : num * 1_000_000
          } else {
            pending.parsed[field.key] = line
          }
        })
        pending.missing = pending.missing.filter(f => !pending.parsed[f.key])
      }

      // Show updated preview
      let msg = '📄 **Updated: ' + (pending.parsed.company_name || 'Unknown') + '**\n'
      msg += (pending.parsed.company_name ? '✅' : '❌') + ' Company: ' + (pending.parsed.company_name || 'Missing') + '\n'
      msg += (pending.parsed.sector       ? '✅' : '❌') + ' Sector: '  + (pending.parsed.sector || 'Missing') + '\n'
      msg += (pending.parsed.geography    ? '✅' : '❌') + ' Geography: ' + (pending.parsed.geography || 'Missing') + '\n'
      msg += (pending.parsed.deal_type    ? '✅' : '❌') + ' Deal Type: ' + (pending.parsed.deal_type || 'Missing') + '\n'
      msg += (pending.parsed.revenue      ? '✅' : '❌') + ' Revenue: ' + (pending.parsed.revenue ? fmt(pending.parsed.revenue) : 'Missing') + '\n'
      msg += (pending.parsed.ebitda       ? '✅' : '❌') + ' EBITDA: '  + (pending.parsed.ebitda ? fmt(pending.parsed.ebitda) : 'Missing') + '\n'
      if (pending.missing.length > 0) {
        msg += '\n⚠️ Still missing:\n'
        pending.missing.forEach((f, i) => { msg += (i+1) + '. ' + f.label + '\n' })
        msg += 'Reply with values, or `save` to save as-is, or `cancel`.'
      } else {
        msg += '\n✅ All complete! Reply `save` to confirm or `cancel` to discard.'
      }
      await message.reply(msg.slice(0, 2000))
      return
    }
  }

  // Handle PDF attachments in intake channel
  if (inIntakeChannel) {
    for (const attachment of message.attachments.values()) {
      await handleCIMAttachment(message, attachment)
    }
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)
