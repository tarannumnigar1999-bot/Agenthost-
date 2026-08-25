// api/widget-chat.js
// Public-facing chat endpoint for the embeddable widget.
// No user login required — anyone on the client's website can talk to this,
// so we look up the agent by ID and enforce the agent OWNER's plan limits.

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PLAN_LIMITS = { free: 500, starter: 1000, pro: 6000, agency: 12000 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { agent_id, message, history } = await req.json();
    if (!agent_id || !message) return json({ error: 'Missing agent_id or message' }, 400);

    // 1. Fetch the agent using the service role key (visitor has no auth token)
    const agentRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agent_id}&select=*`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const agents = await agentRes.json();
    const agent = agents?.[0];
    if (!agent) return json({ error: 'Agent not found' }, 404);
    if (!agent.is_live) return json({ reply: "Sorry, this assistant isn't available right now." });

    // 2. Look up the agent owner's plan, then check this month's usage against it
    const ownerRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${agent.user_id}&select=plan`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const owners = await ownerRes.json();
    const plan = owners?.[0]?.plan || 'free';
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const usageRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${agent.user_id}&role=eq.assistant&created_at=gte.${monthStart.toISOString()}&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const usageRows = await usageRes.json();
    if ((usageRows?.length || 0) >= limit) {
      return json({ reply: "Sorry, this assistant has reached its message limit for this month. Please contact the business directly." });
    }

    // 3. Build the message list and call Anthropic
    const messages = [
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message },
    ];

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: agent.model || 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: agent.system_prompt || 'You are a helpful assistant.',
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error (widget):', err);
      return json({ error: 'AI provider error. Please try again.' }, 502);
    }

    const aiData = await anthropicRes.json();
    const reply = aiData.content?.[0]?.text || '';

    // 4. Log usage — fire and forget, matches the dashboard's own logging shape
    logExchange(agent.user_id, agent_id, message, reply).catch(e => console.error('Widget log error:', e));

    return json({ reply });
  } catch (err) {
    console.error('widget-chat error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}

async function logExchange(userId, agentId, userMsg, aiReply) {
  const now = new Date().toISOString();
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/usage_logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify([
      { user_id: userId, agent_id: agentId, role: 'user', content: userMsg, created_at: now },
      { user_id: userId, agent_id: agentId, role: 'assistant', content: aiReply, created_at: now },
    ]),
  });
}

