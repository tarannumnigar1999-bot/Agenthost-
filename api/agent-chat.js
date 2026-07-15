// api/agent-chat.js
// Vercel Edge Function — powers the dashboard's Live Test chat.
// Matches agenthost-dashboard-1.html's actual request format:
//   POST /api/agent-chat
//   Headers: Authorization: Bearer <supabase_access_token>
//   Body: { agent_id, message, history }
// Response: { reply } on success, { error } on failure.

export const config = { runtime: 'edge' };

const PLAN_LIMITS = {
  free:    500,
  starter: 1000,
  pro:     6000,
  agency:  12000,
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // 1. Auth — token comes from the Authorization header, not the body
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized. Please log in.' }, 401);

    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) return json({ error: 'Invalid or expired session. Please log in again.' }, 401);
    const authUser = await userRes.json();

    // 2. Get plan from users table
    const planRes = await supabaseQuery(`users?id=eq.${authUser.id}&select=plan`, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const planData = await planRes.json();
    const plan = planData?.[0]?.plan || 'free';

    // 3. Parse body
    const body = await req.json();
    const { agent_id, message, history } = body;
    if (!agent_id || !message) {
      return json({ error: 'agent_id and message are required' }, 400);
    }

    // 4. Check usage limit (count 'assistant' rows this month, matching dashboard's own query)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const usageRes = await supabaseQuery(
      `usage_logs?user_id=eq.${authUser.id}&role=eq.assistant&created_at=gte.${monthStart.toISOString()}&select=id`,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const usageData = await usageRes.json();
    const usageCount = Array.isArray(usageData) ? usageData.length : 0;
    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    if (usageCount >= limit) {
      return json({ error: `Monthly limit reached (${limit} messages). Please upgrade your plan.` }, 429);
    }

    // 5. Fetch the agent (must belong to this user) — filtered in the query itself
    const agentRes = await supabaseQuery(
      `agents?id=eq.${agent_id}&user_id=eq.${authUser.id}&select=*`,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const agentData = await agentRes.json();
    const agent = agentData?.[0];
    if (!agent) return json({ error: 'Agent not found or access denied' }, 404);

    // 6. Build message list (prior history + new message)
    const messages = [
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message },
    ];

    // 7. Call Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      agent.model || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system:     agent.system_prompt || 'You are a helpful assistant.',
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', err);
      return json({ error: 'AI provider error. Please try again.' }, 502);
    }

    const aiData = await anthropicRes.json();
    const reply  = aiData.content?.[0]?.text || '';

    // 8. Log usage — TWO rows, matching what the dashboard's Analytics/Overview pages read
    logExchange(authUser.id, agent_id, message, reply).catch(e => console.error('Log error:', e));

    // 9. Mark this account as active (resets the 30-day inactivity clock)
    bumpLastActive(authUser.id).catch(e => console.error('Activity bump error:', e));

    // 10. Response — matches what sendMessage() in the dashboard expects
    return json({ reply });

  } catch (err) {
    console.error('agent-chat error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}

async function logExchange(userId, agentId, userMsg, aiReply) {
  const now = new Date().toISOString();
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/usage_logs`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify([
      { user_id: userId, agent_id: agentId, role: 'user',      content: userMsg.slice(0, 2000), created_at: now },
      { user_id: userId, agent_id: agentId, role: 'assistant', content: aiReply.slice(0, 2000), created_at: now },
    ]),
  });
}

async function bumpLastActive(userId) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ last_active_at: new Date().toISOString() }),
  });
}

function supabaseQuery(path, key) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
