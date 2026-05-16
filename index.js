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
async function handleCIMAttachment(message, attachment) {
  if (!attachment.name.toLowerCase().endsWith('.pdf')) return

  const reply = await message.reply('📄 Parsing CIM with Claude...')

  try {
    // Download PDF
    const res = await fetch(attachment.url)
    const buffer = await res.buffer()
    const base64 = buffer.toString('base64')

    // Parse with Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: `You extract factual deal data from teasers and CIMs. Return ONLY valid JSON, no markdown, no opinions.

{
  "company_name": "exact company name as stated",
  "sector": "one of: Underground Utilities | Electrical Contracting | Civil / Public Works | Commercial Landscaping | Fiber Optics | HVAC | Plumbing | Industrial Services | Environmental Services | Construction & Engineering | Other",
  "geography": "primary state(s) or region as stated",
  "deal_type": "one of: platform | add-on | recap | growth",
  "revenue": "number in raw dollars or null",
  "ebitda": "number in raw dollars or null",
  "cim_summary": "3-5 factual sentences about what company does, where it operates, financial profile, and transaction context. No opinions or qualitative words like attractive or compelling.",
  "banker_name": "full name of banker/broker or null",
  "banker_firm": "investment bank or advisory firm name or null"
}

Dollar values as raw numbers (4200000 for $4.2M). Return null for anything not explicitly stated.`,
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

    // Save to Supabase
    const { data, error } = await supabase.from('deals').insert({
      company_name: parsed.company_name || 'Unknown',
      sector: parsed.sector || null,
      geography: parsed.geography || null,
      deal_type: parsed.deal_type || 'platform',
      revenue: parsed.revenue || null,
      ebitda: parsed.ebitda || null,
      description: parsed.cim_summary || null,
      cim_summary: parsed.cim_summary || null,
      source_notes: parsed.banker_firm || null,
      stage: 'Reviewing',
      status: 'Active',
      cim_parsed: true,
      expected_close: new Date().toISOString().split('T')[0],
    }).select().single()

    if (error) throw error

    let msg = `✅ **${parsed.company_name}** added to pipeline as **Reviewing**\n\n`
    if (parsed.sector) msg += `📌 Sector: ${parsed.sector}\n`
    if (parsed.geography) msg += `📍 Geography: ${parsed.geography}\n`
    if (parsed.revenue) msg += `📈 Revenue: ${fmt(parsed.revenue)}\n`
    if (parsed.ebitda) msg += `💰 EBITDA: ${fmt(parsed.ebitda)}\n`
    if (parsed.banker_name) msg += `🏦 Banker: ${parsed.banker_name}${parsed.banker_firm ? ` @ ${parsed.banker_firm}` : ''}\n`
    if (parsed.cim_summary) msg += `\n${parsed.cim_summary}`

    await reply.edit(msg.slice(0, 2000))
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

// Handle CIM uploads in #deal-intake channel
client.on('messageCreate', async message => {
  if (message.author.bot) return
  const intakeChannel = process.env.DISCORD_INTAKE_CHANNEL || 'deal-intake'
  if (!message.channel.name?.includes(intakeChannel)) return

  for (const attachment of message.attachments.values()) {
    await handleCIMAttachment(message, attachment)
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)
