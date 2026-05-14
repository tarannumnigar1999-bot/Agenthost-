// api/chat.js
// Vercel Edge Function — AgentHost API Proxy
// Sits between your users and Anthropic. Hides your API key, tracks usage, enforces plan limits.

export const config = { runtime: 'edge' };

// ─── Plan limits (messages per month) ───────────────────────────────────────
const PLAN_LIMITS = {
  free:   500,
  pro:    10000,
  agency: 100000,
};

// ─── CORS headers ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req) {

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // 1. Parse request body
    const body = await req.json();
    const { agent_id, message, session_id, user_token } = body;

    if (!agent_id || !message) {
      return json({ error: 'agent_id and message are required' }, 400);
    }

    // 2. Verify user token + get plan from Supabase
    const user = await verifyUser(user_token);
    if (!user) {
      return json({ error: 'Unauthorized. Please log in.' }, 401);
    }

    // 3. Check usage limit
    const usage = await getMonthlyUsage(user.id);
    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
    if (usage >= limit) {
      return json({
        error: `Monthly limit reached (${limit} messages). Please upgrade your plan.`,
        upgrade_url: 'https://agenthost.io/pricing'
      }, 429);
    }

    // 4. Fetch agent config from Supabase
    const agent = await getAgent(agent_id, user.id);
    if (!agent) {
      return json({ error: 'Agent not found or access denied' }, 404);
    }

    // 5. Call Anthropic API (your key, hidden server-side)
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,  // ← stored in Vercel env vars
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      agent.model || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system:     agent.system_prompt,
        messages:   [{ role: 'user', content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      return json({ error: 'AI provider error', detail: err }, 502);
    }

    const aiData = await anthropicRes.json();
    const reply  = aiData.content?.[0]?.text || '';

    // 6. Log usage to Supabase (async, non-blocking)
    logUsage(user.id, agent_id, session_id, message, reply).catch(console.error);

    // 7. Return response
    return json({
      reply,
      agent_id,
      session_id,
      model:        agent.model,
      usage_after:  usage + 1,
      limit,
    });

  } catch (err) {
    console.error('AgentHost proxy error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function verifyUser(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    // Fetch plan from your users table
    const planRes = await supabaseQuery(
      `users?id=eq.${user.id}&select=id,plan,email`,
      token
    );
    const planData = await planRes.json();
    return planData?.[0] ? { ...user, plan: planData[0].plan || 'free' } : { ...user, plan: 'free' };
  } catch {
    return null;
  }
}

async function getAgent(agentId, userId) {
  try {
    const res = await supabaseQuery(
      `agents?id=eq.${agentId}&user_id=eq.${userId}&select=*`,
      process.env.SUPABASE_SERVICE_KEY
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch {
    return null;
  }
}

async function getMonthlyUsage(userId) {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const res = await supabaseQuery(
      `usage_logs?user_id=eq.${userId}&created_at=gte.${startOfMonth.toISOString()}&select=id`,
      process.env.SUPABASE_SERVICE_KEY
    );
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

async function logUsage(userId, agentId, sessionId, userMsg, aiReply) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/usage_logs`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      user_id:    userId,
      agent_id:   agentId,
      session_id: sessionId,
      user_msg:   userMsg.slice(0, 1000),  // truncate for storage
      ai_reply:   aiReply.slice(0, 2000),
      created_at: new Date().toISOString(),
    }),
  });
}

function supabaseQuery(path, key) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

