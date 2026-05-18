// Evolution CRM Agent — conversational interface powered by Claude
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
const { Dropbox, DropboxAuth } = require('dropbox')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const dbxAuth = new DropboxAuth({
  clientId: process.env.DROPBOX_APP_KEY,
  clientSecret: process.env.DROPBOX_APP_SECRET,
  refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
})
const dbx = new Dropbox({ auth: dbxAuth })

function fmt(n) {
  if (!n) return '—'
  if (n >= 1e9) return '$' + (n/1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K'
  return '$' + n
}

// ── Rate limiting: one request per user at a time, 5s cooldown ──────────────
const userCooldowns = new Map()
const COOLDOWN_MS = 5000

function isRateLimited(userId) {
  const last = userCooldowns.get(userId)
  if (!last) return false
  return Date.now() - last < COOLDOWN_MS
}

function setRateLimit(userId) {
  userCooldowns.set(userId, Date.now())
}

// Tools the agent can use
const tools = [
  {
    name: 'search_deals',
    description: 'Search deals by company name, stage, sector, geography, or status. Use for finding deals, checking pipeline, or answering questions about deals.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company name to search (partial match)' },
        stage: { type: 'string', description: 'Deal stage filter' },
        sector: { type: 'string', description: 'Sector filter' },
        geography: { type: 'string', description: 'Geography filter' },
        status: { type: 'string', description: 'Status: Active, Dead, Closed, or all' },
        min_ebitda: { type: 'number', description: 'Minimum EBITDA in dollars' },
        max_ebitda: { type: 'number', description: 'Maximum EBITDA in dollars' },
        limit: { type: 'number', description: 'Max results to return (default 10)' },
      },
    },
  },
  {
    name: 'get_deal',
    description: 'Get full details of a specific deal including contacts, notes, and diligence status.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company name (will find best match)' },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'update_deal',
    description: 'Update a deal — change stage, add notes, update financials, or change status.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company name to find the deal' },
        updates: {
          type: 'object',
          description: 'Fields to update',
          properties: {
            stage: { type: 'string' },
            status: { type: 'string' },
            notes: { type: 'string' },
            description: { type: 'string' },
            revenue: { type: 'number' },
            ebitda: { type: 'number' },
            sector: { type: 'string' },
            geography: { type: 'string' },
          },
        },
      },
      required: ['company_name', 'updates'],
    },
  },
  {
    name: 'log_interaction',
    description: 'Log a call, meeting, email, or note on a deal.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company name' },
        type: { type: 'string', description: 'Type: call, meeting, email, note' },
        summary: { type: 'string', description: 'What happened or was discussed' },
        next_steps: { type: 'string', description: 'Next steps if any' },
      },
      required: ['company_name', 'summary'],
    },
  },
  {
    name: 'search_contacts',
    description: 'Search contacts by name, firm, or type.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or firm to search' },
        contact_type: { type: 'string', description: 'Type: banker, lp, lender, advisor, management' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_pipeline_summary',
    description: 'Get a summary of the active pipeline — deal counts and EBITDA by stage.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_contact',
    description: 'Delete a contact from the CRM. Always confirm with the user before deleting.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or firm to find the contact' },
        confirmed: { type: 'boolean', description: 'Must be true — only delete after user explicitly confirms' },
      },
      required: ['query', 'confirmed'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact — change name, firm, email, phone, title, or type.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or firm to find the contact' },
        updates: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            firm: { type: 'string' },
            title: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            contact_type: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
      required: ['query', 'updates'],
    },
  },
  {
    name: 'create_contact',
    description: 'Create a new contact in the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        firm: { type: 'string' },
        title: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        contact_type: { type: 'string', description: 'banker, lp, lender, advisor, management, other' },
        deal_id: { type: 'string', description: 'If provided, link this contact to a deal as Source / Banker' },
      },
      required: ['first_name', 'last_name'],
    },
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        sector: { type: 'string' },
        geography: { type: 'string' },
        deal_type: { type: 'string', description: 'platform, add-on, recap, or growth' },
        revenue: { type: 'number' },
        ebitda: { type: 'number' },
        stage: { type: 'string', description: 'Defaults to Teaser' },
        description: { type: 'string' },
        banker_name: { type: 'string' },
        banker_firm: { type: 'string' },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'get_deal_contacts',
    description: 'Get all contacts linked to a specific deal.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and folders in the Evolution Strategy Dropbox. Only call this when the user explicitly asks about files, documents, or folders in Dropbox. Do NOT call proactively.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dropbox folder path. Use "/Ken Nguyen/Evolution Strategy Partners" for the root, or a subfolder like "/Ken Nguyen/Evolution Strategy Partners/Deals/DiPonio Holdings"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a specific file in the Evolution Strategy Dropbox. Only call this when the user explicitly asks to read or summarize a specific file. Always call list_files first to confirm the exact path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full Dropbox file path from list_files' },
      },
      required: ['path'],
    },
  },
]

