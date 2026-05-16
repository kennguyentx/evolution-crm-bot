// Evolution CRM Agent — conversational interface powered by Claude
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

function fmt(n) {
  if (!n) return '—'
  if (n >= 1e9) return '$' + (n/1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K'
  return '$' + n
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
    name: 'create_contact',
    description: 'Create a new contact in the CRM. Use when a banker or other contact is not found in the database and the user provides their details.',
    input_schema: {
      type: 'object',
      properties: {
        first_name:   { type: 'string' },
        last_name:    { type: 'string' },
        firm:         { type: 'string' },
        title:        { type: 'string' },
        email:        { type: 'string' },
        phone:        { type: 'string' },
        contact_type: { type: 'string', description: 'banker, lp, lender, advisor, management, other' },
        deal_id:      { type: 'string', description: 'If provided, link this contact to a deal as Source / Banker' },
      },
      required: ['first_name', 'last_name'],
    },
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in the CRM. Use when someone describes a new company or opportunity to add to the pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        company_name:  { type: 'string', description: 'Company name' },
        sector:        { type: 'string', description: 'Sector' },
        geography:     { type: 'string', description: 'State or region' },
        deal_type:     { type: 'string', description: 'platform, add-on, recap, or growth' },
        revenue:       { type: 'number', description: 'Annual revenue in dollars' },
        ebitda:        { type: 'number', description: 'Annual EBITDA in dollars' },
        stage:         { type: 'string', description: 'Stage — defaults to Teaser' },
        description:   { type: 'string', description: 'Brief description of the business' },
        banker_name:   { type: 'string', description: 'Full name of the source banker or contact' },
        banker_firm:   { type: 'string', description: 'Firm name of the source banker' },
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
        supabase.from('interactions').select('*').eq('deal_id', deal.id).order('interaction_date', { ascending: false }).limit(5),
        supabase.from('diligence_items').select('*').eq('deal_id', deal.id),
      ])
      return { deal, contacts, recent_interactions: interactions, diligence_summary: { total: diligence?.length || 0, complete: diligence?.filter(d => d.status === 'Complete').length || 0 } }
    }

    case 'update_deal': {
      const { data: deals } = await supabase.from('deals').select('id, company_name').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const { error } = await supabase.from('deals').update(input.updates).eq('id', deals[0].id)
      if (error) return { error: error.message }
      return { success: true, company_name: deals[0].company_name, updated: input.updates }
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

    case 'create_contact': {
      const { data: contact, error } = await supabase.from('contacts').insert({
        first_name:   input.first_name,
        last_name:    input.last_name,
        firm:         input.firm || null,
        title:        input.title || null,
        email:        input.email || null,
        phone:        input.phone || null,
        contact_type: input.contact_type || 'banker',
        sub_type:     input.contact_type === 'banker' ? 'M&A banker / intermediary' : null,
      }).select().single()
      if (error) return { error: error.message }
      if (input.deal_id && contact) {
        await supabase.from('contact_deal_links').insert({ contact_id: contact.id, deal_id: input.deal_id, role: 'Source / Banker' })
      }
      return { success: true, contact_id: contact.id, name: contact.first_name + ' ' + contact.last_name, firm: contact.firm }
    }

    case 'create_deal': {
      // Insert deal
      const { data: deal, error } = await supabase.from('deals').insert({
        company_name:   input.company_name,
        sector:         input.sector || null,
        geography:      input.geography || null,
        deal_type:      input.deal_type || 'platform',
        revenue:        input.revenue || null,
        ebitda:         input.ebitda || null,
        stage:          input.stage || 'Teaser',
        status:         'Active',
        description:    input.description || null,
        source_notes:   input.banker_firm || null,
        expected_close: new Date().toISOString().split('T')[0],
      }).select().single()
      if (error) return { error: error.message }

      // Try to link banker by name + firm
      let contactLinked = null
      if (input.banker_name) {
        const parts = input.banker_name.split(' ').filter(Boolean)
        const first = parts[0] || ''
        const last = parts[parts.length-1] || ''
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
      const contactNotFound = input.banker_name && !contactLinked
      return { success: true, deal_id: deal.id, company_name: deal.company_name, stage: deal.stage, contact_linked: contactLinked, contact_not_found: contactNotFound, banker_name: input.banker_name, banker_firm: input.banker_firm }
    }

    case 'get_deal_contacts': {
      const { data: deals } = await supabase.from('deals').select('id, company_name').ilike('company_name', `%${input.company_name}%`).limit(1)
      if (!deals?.length) return { error: 'Deal not found' }
      const { data: contacts } = await supabase.from('contact_deal_links').select('role, contact:contacts(first_name, last_name, firm, email, phone, contact_type)').eq('deal_id', deals[0].id)
      return { company_name: deals[0].company_name, contacts }
    }

    default:
      return { error: 'Unknown tool: ' + name }
  }
}

// Conversation memory per channel
const conversations = new Map()

async function handleAgentMessage(message) {
  const channelId = message.channel.id
  if (!conversations.has(channelId)) conversations.set(channelId, [])
  const history = conversations.get(channelId)

  // Add user message
  history.push({ role: 'user', content: message.content })

  // Keep last 20 messages
  if (history.length > 20) history.splice(0, history.length - 20)

  await message.channel.sendTyping()

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are the Evolution CRM assistant for Evolution Strategy Partners, an independent sponsor private equity firm focused on infrastructure and industrial services (underground utilities, electrical contracting, civil/public works, commercial landscaping, fiber optics).

You have direct access to the firm's deal CRM. You can search deals, view deal details, update stages, log interactions, search contacts, and summarize the pipeline.

Be concise and direct — this is Discord, not email. Use bullet points and short sentences. Format numbers cleanly ($4.2M not $4,200,000). When updating or logging something, confirm what you did.

When creating a deal and the banker is not in the DB (contact_not_found: true), always follow up by asking the user for the banker's details (first name, last name, firm, email, phone) so you can create and link them. Ask for all fields in one message.

Today's date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
      tools,
      messages: history,
    })

    // Process tool calls
    let finalText = ''
    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, toolUse.input)
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) })
      }

      // Add assistant response and tool results to history
      history.push({ role: 'assistant', content: response.content })
      history.push({ role: 'user', content: toolResults })

      // Get next response
      const nextResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: `You are the Evolution CRM assistant for Evolution Strategy Partners. Be concise and direct — this is Discord. Format numbers cleanly. Today: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
        tools,
        messages: history,
      })

      if (nextResponse.stop_reason !== 'tool_use') {
        finalText = nextResponse.content.filter(b => b.type === 'text').map(b => b.text).join('')
        history.push({ role: 'assistant', content: nextResponse.content })
        break
      }
      // Loop if more tool calls
      Object.assign(response, nextResponse)
    }

    if (!finalText) {
      finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('')
      history.push({ role: 'assistant', content: response.content })
    }

    // Send response (split if over 2000 chars)
    if (finalText.length <= 2000) {
      await message.reply(finalText)
    } else {
      const chunks = finalText.match(/[\s\S]{1,1900}/g) || []
      for (const chunk of chunks) {
        await message.channel.send(chunk)
      }
    }

  } catch (err) {
    console.error('Agent error:', err)
    await message.reply('❌ Error: ' + err.message)
  }
}

module.exports = { handleAgentMessage }