// Tool execution
async function executeTool(name, input) {
  switch (name) {

    case 'search_deals': {
      let query = supabase.from('deals').select('id, company_name, stage, status, sector, geography, ebitda, revenue, description, source_notes, expected_close')
      if (input.company_name) query = query.ilike('company_name', `%${input.company_name}%`)
      if (input.stage)        query = query.eq('stage', input.stage)
      if (input.sector)       query = query.ilike('sector', `%${input.sector}%`)
      if (input.geography)    query = query.ilike('geography', `%${input.geography}%`)
      if (input.status && input.status !== 'all') query = query.eq('status', input.status)
      if (input.min_ebitda)   query = query.gte('ebitda', input.min_ebitda)
      if (input.max_ebitda)   query = query.lte('ebitda', input.max_ebitda)
      query = query.order('updated_at', { ascending: false }).limit(input.limit || 10)
      const { data, error } = await query
      if (error) return { error: error.message }
      return { deals: data, count: data.length }
    }

    case 'get_deal': {
      const { data: deals } = await supabase.from('deals').select('*').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const deal = deals[0]
      const [{ data: contacts }, { data: interactions }, { data: diligence }] = await Promise.all([
        supabase.from('contact_deal_links').select('role, contact:contacts(first_name, last_name, firm, email, phone, contact_type)').eq('deal_id', deal.id),
        supabase.from('interactions').select('interaction_type, summary, next_steps, interaction_date').eq('deal_id', deal.id).order('interaction_date', { ascending: false }).limit(3),
        supabase.from('diligence_items').select('status').eq('deal_id', deal.id),
      ])
      return { deal, contacts, recent_interactions: interactions, diligence_summary: { total: diligence?.length || 0, complete: diligence?.filter(d => d.status === 'Complete').length || 0 } }
    }

    case 'update_deal': {
      const { data: deals } = await supabase.from('deals').select('id, company_name, status, stage').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const updates = { ...input.updates }

      if (updates.stage) {
        if (updates.stage === 'Closed (Platform)' || updates.stage === 'Closed (Add-On)') {
          updates.status = 'Closed'
        } else if (updates.stage.startsWith('Pass')) {
          updates.status = 'Dead'
        } else if (!updates.status) {
          updates.status = 'Active'
        }
      }

      if (updates.status && !updates.stage) {
        if (updates.status === 'Closed') {
          updates.stage = 'Closed (Platform)'
        } else if (updates.status === 'Dead') {
          updates.stage = deals[0].stage.startsWith('Pass') ? deals[0].stage : 'Pass (Pre-LOI)'
        } else if (updates.status === 'Active') {
          const s = deals[0].stage || ''
          updates.stage = (s.startsWith('Pass') || s.startsWith('Closed')) ? 'Reviewing' : s
        }
      }

      const { error } = await supabase.from('deals').update(updates).eq('id', deals[0].id)
      if (error) return { error: error.message }
      return { success: true, company_name: deals[0].company_name, updated: updates }
    }

    case 'log_interaction': {
      const { data: deals } = await supabase.from('deals').select('id, company_name').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const { error } = await supabase.from('interactions').insert({
        deal_id: deals[0].id,
        interaction_type: input.type || 'note',
        summary: input.summary,
        next_steps: input.next_steps || null,
        interaction_date: new Date().toISOString(),
      })
      if (error) return { error: error.message }
      return { success: true, company_name: deals[0].company_name }
    }

    case 'search_contacts': {
      let query = supabase.from('contacts').select('id, first_name, last_name, firm, title, contact_type, email, phone')
      if (input.query) query = query.or(`first_name.ilike.%${input.query}%,last_name.ilike.%${input.query}%,firm.ilike.%${input.query}%`)
      if (input.contact_type) query = query.eq('contact_type', input.contact_type)
      const { data, error } = await query.limit(input.limit || 10)
      if (error) return { error: error.message }
      return { contacts: data, count: data.length }
    }

    case 'get_pipeline_summary': {
      const { data: deals } = await supabase.from('deals').select('stage, ebitda, status').eq('status', 'Active')
      if (!deals) return { error: 'Could not fetch pipeline' }
      const stages = ['Exclusivity', 'LOI Submitted', 'Pre-LOI', 'Reviewing', 'Teaser', 'Hold']
      const summary = stages.map(stage => {
        const stageDeals = deals.filter(d => d.stage === stage)
        return { stage, count: stageDeals.length, total_ebitda: stageDeals.reduce((s, d) => s + (d.ebitda || 0), 0) }
      }).filter(s => s.count > 0)
      return { pipeline: summary, total_deals: deals.length, total_ebitda: deals.reduce((s, d) => s + (d.ebitda || 0), 0) }
    }

    case 'delete_contact': {
      if (!input.confirmed) return { error: 'Deletion requires explicit user confirmation' }
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, firm')
        .or('first_name.ilike.%' + input.query + '%,last_name.ilike.%' + input.query + '%,firm.ilike.%' + input.query + '%')
        .limit(3)
      if (!contacts?.length) return { error: 'Contact not found' }
      if (contacts.length > 1) return { error: 'Multiple contacts found — be more specific', contacts: contacts.map(c => c.first_name + ' ' + c.last_name + (c.firm ? ' @ ' + c.firm : '')) }
      const c = contacts[0]
      await supabase.from('contact_deal_links').delete().eq('contact_id', c.id)
      await supabase.from('interactions').delete().eq('contact_id', c.id)
      await supabase.from('deal_capital_assignments').delete().eq('contact_id', c.id)
      await supabase.from('contacts').delete().eq('id', c.id)
      return { success: true, deleted: c.first_name + ' ' + c.last_name + (c.firm ? ' @ ' + c.firm : '') }
    }

    case 'update_contact': {
      const q = input.query
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, firm')
        .or('first_name.ilike.%' + q + '%,last_name.ilike.%' + q + '%,firm.ilike.%' + q + '%')
        .limit(3)
      if (!contacts?.length) return { error: 'Contact not found for: ' + q }
      if (contacts.length > 1) return { error: 'Multiple contacts found', contacts: contacts.map(c => c.first_name + ' ' + c.last_name + (c.firm ? ' @ ' + c.firm : '')) }
      const { error } = await supabase.from('contacts').update(input.updates).eq('id', contacts[0].id)
      if (error) return { error: error.message }
      return { success: true, name: contacts[0].first_name + ' ' + contacts[0].last_name, updated: input.updates }
    }

    case 'create_contact': {
      const { data: contact, error } = await supabase.from('contacts').insert({
        first_name: input.first_name,
        last_name: input.last_name,
        firm: input.firm || null,
        title: input.title || null,
        email: input.email || null,
        phone: input.phone || null,
        contact_type: input.contact_type || 'banker',
        sub_type: input.contact_type === 'banker' ? 'M&A banker / intermediary' : null,
      }).select().single()
      if (error) return { error: error.message }
      if (input.deal_id && contact) {
        await supabase.from('contact_deal_links').insert({ contact_id: contact.id, deal_id: input.deal_id, role: 'Source / Banker' })
      }
      return { success: true, contact_id: contact.id, name: contact.first_name + ' ' + contact.last_name, firm: contact.firm }
    }

    case 'create_deal': {
      const { data: deal, error } = await supabase.from('deals').insert({
        company_name: input.company_name,
        sector: input.sector || null,
        geography: input.geography || null,
        deal_type: input.deal_type || 'platform',
        revenue: input.revenue || null,
        ebitda: input.ebitda || null,
        stage: input.stage || 'Teaser',
        status: 'Active',
        description: input.description || null,
        source_notes: input.banker_firm || null,
        expected_close: new Date().toISOString().split('T')[0],
      }).select().single()
      if (error) return { error: error.message }

      let contactLinked = null
      if (input.banker_name) {
        const parts = input.banker_name.split(' ').filter(Boolean)
        const first = parts[0] || ''
        const last = parts[parts.length - 1] || ''
        let { data: contacts } = await supabase.from('contacts')
          .select('id, first_name, last_name, firm')
          .ilike('first_name', '%' + first + '%')
          .ilike('last_name', '%' + last + '%')
          .limit(3)
        if ((!contacts || !contacts.length) && input.banker_firm) {
          const { data: firmContacts } = await supabase.from('contacts')
            .select('id, first_name, last_name, firm')
            .ilike('firm', '%' + input.banker_firm + '%')
            .limit(3)
          contacts = firmContacts
        }
        if (contacts && contacts.length === 1) {
          await supabase.from('contact_deal_links').insert({ contact_id: contacts[0].id, deal_id: deal.id, role: 'Source / Banker' })
          contactLinked = contacts[0].first_name + ' ' + contacts[0].last_name
        }
      }
      return { success: true, deal_id: deal.id, company_name: deal.company_name, stage: deal.stage, contact_linked: contactLinked, contact_not_found: input.banker_name && !contactLinked, banker_name: input.banker_name, banker_firm: input.banker_firm }
    }

    case 'get_deal_contacts': {
      const { data: deals } = await supabase.from('deals').select('id, company_name').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const { data: contacts } = await supabase.from('contact_deal_links').select('role, contact:contacts(first_name, last_name, firm, email, phone, contact_type)').eq('deal_id', deals[0].id)
      return { company_name: deals[0].company_name, contacts }
    }

    case 'list_files': {
      // Normalize path — always ensure we're under the correct root
      let dbxPath = input.path || ''
      // Catch any bad paths and redirect to root
      if (!dbxPath || dbxPath === '/' || dbxPath === '.' || dbxPath === '..' || !dbxPath.startsWith('/')) {
        dbxPath = '/Ken Nguyen/Evolution Strategy Partners'
      }
      // Catch relative traversal attempts
      if (dbxPath.includes('..')) {
        dbxPath = '/Ken Nguyen/Evolution Strategy Partners'
      }
      const res = await dbx.filesListFolder({ path: dbxPath, recursive: false })
      const items = res.result.entries.map(e => ({
        name: e.name,
        path: e.path_lower,
        type: e['.tag'],
        size: e.size,
      }))
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { folder: dbxPath, items }
    }

    case 'read_file': {
      const fileExt = input.path.slice(input.path.lastIndexOf('.')).toLowerCase()
      const READABLE = new Set(['.pdf', '.txt', '.md', '.csv', '.docx', '.xlsx', '.xls'])
      if (!READABLE.has(fileExt)) return { error: `Cannot read file type: ${fileExt}` }

      const res = await dbx.filesDownload({ path: input.path })
      const buffer = res.result.fileBinary
      const base64 = buffer.toString('base64')
      const fileName = input.path.split('/').pop()

      if (['.txt', '.md', '.csv'].includes(fileExt)) {
        return { file: fileName, content: buffer.toString('utf-8').slice(0, 20000) }
      }

      let fileContent
      if (fileExt === '.pdf') {
        fileContent = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      } else if (['.xlsx', '.xls'].includes(fileExt)) {
        fileContent = { type: 'document', source: { type: 'base64', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: base64 } }
      } else if (fileExt === '.docx') {
        fileContent = { type: 'document', source: { type: 'base64', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: base64 } }
      }

      const extractResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            fileContent,
            { type: 'text', text: `Extract and summarize the full content of this file "${fileName}". Include all key facts, figures, dates, parties, and terms. Be comprehensive.` },
          ],
        }],
      })
      const content = extractResp.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      return { file: fileName, content }
    }

    default:
      return { error: 'Unknown tool: ' + name }
  }
}

// Trim tool results in history to avoid bloating token count
function trimHistory(history) {
  return history.map(msg => {
    if (!Array.isArray(msg.content)) return msg
    return {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === 'tool_result') {
          try {
            const parsed = JSON.parse(block.content)
            // Truncate large arrays to 5 items
            if (parsed.deals && parsed.deals.length > 5) parsed.deals = parsed.deals.slice(0, 5)
            if (parsed.contacts && parsed.contacts.length > 5) parsed.contacts = parsed.contacts.slice(0, 5)
            return { ...block, content: JSON.stringify(parsed) }
          } catch { return block }
        }
        return block
      })
    }
  })
}

// Conversation memory per channel (last 10 messages only)
const conversations = new Map()

async function handleAgentMessage(message) {
  // Rate limit check
  if (isRateLimited(message.author.id)) {
    await message.reply('⏳ One moment — please wait a few seconds before sending another message.')
    return
  }
  setRateLimit(message.author.id)

  const channelId = message.channel.id
  if (!conversations.has(channelId)) conversations.set(channelId, [])
  const history = conversations.get(channelId)

  history.push({ role: 'user', content: message.content })

  // Keep last 10 messages (down from 20) to reduce token usage
  if (history.length > 10) history.splice(0, history.length - 10)

  await message.channel.sendTyping()

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: `You are the Evolution CRM assistant for Evolution Strategy Partners, an independent sponsor PE firm focused on infrastructure and industrial services. You have direct access to the deal CRM.

Be concise — this is Discord. Use bullet points and short sentences. Format numbers cleanly ($4.2M). Confirm actions when done.

When creating a deal and banker not found (contact_not_found: true), ask for banker details in one message.

Capital raises are tracked separately. To log a capital raise update, just describe it naturally in any channel — e.g. "Sinclair sent a term sheet on Coggins" or "BMO passed, geographic concentration". The bot will parse and confirm before saving. You can tell users this when they ask about capital raises.

DROPBOX: The Evolution Strategy Dropbox root path is "/Ken Nguyen/Evolution Strategy Partners". Subfolders: Auditors, Bankers, Best Practices, Claude, Compliance, Consultants, Dealflow, Deals, Evolution Investments, Industry Data, Investors, Lenders, Marketing, Office, Portfolio Co's. Deal files are under "/Ken Nguyen/Evolution Strategy Partners/Deals/[Company Name]". Portfolio company files are under "/Ken Nguyen/Evolution Strategy Partners/Portfolio Co's/[Company Name]". Always start from these known paths — never guess.

Today: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
      tools,
      messages: trimHistory(history),
    })

    // Process tool calls
    let currentResponse = response
    let iterations = 0
    const MAX_ITERATIONS = 3 // prevent runaway loops

    while (currentResponse.stop_reason === 'tool_use' && iterations < MAX_ITERATIONS) {
      iterations++
      const toolUses = currentResponse.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, toolUse.input)
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) })
      }

      history.push({ role: 'assistant', content: currentResponse.content })
      history.push({ role: 'user', content: toolResults })

      currentResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        system: `You are the Evolution CRM assistant. Be concise — this is Discord. Today: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
        tools,
        messages: trimHistory(history),
      })
    }

    const finalText = currentResponse.content.filter(b => b.type === 'text').map(b => b.text).join('')
    history.push({ role: 'assistant', content: currentResponse.content })

    if (finalText.length <= 2000) {
      await message.reply(finalText)
    } else {
      const chunks = finalText.match(/[\s\S]{1,1900}/g) || []
      for (const chunk of chunks) await message.channel.send(chunk)
    }

  } catch (err) {
    console.error('Agent error:', err)
    await message.reply('❌ Error: ' + err.message)
  }
}

module.exports = { handleAgentMessage }
